import { Router, type Request, type Response } from 'express';
import type { LineupEntry, TeamRole } from '@playflow/game-engine';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';

import { pool } from './db';
import {
  stateStore,
  toSetBaseCommand,
  type GameBasesWithPitcherResponsibility,
  type PitcherStats,
  type RunnerOnBaseWithPitcher,
} from './stateStore';
import { optionalAuth, type AuthenticatedRequest } from './auth/authMiddleware';
import { canScore } from './scoring/scoringAssignmentService';

type AtBatResult =
  | 'single'
  | 'double'
  | 'triple'
  | 'home_run'
  | 'walk'
  | 'hbp'
  | 'error'
  | 'strikeout'
  | 'field_out'       // MLBAM vocab — reemplaza groundout/flyout; contact_type distingue
  | 'groundout'       // legacy alias — se normaliza a field_out en el parser
  | 'flyout'          // legacy alias — se normaliza a field_out en el parser
  | 'sacrifice_fly'
  | 'sacrifice_bunt'
  | 'fielders_choice'
  | 'double_play';

interface AtBatRequest {
  gameId: string;
  batterPlayerId: string;
  pitcherPlayerId?: string;
  result: AtBatResult;
  rbi?: number;
  runs?: number;
  onBase?: boolean;
  pitchCount?: number;
  notes?: string;
  contactType?: ContactType;
  hitDirection?: HitDirection;
  /** MLBAM hitData estructurado — persiste en hit_data JSON */
  hitData?: {
    type?: ContactType;
    direction?: HitDirection;
    hardness?: HitQuality;
  };
  runnersJson?: string;
  /** Timecode del stream de transmisión, ej. "1:23:45.500" */
  videoTimestamp?: string;
  /** MLBAM: carreras limpias del turno (para ERA) */
  earnedRuns?: number;
  /** MLBAM: carreras sucias del turno */
  unearnedRuns?: number;
  /** Tipo de sustitución si el bateador es emergente */
  substitutionType?: 'pinch_hitter' | 'pinch_runner';
  /** Pitch decisivo (in_play): datos del lanzamiento que resultó en contacto */
  decisivePitch?: {
    pitchType?: string;
    col?: number;
    row?: number;
    zone?: number;
    velocityKmh?: number;
    plateX?: number;
    plateZ?: number;
  };
}

type ContactType = 'line_drive' | 'fly_ball' | 'ground_ball' | 'bunt_grounder' | 'popup';
type HitDirection = 'LF' | 'LCF' | 'CF' | 'RCF' | 'RF' | '3B' | 'SS' | '2B' | '1B' | 'P' | 'C';
/** MLBAM hitData.hardness */
type HitQuality = 'soft' | 'medium' | 'hard';
type PitchCall = 'ball' | 'called_strike' | 'swinging_strike' | 'foul' | 'in_play' | 'hit_by_pitch' | 'wild_pitch' | 'passed_ball';

// Map pitch result to umpire_call stored value
function toUmpireCall(type: PitchCall): string {
  if (type === 'called_strike' || type === 'swinging_strike' || type === 'in_play') return 'strike';
  if (type === 'hit_by_pitch') return 'hbp';
  if (type === 'wild_pitch') return 'wild_pitch';
  if (type === 'passed_ball') return 'passed_ball';
  return type; // 'ball', 'foul'
}

interface PitchRequest {
  type: PitchCall;
  col?: number;
  row?: number;
  pitchType?: string;
  velocityKmh?: number;
  umpireId?: string;
  videoTimestamp?: string;
  note?: string;
  catcherTargetMode?: string;
  catcherTargetCol?: number;
  catcherTargetRow?: number;
  // Campos estándar métricos (spec 29)
  plate_x?: number;
  plate_z?: number;
  zone?: number;
  start_speed?: number;
  pfx_x?: number;
  pfx_z?: number;
  spin_rate?: number;
  spin_axis?: number;
  pitch_class?: string;
  confidence?: number;
  device_id?: string;
}

type SubstitutionType = 'pitching_change' | 'pinch_hitter' | 'pinch_runner' | 'defensive_change' | 'double_switch';
type BaseName = 'first' | 'second' | 'third';

interface SubstitutionRequest {
  gameId: string;
  substitutionType: SubstitutionType;
  incomingPlayerId: string;
  outgoingPlayerId: string;
  position?: string;
  base?: BaseName;
  battingOrder?: number;
  notes?: string;
}

interface ApiSuccessResponse {
  status: number;
  result: 'ok';
  payload: unknown;
}

interface ApiErrorResponse {
  status: number;
  result: 'error';
  payload: {
    message: string;
  };
}

interface AtBatColumnRow extends RowDataPacket {
  Field: string;
}

interface PitchColumnRow extends RowDataPacket {
  Field: string;
}

interface GameLineupRow extends RowDataPacket {
  id: string;
}

interface CountRow extends RowDataPacket {
  total: number;
}

interface PlayerMetaRow extends RowDataPacket {
  id: string;
  bats: string | null;
  throws: string | null;
}

interface PlayerInfoRow extends RowDataPacket {
  id: string;
  name: string;
  number: string;
  position: string;
  photo_asset_id: string | null;
  team_id: string | null;
}

interface ActiveGameLineupRow extends RowDataPacket {
  id: string;
  team_id: string;
  batting_order: number;
  position: string;
  defensive_position: string | null;
  is_starter: 0 | 1;
  is_dp: 0 | 1;
  is_flex: 0 | 1;
  re_entry_used: 0 | 1;
  courtesy_running_for_roster_id: string | null;
}

const AT_BAT_RESULTS = [
  'single',
  'double',
  'triple',
  'home_run',
  'walk',
  'hbp',
  'error',
  'strikeout',
  'field_out',        // MLBAM canonical
  'groundout',        // legacy alias
  'flyout',           // legacy alias
  'sacrifice_fly',
  'sacrifice_bunt',
  'fielders_choice',
  'double_play',
] as const satisfies readonly AtBatResult[];

const ON_BASE_RESULTS = new Set<AtBatResult>(['single', 'double', 'triple', 'home_run', 'walk', 'hbp', 'error', 'fielders_choice']);
const OUT_RESULTS = new Set<AtBatResult>([
  'strikeout',
  'field_out',
  'groundout',        // legacy
  'flyout',           // legacy
  'sacrifice_fly',
  'sacrifice_bunt',
  // fielders_choice: el bateador llega a base (el out es de otro corredor)
  'double_play',
]);

// Resultados que aplican avance forzado de corredores (walk / HBP)
const WALK_RESULTS = new Set<AtBatResult>(['walk', 'hbp']);
const CONTACT_TYPES = new Set<ContactType>(['line_drive', 'fly_ball', 'ground_ball', 'bunt_grounder', 'popup']);
const HIT_DIRECTIONS = new Set<HitDirection>(['LF', 'LCF', 'CF', 'RCF', 'RF', '3B', 'SS', '2B', '1B', 'P', 'C']);
const HIT_QUALITIES = new Set<HitQuality>(['soft', 'medium', 'hard']);
const SUBSTITUTION_TYPES = new Set<SubstitutionType>([
  'pitching_change',
  'pinch_hitter',
  'pinch_runner',
  'defensive_change',
  'double_switch',
]);
const pendingPinchHitters = new Map<string, { batterPlayerId: string; substitutionType: 'pinch_hitter' }>();

interface RunnerAdvancement {
  newBases: GameBasesWithPitcherResponsibility;
  runsScored: number;
}

/**
 * Walk/HBP: el bateador toma 1ª. Los corredores avanzan solo si son forzados
 * por el nuevo ocupante de 1ª (efecto dominó hasta home si bases llenas).
 * batterRunner: corredor placeholder para el bateador.
 */
function advanceRunnersForced(
  before: GameBasesWithPitcherResponsibility,
  batterRunner: RunnerOnBaseWithPitcher,
): RunnerAdvancement {
  let third = before.third;
  let second = before.second;
  let runsScored = 0;

  if (before.first !== null) {
    if (before.second !== null) {
      if (before.third !== null) {
        runsScored = 1; // corredor de 3ª forzado a home
        third = before.second; // corredor de 2ª lo reemplaza en 3ª
      } else {
        third = before.second; // corredor de 2ª forzado a 3ª
      }
      second = before.first; // corredor de 1ª forzado a 2ª
    } else {
      second = before.first; // corredor de 1ª forzado a 2ª
      // third no cambia
    }
  }

  return { newBases: { first: batterRunner, second, third }, runsScored };
}

/**
 * Single/double/triple: cada corredor avanza exactamente n bases.
 * Si llega a home (posición >= 4), anota.
 * NOTA: la posición final del bateador NO se incluye en newBases — se aplica por separado.
 */
function advanceRunnersNBases(before: GameBasesWithPitcherResponsibility, n: 1 | 2 | 3): RunnerAdvancement {
  let runsScored = 0;
  const newBases: GameBasesWithPitcherResponsibility = { first: null, second: null, third: null };

  if (before.third !== null) {
    // 3 + n >= 4 para cualquier n >= 1 → siempre anota
    runsScored += 1;
  }

  if (before.second !== null) {
    const pos = 2 + n;
    if (pos >= 4) {
      runsScored += 1; // double o triple: 2ª anota
    } else {
      newBases.third = before.second; // single: 2ª → 3ª
    }
  }

  if (before.first !== null) {
    const pos = 1 + n;
    if (pos >= 4) {
      runsScored += 1; // triple: 1ª anota
    } else if (pos === 3) {
      newBases.third = before.first; // double: 1ª → 3ª (si 2ª ya asignó 3ª, 1ª ganó más avance y sobrescribe)
    } else {
      newBases.second = before.first; // single: 1ª → 2ª
    }
  }

  return { newBases, runsScored };
}

let atBatColumnsPromise: Promise<Set<string>> | null = null;
let pitchColumnsPromise: Promise<Set<string>> | null = null;

function sendSuccess(response: Response, payload: unknown, status = 200): void {
  const body: ApiSuccessResponse = {
    status,
    result: 'ok',
    payload,
  };

  response.status(status).json(body);
}

function sendError(response: Response, status: number, error: unknown): void {
  const body: ApiErrorResponse = {
    status,
    result: 'error',
    payload: {
      message: error instanceof Error ? error.message : 'Unknown error',
    },
  };

  response.status(status).json(body);
}

function requirePool(response: Response) {
  if (!pool) {
    sendError(response, 503, new Error('DATABASE_URL no está configurado; scorer API no disponible'));
    return null;
  }

  return pool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer when provided`);
  }

  return value;
}

function parseOptionalFloat(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative number when provided`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${fieldName} must be a non-negative number when provided`);
    }
    return parsed;
  }

  throw new Error(`${fieldName} must be a non-negative number when provided`);
}

/** Como parseOptionalFloat pero admite valores negativos (coordenadas métricas plate_x/plate_z, pfx_x/pfx_z) */
function parseOptionalSignedFloat(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName} must be a finite number when provided`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName} must be a finite number when provided`);
    }
    return parsed;
  }
  throw new Error(`${fieldName} must be a number when provided`);
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean when provided`);
  }

  return value;
}

function parseOptionalGridCoordinate(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error(`${fieldName} must be an integer between 0 and 6 when provided`);
  }

  return value;
}

/**
 * Para enteros no negativos sin límite superior (spin_rate RPM ~1000-3500, spin_axis grados 0-360).
 * No confundir con parseOptionalGridCoordinate que limita a 0-6.
 */
function parseOptionalNonNegativeInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer when provided`);
  }

  return value;
}

function parseAtBatResult(value: unknown): AtBatResult {
  if (typeof value !== 'string' || !AT_BAT_RESULTS.includes(value as AtBatResult)) {
    throw new Error('result must be a valid at-bat result');
  }

  // Normalizar aliases legacy al vocabulario MLBAM canónico
  if (value === 'groundout' || value === 'flyout') {
    return 'field_out';
  }

  return value as AtBatResult;
}

function parseOptionalContactType(value: unknown): ContactType | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !CONTACT_TYPES.has(value as ContactType)) {
    throw new Error('contactType must be a valid contact type');
  }

  return value as ContactType;
}

function parseOptionalHitDirection(value: unknown): HitDirection | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !HIT_DIRECTIONS.has(value as HitDirection)) {
    throw new Error('hitDirection must be a valid field direction');
  }

  return value as HitDirection;
}

function parseOptionalHitQuality(value: unknown): HitQuality | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !HIT_QUALITIES.has(value as HitQuality)) {
    throw new Error('hitQuality must be one of: soft, medium, hard');
  }

  return value as HitQuality;
}

function parseAtBatRequest(body: unknown): AtBatRequest {
  if (!isRecord(body)) {
    throw new Error('Request body must be a JSON object');
  }

  return {
    gameId: parseRequiredString(body.gameId, 'gameId'),
    batterPlayerId: parseRequiredString(body.batterPlayerId, 'batterPlayerId'),
    pitcherPlayerId: parseOptionalString(body.pitcherPlayerId, 'pitcherPlayerId'),
    result: parseAtBatResult(body.result),
    rbi: parseOptionalInteger(body.rbi, 'rbi'),
    runs: parseOptionalInteger(body.runs, 'runs'),
    onBase: parseOptionalBoolean(body.onBase, 'onBase'),
    pitchCount: parseOptionalInteger(body.pitchCount, 'pitchCount'),
    notes: parseOptionalString(body.notes, 'notes'),
    contactType: parseOptionalContactType(body.contactType),
    hitDirection: parseOptionalHitDirection(body.hitDirection),
    hitData: isRecord(body.hitData) ? {
      type: body.hitData.type !== undefined ? parseOptionalContactType(body.hitData.type) : undefined,
      direction: body.hitData.direction !== undefined ? parseOptionalHitDirection(body.hitData.direction) : undefined,
      hardness: body.hitData.hardness !== undefined ? parseOptionalHitQuality(body.hitData.hardness) : undefined,
    } : undefined,
    runnersJson: parseOptionalString(body.runnersJson, 'runnersJson'),
    videoTimestamp: parseOptionalString(body.videoTimestamp, 'videoTimestamp'),
    earnedRuns: parseOptionalInteger(body.earnedRuns, 'earnedRuns'),
    unearnedRuns: parseOptionalInteger(body.unearnedRuns, 'unearnedRuns'),
    substitutionType: (() => {
      const st = body.substitutionType;
      if (st === undefined || st === null || st === '') return undefined;
      if (st !== 'pinch_hitter' && st !== 'pinch_runner') {
        throw new Error('substitutionType must be pinch_hitter or pinch_runner when provided');
      }
      return st;
    })(),
    decisivePitch: isRecord(body.decisivePitch) ? {
      pitchType:  parseOptionalString(body.decisivePitch.pitchType, 'decisivePitch.pitchType'),
      col:        parseOptionalGridCoordinate(body.decisivePitch.col, 'decisivePitch.col'),
      row:        parseOptionalGridCoordinate(body.decisivePitch.row, 'decisivePitch.row'),
      zone:       typeof body.decisivePitch.zone === 'number' ? body.decisivePitch.zone : undefined,
      velocityKmh: parseOptionalFloat(body.decisivePitch.velocityKmh, 'decisivePitch.velocityKmh'),
      plateX:     parseOptionalSignedFloat(body.decisivePitch.plateX, 'decisivePitch.plateX'),
      plateZ:     parseOptionalSignedFloat(body.decisivePitch.plateZ, 'decisivePitch.plateZ'),
    } : undefined,
  };
}

function parsePitchRequest(body: unknown): PitchRequest {
  if (!isRecord(body)) {
    throw new Error('Request body must be a JSON object');
  }

  const { type } = body;
  const validTypes: PitchCall[] = ['ball', 'called_strike', 'swinging_strike', 'foul', 'in_play', 'hit_by_pitch', 'wild_pitch', 'passed_ball'];
  if (!validTypes.includes(type as PitchCall)) {
    throw new Error('type debe ser uno de: ball, called_strike, swinging_strike, foul, in_play, hit_by_pitch, wild_pitch, passed_ball');
  }

  return {
    type: type as PitchCall,
    col: parseOptionalGridCoordinate(body.col, 'col'),
    row: parseOptionalGridCoordinate(body.row, 'row'),
    pitchType: parseOptionalString(body.pitchType, 'pitchType'),
    velocityKmh: parseOptionalFloat(body.velocityKmh, 'velocityKmh'),
    umpireId: parseOptionalString(body.umpireId, 'umpireId'),
    videoTimestamp: parseOptionalString(body.videoTimestamp, 'videoTimestamp'),
    note: parseOptionalString(body.note, 'note'),
    catcherTargetMode: parseOptionalString(body.catcherTargetMode, 'catcherTargetMode'),
    catcherTargetCol: parseOptionalGridCoordinate(body.catcherTargetCol, 'catcherTargetCol'),
    catcherTargetRow: parseOptionalGridCoordinate(body.catcherTargetRow, 'catcherTargetRow'),
    // Campos estándar métricos (spec 29)
    plate_x: parseOptionalSignedFloat(body.plate_x, 'plate_x'),
    plate_z: parseOptionalSignedFloat(body.plate_z, 'plate_z'),
    zone: parseOptionalNonNegativeInt(body.zone, 'zone'),
    start_speed: parseOptionalFloat(body.start_speed, 'start_speed'),
    pfx_x: parseOptionalSignedFloat(body.pfx_x, 'pfx_x'),
    pfx_z: parseOptionalSignedFloat(body.pfx_z, 'pfx_z'),
    spin_rate: parseOptionalNonNegativeInt(body.spin_rate, 'spin_rate'),
    spin_axis: parseOptionalNonNegativeInt(body.spin_axis, 'spin_axis'),
    pitch_class: parseOptionalString(body.pitch_class, 'pitch_class'),
    confidence: parseOptionalFloat(body.confidence, 'confidence'),
    device_id: parseOptionalString(body.device_id, 'device_id'),
  };
}

function parseOptionalBase(value: unknown, fieldName: string): BaseName | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (value !== 'first' && value !== 'second' && value !== 'third') {
    throw new Error(`${fieldName} must be one of: first, second, third`);
  }

  return value;
}

function parseSubstitutionRequest(body: unknown, routeGameId: string): SubstitutionRequest {
  if (!isRecord(body)) {
    throw new Error('Request body must be a JSON object');
  }

  const gameId = parseRequiredString(body.gameId, 'gameId');
  if (gameId !== routeGameId) {
    throw new Error('gameId in body must match :gameId route parameter');
  }

  const substitutionType = parseRequiredString(body.substitutionType, 'substitutionType') as SubstitutionType;
  if (!SUBSTITUTION_TYPES.has(substitutionType)) {
    throw new Error('substitutionType must be a valid MLBAM substitution type');
  }

  const payload: SubstitutionRequest = {
    gameId,
    substitutionType,
    incomingPlayerId: parseRequiredString(body.incomingPlayerId, 'incomingPlayerId'),
    outgoingPlayerId: parseRequiredString(body.outgoingPlayerId, 'outgoingPlayerId'),
    position: parseOptionalString(body.position, 'position'),
    base: parseOptionalBase(body.base, 'base'),
    battingOrder: parseOptionalInteger(body.battingOrder, 'battingOrder'),
    notes: parseOptionalString(body.notes, 'notes'),
  };

  if (payload.substitutionType === 'pinch_runner' && !payload.base) {
    throw new Error('base is required for pinch_runner substitutions');
  }

  return payload;
}

async function getAtBatColumns(): Promise<Set<string>> {
  if (!pool) {
    return new Set();
  }

  atBatColumnsPromise ??= pool
    .query<AtBatColumnRow[]>('SHOW COLUMNS FROM at_bats')
    .then(([rows]) => new Set(rows.map((row) => row.Field)));

  return atBatColumnsPromise;
}

async function getPitchColumns(): Promise<Set<string>> {
  if (!pool) {
    return new Set();
  }

  pitchColumnsPromise ??= pool
    .query<PitchColumnRow[]>('SHOW COLUMNS FROM pitches')
    .then(([rows]) => new Set(rows.map((row) => row.Field)));

  return pitchColumnsPromise;
}

async function findGameLineupId(gameId: string, playerId: string | undefined): Promise<string | null> {
  if (!pool || !playerId) {
    return null;
  }

  const [rows] = await pool.query<GameLineupRow[]>(
    `SELECT id
     FROM game_lineups
     WHERE game_id = ? AND player_id = ?
     ORDER BY is_starter DESC, batting_order ASC, created_at ASC
     LIMIT 1`,
    [gameId, playerId],
  );

  return rows[0]?.id ?? null;
}

async function loadPlayersById(playerIds: string[]): Promise<Record<string, PlayerInfoRow>> {
  if (!pool || playerIds.length === 0) {
    return {};
  }

  const uniquePlayerIds = [...new Set(playerIds)];
  const placeholders = uniquePlayerIds.map(() => '?').join(', ');
  const [rows] = await pool.query<PlayerInfoRow[]>(
    `SELECT id, name, number, position, photo_asset_id, team_id
     FROM players
     WHERE id IN (${placeholders})`,
    uniquePlayerIds,
  );

  return rows.reduce<Record<string, PlayerInfoRow>>((accumulator, row) => {
    accumulator[row.id] = row;
    return accumulator;
  }, {});
}

async function findActiveGameLineupRow(gameId: string, playerId: string): Promise<ActiveGameLineupRow | null> {
  if (!pool) {
    return null;
  }

  const [rows] = await pool.query<ActiveGameLineupRow[]>(
    `SELECT id, team_id, batting_order, position, defensive_position, is_starter, is_dp, is_flex, re_entry_used, courtesy_running_for_roster_id
     FROM game_lineups
     WHERE game_id = ? AND player_id = ? AND substituted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [gameId, playerId],
  );

  return rows[0] ?? null;
}

function resolveSubstitutionPosition(request: SubstitutionRequest, outgoingLineup: ActiveGameLineupRow): string {
  if (request.substitutionType === 'pitching_change') {
    return 'P';
  }

  if (request.substitutionType === 'pinch_hitter') {
    return request.position ?? 'PH';
  }

  if (request.substitutionType === 'pinch_runner') {
    return request.position ?? 'PR';
  }

  return request.position ?? outgoingLineup.defensive_position ?? outgoingLineup.position;
}

function resolveDefensivePosition(
  request: SubstitutionRequest,
  outgoingLineup: ActiveGameLineupRow,
  lineupPosition: string,
): string | null {
  if (request.substitutionType === 'pinch_hitter' || request.substitutionType === 'pinch_runner') {
    return request.position ?? null;
  }

  return request.position ?? outgoingLineup.defensive_position ?? lineupPosition;
}

function getLineupRoleForTeam(state: ReturnType<typeof stateStore.getState>, teamId: string): TeamRole {
  return state.homeTeam.id === teamId ? 'home' : 'away';
}

function replaceLineupEntry(
  entries: LineupEntry[],
  outgoingPlayerId: string,
  incomingEntry: LineupEntry,
): LineupEntry[] {
  return entries
    .map((entry) => (entry.playerId === outgoingPlayerId ? incomingEntry : entry))
    .sort((left, right) => left.order - right.order);
}

function getBattingRole(inningHalf: 'top' | 'bottom'): TeamRole {
  return inningHalf === 'top' ? 'away' : 'home';
}

function getPitchingRole(inningHalf: 'top' | 'bottom'): TeamRole {
  return inningHalf === 'top' ? 'home' : 'away';
}

function findLineupEntry(entries: LineupEntry[], playerId: string | undefined): LineupEntry | null {
  if (playerId) {
    const match = entries.find((entry) => entry.playerId === playerId);
    if (match) {
      return match;
    }
  }

  return entries[0] ?? null;
}

async function countAtBatsThisInning(gameId: string, inning: number, inningHalf: 'top' | 'bottom'): Promise<number> {
  if (!pool) {
    return 0;
  }

  const columns = await getAtBatColumns();
  const hasInningHalf = columns.has('inning_half');
  const sql = hasInningHalf
    ? 'SELECT COUNT(*) AS total FROM at_bats WHERE game_id = ? AND inning = ? AND inning_half = ?'
    : 'SELECT COUNT(*) AS total FROM at_bats WHERE game_id = ? AND inning = ?';
  const params = hasInningHalf ? [gameId, inning, inningHalf] : [gameId, inning];
  const [rows] = await pool.query<CountRow[]>(sql, params);
  return rows[0]?.total ?? 0;
}

function normalizeBats(value: string | null): 'R' | 'L' | 'S' | undefined {
  return value === 'R' || value === 'L' || value === 'S' ? value : undefined;
}

async function loadPlayerMeta(playerIds: string[]): Promise<Record<string, { bats?: 'R' | 'L' | 'S'; throws?: string }>> {
  if (!pool || playerIds.length === 0) {
    return {};
  }

  const uniquePlayerIds = [...new Set(playerIds)];
  const placeholders = uniquePlayerIds.map(() => '?').join(', ');
  const [rows] = await pool.query<PlayerMetaRow[]>(
    `SELECT id, bats, throws
     FROM players
     WHERE id IN (${placeholders})`,
    uniquePlayerIds,
  );

  return rows.reduce<Record<string, { bats?: 'R' | 'L' | 'S'; throws?: string }>>((accumulator, row) => {
    accumulator[row.id] = {
      bats: normalizeBats(row.bats),
      ...(row.throws ? { throws: row.throws } : {}),
    };
    return accumulator;
  }, {});
}

/** Mapea el resultado local al vocabulario MLBAM para event_type */
function toMlbamEventType(result: AtBatResult): string {
  const map: Record<AtBatResult, string> = {
    single: 'single',
    double: 'double',
    triple: 'triple',
    home_run: 'home_run',
    walk: 'walk',
    hbp: 'hit_by_pitch',
    error: 'field_error',
    strikeout: 'strikeout',
    field_out: 'field_out',       // MLBAM canonical
    groundout: 'field_out',       // legacy alias
    flyout: 'field_out',          // legacy alias
    sacrifice_fly: 'sac_fly',
    sacrifice_bunt: 'sac_bunt',
    fielders_choice: 'fielders_choice',
    double_play: 'grounded_into_double_play',
  };
  return map[result] ?? result;
}

/** Determina si el resultado cuenta como At-Bat oficial (no walk, HBP, sac) */
function isOfficialAtBat(result: AtBatResult): boolean {
  const NON_AB_RESULTS = new Set<AtBatResult>(['walk', 'hbp', 'sacrifice_fly', 'sacrifice_bunt']);
  return !NON_AB_RESULTS.has(result);
}

/** Determina si el resultado cuenta como Plate Appearance oficial (no sac_bunt, interference) */
function isOfficialPA(result: AtBatResult): boolean {
  // MLBAM: sacrifice_bunt no cuenta como PA; sacrifice_fly SÍ cuenta
  return result !== 'sacrifice_bunt';
}

async function insertAtBat(request: AtBatRequest): Promise<void> {
  if (!pool) {
    throw new Error('DATABASE_URL no está configurado');
  }

  const state = stateStore.getState();
  const columns = await getAtBatColumns();
  const pendingPinchHitter = !request.substitutionType ? pendingPinchHitters.get(request.gameId) : undefined;
  const substitutionType = request.substitutionType
    ?? (pendingPinchHitter?.batterPlayerId === request.batterPlayerId ? pendingPinchHitter.substitutionType : undefined);
  const batterRosterId = await findGameLineupId(request.gameId, request.batterPlayerId);
  const pitcherRosterId = request.pitcherPlayerId ? await findGameLineupId(request.gameId, request.pitcherPlayerId) : null;
  const onBase = request.onBase ?? ON_BASE_RESULTS.has(request.result);
  // player_id y result fueron eliminados (migración 018); usar batter_player_id y event_type
  const insertColumns = ['game_id', 'inning', 'rbi', 'runs'];
  const insertValues: Array<string | number | boolean | null> = [
    request.gameId,
    state.inning,
    request.rbi ?? 0,
    request.runs ?? 0,
  ];
  const placeholders = ['?', '?', '?', '?'];

  if (columns.has('batter_roster_id')) {
    insertColumns.push('batter_roster_id');
    insertValues.push(batterRosterId);
    placeholders.push('?');
  }

  if (columns.has('batter_player_id')) {
    insertColumns.push('batter_player_id');
    insertValues.push(request.batterPlayerId);
    placeholders.push('?');
  }

  if (columns.has('pitcher_roster_id')) {
    insertColumns.push('pitcher_roster_id');
    insertValues.push(pitcherRosterId);
    placeholders.push('?');
  }

  if (columns.has('inning_half')) {
    insertColumns.push('inning_half');
    insertValues.push(state.inningHalf);
    placeholders.push('?');
  }

  if (columns.has('on_base')) {
    insertColumns.push('on_base');
    insertValues.push(onBase);
    placeholders.push('?');
  }

  if (columns.has('pitch_count')) {
    insertColumns.push('pitch_count');
    insertValues.push(request.pitchCount ?? null);
    placeholders.push('?');
  }

  if (columns.has('notes')) {
    insertColumns.push('notes');
    insertValues.push(request.notes ?? null);
    placeholders.push('?');
  }

  if (columns.has('contact_type')) {
    insertColumns.push('contact_type');
    insertValues.push(request.contactType ?? null);
    placeholders.push('?');
  }

  if (columns.has('hit_direction')) {
    insertColumns.push('hit_direction');
    insertValues.push(request.hitDirection ?? null);
    placeholders.push('?');
  }

  if (columns.has('hit_quality')) {
    insertColumns.push('hit_quality');
    insertValues.push(request.hitData?.hardness ?? null);
    placeholders.push('?');
  }

  if (columns.has('hit_data')) {
    const hitDataJson = request.hitData
      ? JSON.stringify({
          type: request.hitData.type ?? request.contactType ?? null,
          direction: request.hitData.direction ?? request.hitDirection ?? null,
          hardness: request.hitData.hardness ?? null,
        })
      : null;
    insertColumns.push('hit_data');
    insertValues.push(hitDataJson);
    placeholders.push('?');
  }

  if (columns.has('runners_json')) {
    insertColumns.push('runners_json');
    insertValues.push(request.runnersJson ?? null);
    placeholders.push('?');
  }

  if (columns.has('event_type')) {
    insertColumns.push('event_type');
    insertValues.push(toMlbamEventType(request.result));
    placeholders.push('?');
  }

  // batting_team_id: equipo al bate — campo explícito MLBAM (no derivado de inning_half)
  // top = visitante (away), bottom = local (home)
  if (columns.has('batting_team_id')) {
    const battingTeamId = state.inningHalf === 'bottom'
      ? (state.homeTeam?.id ?? null)
      : (state.awayTeam?.id ?? null);
    insertColumns.push('batting_team_id');
    insertValues.push(battingTeamId);
    placeholders.push('?');
  }

  // runners: estado de bases DESPUÉS del at-bat (snapshot para contexto histórico)
  if (columns.has('runners')) {
    const basesAfter = stateStore.getState().bases as GameBasesWithPitcherResponsibility;
    const runnersSnapshot = {
      first: basesAfter.first
        ? { id: basesAfter.first.id, responsiblePitcherId: basesAfter.first.responsiblePitcherId ?? null }
        : null,
      second: basesAfter.second
        ? { id: basesAfter.second.id, responsiblePitcherId: basesAfter.second.responsiblePitcherId ?? null }
        : null,
      third: basesAfter.third
        ? { id: basesAfter.third.id, responsiblePitcherId: basesAfter.third.responsiblePitcherId ?? null }
        : null,
    };
    insertColumns.push('runners');
    insertValues.push(JSON.stringify(runnersSnapshot));
    placeholders.push('?');
  }

  if (columns.has('pitcher_player_id')) {
    insertColumns.push('pitcher_player_id');
    insertValues.push(request.pitcherPlayerId ?? null);
    placeholders.push('?');
  }

  // Momento de la transmisión: outs, score y timecode del stream al inicio del play
  if (columns.has('outs_before')) {
    insertColumns.push('outs_before');
    insertValues.push(state.outs);
    placeholders.push('?');
  }

  if (columns.has('score_home')) {
    insertColumns.push('score_home');
    insertValues.push(state.score.home);
    placeholders.push('?');
  }

  if (columns.has('score_away')) {
    insertColumns.push('score_away');
    insertValues.push(state.score.away);
    placeholders.push('?');
  }

  if (columns.has('video_timestamp') && request.videoTimestamp) {
    insertColumns.push('video_timestamp');
    insertValues.push(request.videoTimestamp);
    placeholders.push('?');
  }

  // MLBAM: is_at_bat / is_plate_appearance (F3/F4)
  if (columns.has('is_at_bat')) {
    insertColumns.push('is_at_bat');
    insertValues.push(isOfficialAtBat(request.result) ? 1 : 0);
    placeholders.push('?');
  }

  if (columns.has('is_plate_appearance')) {
    insertColumns.push('is_plate_appearance');
    insertValues.push(isOfficialPA(request.result) ? 1 : 0);
    placeholders.push('?');
  }

  // MLBAM: earned_runs / unearned_runs (F1/F2) — el servidor los recibe del cliente o los deja en 0
  if (columns.has('earned_runs')) {
    insertColumns.push('earned_runs');
    insertValues.push(request.earnedRuns ?? 0);
    placeholders.push('?');
  }

  if (columns.has('unearned_runs')) {
    insertColumns.push('unearned_runs');
    insertValues.push(request.unearnedRuns ?? 0);
    placeholders.push('?');
  }

  // substitution_type: pinch_hitter | pinch_runner | null (F5)
  if (columns.has('substitution_type') && substitutionType) {
    insertColumns.push('substitution_type');
    insertValues.push(substitutionType);
    placeholders.push('?');
  }

  // ext: PFX namespace — incluye pitch decisivo si viene de un in_play
  if (columns.has('ext') && request.decisivePitch) {
    const extVal = { playflow: { decisivePitch: request.decisivePitch } };
    insertColumns.push('ext');
    insertValues.push(JSON.stringify(extVal));
    placeholders.push('?');
  }

  if (columns.has('timestamp')) {
    insertColumns.push('timestamp');
    placeholders.push('CURRENT_TIMESTAMP(3)');
  }

  await pool.query(
    `INSERT INTO at_bats (${insertColumns.join(', ')})
     VALUES (${placeholders.join(', ')})`,
    insertValues,
  );

  if (pendingPinchHitter && substitutionType === 'pinch_hitter' && pendingPinchHitter.batterPlayerId === request.batterPlayerId) {
    pendingPinchHitters.delete(request.gameId);
  }
}

async function insertPitch(request: PitchRequest): Promise<void> {
  if (!pool) {
    throw new Error('DATABASE_URL no está configurado');
  }

  const columns = await getPitchColumns();
  const state = stateStore.getState();
  const battingRole = getBattingRole(state.inningHalf);
  const pitchingRole = getPitchingRole(state.inningHalf);
  const batterId = state.currentBatterId ?? state.lineup[battingRole][0]?.playerId;
  const pitcherId = state.currentPitcherId ?? state.lineup[pitchingRole][0]?.playerId;

  if (!batterId || !pitcherId) {
    return;
  }

  const insertColumns = ['game_id', 'pitcher_player_id', 'batter_player_id', 'pitch_num', 'umpire_call', 'inning', 'inning_half', 'operator_id'];
  const insertValues: Array<string | number | null> = [
    state.gameId,
    pitcherId,
    batterId,
    stateStore.getPitchCount() + 1,
    toUmpireCall(request.type),
    state.inning,
    state.inningHalf,
    'live-game-scoring',
  ];
  const placeholders = ['?', '?', '?', '?', '?', '?', '?', '?'];

  if (columns.has('pitch_type')) {
    insertColumns.push('pitch_type');
    insertValues.push(request.pitchType ?? null);
    placeholders.push('?');
  }

  if (columns.has('umpire_id')) {
    insertColumns.push('umpire_id');
    insertValues.push(request.umpireId ?? null);
    placeholders.push('?');
  }

  if (columns.has('video_timestamp')) {
    insertColumns.push('video_timestamp');
    insertValues.push(request.videoTimestamp ?? null);
    placeholders.push('?');
  }

  if (columns.has('note')) {
    insertColumns.push('note');
    insertValues.push(request.note ?? null);
    placeholders.push('?');
  }

  if (columns.has('catcher_target_mode')) {
    insertColumns.push('catcher_target_mode');
    insertValues.push(request.catcherTargetMode ?? null);
    placeholders.push('?');
  }

  if (columns.has('catcher_target_col')) {
    insertColumns.push('catcher_target_col');
    insertValues.push(request.catcherTargetCol ?? null);
    placeholders.push('?');
  }

  if (columns.has('catcher_target_row')) {
    insertColumns.push('catcher_target_row');
    insertValues.push(request.catcherTargetRow ?? null);
    placeholders.push('?');
  }

  if (columns.has('zone_x')) {
    insertColumns.push('zone_x');
    insertValues.push(request.col ?? null);
    placeholders.push('?');
  }

  if (columns.has('zone_y')) {
    insertColumns.push('zone_y');
    insertValues.push(request.row ?? null);
    placeholders.push('?');
  }

  // Campos estándar métricos (spec 29)
  const metricFields: Array<[string, number | string | null | undefined]> = [
    ['plate_x', request.plate_x],
    ['plate_z', request.plate_z],
    ['zone', request.zone],
    ['sz_top', null],
    ['sz_bottom', null],
    ['pfx_x', request.pfx_x],
    ['pfx_z', request.pfx_z],
    ['start_speed', request.start_speed ?? request.velocityKmh],
    ['spin_rate', request.spin_rate],
    ['spin_axis', request.spin_axis],
    ['pitch_class', request.pitch_class],
    ['confidence', request.confidence],
    ['device_id', request.device_id],
  ];
  for (const [col, val] of metricFields) {
    if (columns.has(col) && val !== undefined) {
      insertColumns.push(col);
      insertValues.push(val ?? null);
      placeholders.push('?');
    }
  }

  if (columns.has('at_bat_id')) {
    insertColumns.push('at_bat_id');
    insertValues.push(null);
    placeholders.push('?');
  }

  // Momento de la transmisión: outs al momento del lanzamiento
  if (columns.has('outs_before')) {
    insertColumns.push('outs_before');
    insertValues.push(state.outs);
    placeholders.push('?');
  }

  if (columns.has('timestamp')) {
    insertColumns.push('timestamp');
    placeholders.push('CURRENT_TIMESTAMP(3)');
  }

  await pool.query(
    `INSERT INTO pitches (${insertColumns.join(', ')})
     VALUES (${placeholders.join(', ')})`,
    insertValues,
  );
}

export interface GamePlayerStats {
  playerId: string;
  ab: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  rbi: number;
  runs: number;
  walks: number;
  strikeouts: number;
}

async function computePlayerStats(gameId: string): Promise<Record<string, GamePlayerStats>> {
  if (!pool) return {};

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
      batter_player_id AS player_id,
      COUNT(CASE WHEN event_type NOT IN ('walk','intent_walk','hit_by_pitch','sac_fly','sac_bunt') THEN 1 END) AS ab,
      SUM(CASE WHEN event_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN event_type = 'double' THEN 1 ELSE 0 END) AS doubles,
      SUM(CASE WHEN event_type = 'triple' THEN 1 ELSE 0 END) AS triples,
      SUM(CASE WHEN event_type = 'home_run' THEN 1 ELSE 0 END) AS home_runs,
      SUM(rbi) AS rbi,
      SUM(runs) AS runs,
      SUM(CASE WHEN event_type IN ('walk','intent_walk','hit_by_pitch') THEN 1 ELSE 0 END) AS walks,
      SUM(CASE WHEN event_type = 'strikeout' THEN 1 ELSE 0 END) AS strikeouts
    FROM at_bats
    WHERE game_id = ?
    GROUP BY batter_player_id`,
    [gameId],
  );

  const stats: Record<string, GamePlayerStats> = {};

  for (const row of rows) {
    const pid = row.player_id as string;
    stats[pid] = {
      playerId: pid,
      ab: Number(row.ab ?? 0),
      hits: Number(row.hits ?? 0),
      doubles: Number(row.doubles ?? 0),
      triples: Number(row.triples ?? 0),
      homeRuns: Number(row.home_runs ?? 0),
      rbi: Number(row.rbi ?? 0),
      runs: Number(row.runs ?? 0),
      walks: Number(row.walks ?? 0),
      strikeouts: Number(row.strikeouts ?? 0),
    };
  }

  return stats;
}

async function computePitcherStats(gameId: string): Promise<Record<string, PitcherStats>> {
  if (!pool) return {};

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
      pitcher_player_id AS pitcher_id,
      SUM(COALESCE(pitch_count, 0)) AS pitches,
      SUM(CASE WHEN event_type = 'strikeout' THEN 1 ELSE 0 END) AS strikeouts,
      SUM(CASE WHEN event_type IN ('walk','intent_walk','hit_by_pitch') THEN 1 ELSE 0 END) AS walks,
      SUM(CASE WHEN event_type IN ('single','double','triple','home_run') THEN 1 ELSE 0 END) AS hits_allowed,
      SUM(runs) AS runs_allowed,
      SUM(CASE WHEN event_type IN ('strikeout','field_out','force_out','fielders_choice_out',
                                    'sac_fly','sac_bunt') THEN 1
               WHEN event_type IN ('double_play','grounded_into_double_play','sac_fly_double_play',
                                    'sac_bunt_double_play','strikeout_double_play') THEN 2
               WHEN event_type = 'triple_play' THEN 3 ELSE 0 END) AS outs_recorded
    FROM at_bats
    WHERE game_id = ? AND pitcher_player_id IS NOT NULL
    GROUP BY pitcher_player_id`,
    [gameId],
  );

  const stats: Record<string, PitcherStats> = {};

  for (const row of rows) {
    const pid = row.pitcher_id as string;
    const outs = Number(row.outs_recorded ?? 0);
    const fullInnings = Math.floor(outs / 3);
    const remainder = outs % 3;
    stats[pid] = {
      pitcherId: pid,
      outs,
      ip: remainder === 0 ? String(fullInnings) : `${fullInnings}.${remainder}`,
      pitches: Number(row.pitches ?? 0),
      strikeouts: Number(row.strikeouts ?? 0),
      walks: Number(row.walks ?? 0),
      hitsAllowed: Number(row.hits_allowed ?? 0),
      runsAllowed: Number(row.runs_allowed ?? 0),
    };
  }

  return stats;
}


function applyAtBatToGameState(request: AtBatRequest): void {
  const state = stateStore.getState();
  const battingTeamRole = getBattingRole(state.inningHalf);
  const beforeBases = state.bases as GameBasesWithPitcherResponsibility;
  const beforeInningHalf = state.inningHalf;
  const outsToRecord = request.result === 'double_play' ? 2 : OUT_RESULTS.has(request.result) ? 1 : 0;
  const responsiblePitcherId = request.pitcherPlayerId ?? state.currentPitcherId;

  // Asegurar que el bateador y pitcher correctos están activos en el engine
  if (state.currentBatterId !== request.batterPlayerId) {
    stateStore.sendCommand('SetBatter', `playerId:${request.batterPlayerId}`);
  }

  if (state.rules.hasPitcher && request.pitcherPlayerId && state.currentPitcherId !== request.pitcherPlayerId) {
    stateStore.sendCommand('SetPitcher', `playerId:${request.pitcherPlayerId}`);
  }

  // Calcular avance de corredores y carreras automáticas según el resultado
  let autoRuns = 0;
  let newBases: GameBasesWithPitcherResponsibility | null = null;

  if (request.result === 'home_run') {
    // Todos los corredores + bateador anotan; el campo `runs` del scorer se ignora
    autoRuns = (beforeBases.first !== null ? 1 : 0) + (beforeBases.second !== null ? 1 : 0) + (beforeBases.third !== null ? 1 : 0) + 1;
    newBases = { first: null, second: null, third: null };
  } else if (WALK_RESULTS.has(request.result)) {
    // Walk / HBP: avance forzado
    const batterRunner: RunnerOnBaseWithPitcher = {
      id: request.batterPlayerId,
      name: '',
      number: 0,
      originBase: 'first',
      earned: true,
      ...(responsiblePitcherId ? { responsiblePitcherId } : {}),
    };
    const adv = advanceRunnersForced(beforeBases, batterRunner);
    autoRuns = adv.runsScored;
    newBases = adv.newBases;
  } else if (request.result === 'single' || request.result === 'error' || request.result === 'fielders_choice') {
    // Sencillo / Error / FC: avance de 1 base; bateador a 1ª
    const adv = advanceRunnersNBases(beforeBases, 1);
    autoRuns = adv.runsScored;
    const batterRunner: RunnerOnBaseWithPitcher = {
      id: request.batterPlayerId,
      name: '',
      number: 0,
      originBase: 'first',
      earned: true,
      ...(responsiblePitcherId ? { responsiblePitcherId } : {}),
    };
    newBases = { ...adv.newBases, first: batterRunner };
  } else if (request.result === 'double') {
    // Doble: avance de 2 bases; bateador a 2ª
    const adv = advanceRunnersNBases(beforeBases, 2);
    autoRuns = adv.runsScored;
    const batterRunner: RunnerOnBaseWithPitcher = {
      id: request.batterPlayerId,
      name: '',
      number: 0,
      originBase: 'second',
      earned: true,
      ...(responsiblePitcherId ? { responsiblePitcherId } : {}),
    };
    newBases = { first: null, second: batterRunner, third: adv.newBases.third };
  } else if (request.result === 'triple') {
    // Triple: todos los corredores anotan; bateador a 3ª
    autoRuns = (beforeBases.first !== null ? 1 : 0) + (beforeBases.second !== null ? 1 : 0) + (beforeBases.third !== null ? 1 : 0);
    const batterRunner: RunnerOnBaseWithPitcher = {
      id: request.batterPlayerId,
      name: '',
      number: 0,
      originBase: 'third',
      earned: true,
      ...(responsiblePitcherId ? { responsiblePitcherId } : {}),
    };
    newBases = { first: null, second: null, third: batterRunner };
  }

  // Carreras totales = automáticas (avance) + manuales (operador, para casos edge)
  // HR es solo automático; el campo `runs` del scorer es ignorado para HR
  const manualRuns = request.result === 'home_run' ? 0 : (request.runs ?? 0);
  const totalRuns = autoRuns + manualRuns;

  // Registrar outs (AddOut puede avanzar la entrada si llega a maxOuts)
  for (let index = 0; index < outsToRecord; index += 1) {
    stateStore.sendCommand('AddOut');
  }

  // Registrar carreras al equipo en turno
  for (let index = 0; index < totalRuns; index += 1) {
    stateStore.sendCommand('IncrementScore', battingTeamRole);
  }

  // Actualizar bases — solo si la entrada no terminó (el engine ya limpió si hubo 3 outs)
  const afterOutsState = stateStore.getState();
  const inningHalfChangedAfterOuts = afterOutsState.inningHalf !== beforeInningHalf;

  if (!inningHalfChangedAfterOuts) {
    if (newBases !== null) {
      // Enviar identidad real del corredor (o limpiar base) — Spec 29 S2 RunnerOnBase
      stateStore.sendCommand('SetBase', toSetBaseCommand('first', newBases.first));
      stateStore.sendCommand('SetBase', toSetBaseCommand('second', newBases.second));
      stateStore.sendCommand('SetBase', toSetBaseCommand('third', newBases.third));
    }
    stateStore.sendCommand('ResetCount');
  }

  // Avanzar al siguiente bateador
  const finalState = stateStore.getState();
  const newBattingRole = getBattingRole(finalState.inningHalf);
  const inningChanged = newBattingRole !== battingTeamRole;

  if (inningChanged) {
    // Cambio de media entrada: primer bateador del nuevo equipo en turno
    const newLineup = finalState.lineup[newBattingRole];
    if (newLineup.length > 0) {
      const lastIdx = newLineup.findIndex((p) => p.playerId === finalState.currentBatterId);
      const nextBatter = lastIdx >= 0 ? newLineup[(lastIdx + 1) % newLineup.length] : newLineup[0];
      if (nextBatter) {
        stateStore.sendCommand('SetBatter', `playerId:${nextBatter.playerId}`);
      }
    }
  } else {
    // Misma media entrada: siguiente en el orden al bate (circular)
    const lineup = state.lineup[battingTeamRole];
    const currentIndex = lineup.findIndex((p) => p.playerId === request.batterPlayerId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % lineup.length : 0;
    const nextBatter = lineup[nextIndex];
    if (nextBatter) {
      stateStore.sendCommand('SetBatter', `playerId:${nextBatter.playerId}`);
    }
  }
}

export const scorerRouter = Router();

/**
 * Middleware: si el request lleva JWT, verifica que el usuario
 * esté asignado como scorer del juego. En modo dev (sin pool) se omite.
 * No-breaking: sin token el request pasa (compatibilidad con clientes legacy).
 */
async function checkScorerAccess(request: Request, response: Response): Promise<boolean> {
  const authReq = request as AuthenticatedRequest;
  if (!authReq.user) return true; // sin token — legacy/dev
  const gameId = (request.body as { gameId?: string }).gameId
    ?? (request.params.gameId ?? '');
  if (!gameId) return true;
  const allowed = await canScore(authReq.user.sub, gameId);
  if (!allowed) {
    response.status(403).json({ error: 'not_assigned_scorer', gameId });
    return false;
  }
  return true;
}

scorerRouter.post('/at-bats', optionalAuth, async (request: Request, response: Response) => {
  if (!(await checkScorerAccess(request, response))) return;
  if (!requirePool(response)) {
    return;
  }

  try {
    const payload = parseAtBatRequest(request.body);
    await insertAtBat(payload);
    applyAtBatToGameState(payload);
    stateStore.broadcast();

    // Calcular y transmitir estadísticas actualizadas por jugador
    computePlayerStats(payload.gameId)
      .then((stats) => {
        stateStore.broadcastPlayerStats(stats);
      })
      .catch((err: unknown) => {
        console.warn('[Scorer] computePlayerStats error', err);
      });

    // Calcular y transmitir estadísticas actualizadas por pitcher
    computePitcherStats(payload.gameId)
      .then((pitcherStats) => {
        stateStore.broadcastPitcherStats(pitcherStats);
      })
      .catch((err: unknown) => {
        console.warn('[Scorer] computePitcherStats error', err);
      });

    sendSuccess(response, {
      gameState: stateStore.getState(),
      recorded: {
        ...payload,
        inning: stateStore.getState().inning,
        inningHalf: stateStore.getState().inningHalf,
      },
    });
  } catch (error) {
    sendError(response, 400, error);
  }
});

scorerRouter.get('/at-bats/:gameId', async (request: Request, response: Response) => {
  const databasePool = requirePool(response);
  if (!databasePool) {
    return;
  }

  try {
    const gameId = parseRequiredString(request.params.gameId, 'gameId');
    const columns = await getAtBatColumns();
    const recordedAtColumn = columns.has('timestamp') ? 'ab.timestamp' : 'ab.created_at';
    const batterPlayerIdExpr = 'ab.batter_player_id';
    const selectColumns = [
      'ab.id',
      'ab.game_id',
      'ab.batter_player_id',
      'ab.batter_roster_id',
      columns.has('pitcher_roster_id') ? 'ab.pitcher_roster_id' : 'NULL AS pitcher_roster_id',
      'ab.inning',
      columns.has('inning_half') ? 'ab.inning_half' : 'NULL AS inning_half',
      columns.has('event_type') ? 'ab.event_type AS result' : 'NULL AS result',
      'ab.rbi',
      'ab.runs',
      columns.has('on_base') ? 'ab.on_base' : 'NULL AS on_base',
      columns.has('pitch_count') ? 'ab.pitch_count' : 'NULL AS pitch_count',
      columns.has('notes') ? 'ab.notes' : 'NULL AS notes',
      `${recordedAtColumn} AS recorded_at`,
      'p.name AS batter_name',
      'p.number AS batter_number',
    ];
    const [rows] = await databasePool.query<RowDataPacket[]>(
      `SELECT ${selectColumns.join(', ')}
       FROM at_bats ab
       LEFT JOIN players p ON p.id = ${batterPlayerIdExpr}
       WHERE ab.game_id = ?
       ORDER BY ${recordedAtColumn} DESC`,
      [gameId],
    );

    sendSuccess(response, rows);
  } catch (error) {
    sendError(response, 400, error);
  }
});

scorerRouter.get('/scorer/context', async (_request: Request, response: Response) => {
  if (!requirePool(response)) {
    return;
  }

  try {
    const gameState = stateStore.getState();
    const battingRole = getBattingRole(gameState.inningHalf);
    const pitchingRole = getPitchingRole(gameState.inningHalf);
    const currentBatter = findLineupEntry(gameState.lineup[battingRole], gameState.currentBatterId);
    const currentPitcher = gameState.rules.hasPitcher
      ? findLineupEntry(
          gameState.lineup[pitchingRole].filter((entry) => entry.position.toUpperCase() === 'P' || entry.playerId === gameState.currentPitcherId),
          gameState.currentPitcherId,
        ) ?? findLineupEntry(gameState.lineup[pitchingRole], gameState.currentPitcherId)
      : null;
    const atBatsThisInning = await countAtBatsThisInning(gameState.gameId, gameState.inning, gameState.inningHalf);
    const pitcherStats = gameState.rules.hasPitcher ? await computePitcherStats(gameState.gameId) : {};
    const playerMeta = await loadPlayerMeta([
      ...gameState.lineup[battingRole].map((player) => player.playerId),
      ...gameState.lineup[pitchingRole].map((player) => player.playerId),
    ]);

    sendSuccess(response, {
      gameState,
      currentInning: gameState.inning,
      inningHalf: gameState.inningHalf,
      currentBatter,
      currentPitcher,
      battingLineup: gameState.lineup[battingRole],
      pitchingLineup: gameState.lineup[pitchingRole],
      atBatsThisInning,
      pitcherStats,
      pitcherChangeLog: stateStore.pitcherChangeLog,
      playerMeta,
    });
  } catch (error) {
    sendError(response, 400, error);
  }
});

/**
 * GET /pitches/:gameId
 * Lista todos los pitches de un juego con nombre de bateador y pitcher,
 * velocidad y coordenadas. Ordenados por inning ASC, timestamp ASC.
 */
scorerRouter.get('/pitches/:gameId', async (request: Request, response: Response) => {
  const databasePool = requirePool(response);
  if (!databasePool) return;
  try {
    const gameId = parseRequiredString(request.params.gameId, 'gameId');
    const [rows] = await databasePool.query<RowDataPacket[]>(
      `SELECT
         p.id, p.game_id, p.batter_player_id, p.pitcher_player_id,
         p.pitch_num, p.umpire_call, p.pitch_type,
         p.zone_x AS col, p.zone_y AS row,
         p.zone, p.plate_x, p.plate_z,
         p.inning, p.inning_half,
         p.start_speed AS velocity_kmh,
         p.timestamp,
         b.name AS batter_name,
         pit.name AS pitcher_name
       FROM pitches p
       LEFT JOIN players b   ON b.id   = p.batter_player_id
       LEFT JOIN players pit ON pit.id = p.pitcher_player_id
       WHERE p.game_id = ?
       ORDER BY p.inning ASC, p.timestamp ASC, p.pitch_num ASC`,
      [gameId],
    );
    sendSuccess(response, rows);
  } catch (error) {
    sendError(response, 400, error);
  }
});

/**
 * DELETE /at-bats/:id
 * Elimina un at-bat por ID. Solo el más reciente puede borrarse en operación normal.
 */
scorerRouter.delete('/at-bats/:id', async (request: Request, response: Response) => {
  const databasePool = requirePool(response);
  if (!databasePool) return;
  try {
    const id = parseRequiredString(request.params.id, 'id');
    const [result] = await databasePool.query<ResultSetHeader>(
      'DELETE FROM at_bats WHERE id = ?',
      [id],
    );
    if (result.affectedRows === 0) {
      sendError(response, 404, 'At-bat no encontrado');
      return;
    }
    sendSuccess(response, { deleted: id });
  } catch (error) {
    sendError(response, 400, error);
  }
});

/**
 * POST /pitch
 * Registra un pitcheo (bola, strike, foul) con lógica automática:
 * - Bola 4 → auto-walk
 * - Strike 3 → auto-ponche
 * - Foul con 2 strikes → no-op
 */
scorerRouter.post('/pitch', optionalAuth, async (request: Request, response: Response) => {
  if (!(await checkScorerAccess(request, response))) return;
  if (!requirePool(response)) return;

  try {
    const payload = parsePitchRequest(request.body);
    await insertPitch(payload);
    const state = stateStore.getState();
    const currentBalls = state.count.balls;
    const currentStrikes = state.count.strikes;
    const type = payload.type;

    // wild_pitch / passed_ball / in_play — solo registrar, no actualizar conteo
    if (type === 'wild_pitch' || type === 'passed_ball' || type === 'in_play') {
      sendSuccess(response, { gameState: stateStore.getState(), action: 'recorded' });
      return;
    }

    if (type === 'foul') {
      if (currentStrikes < 2) {
        stateStore.sendCommand('AddStrike');
        stateStore.incrementPitchCount();
      }
      sendSuccess(response, { gameState: stateStore.getState(), action: currentStrikes < 2 ? 'strike_added' : 'no_op' });
      return;
    }

    // hit_by_pitch → avanza bateador a 1ª (como walk)
    if (type === 'hit_by_pitch') {
      const pitchCount = stateStore.getPitchCount() + 1;
      const battingRole = getBattingRole(state.inningHalf);
      const batterId = state.currentBatterId ?? state.lineup[battingRole][0]?.playerId ?? '';
      const pitcherId = state.rules.hasPitcher ? (state.currentPitcherId ?? undefined) : undefined;

      const hbpRequest: AtBatRequest = {
        gameId: state.gameId,
        batterPlayerId: batterId,
        pitcherPlayerId: pitcherId,
        result: 'hbp',
        rbi: 0,
        runs: 0,
        pitchCount,
      };

      await insertAtBat(hbpRequest);
      applyAtBatToGameState(hbpRequest);
      stateStore.resetPitchCount();
      stateStore.broadcast();

      computePlayerStats(state.gameId)
        .then((stats) => { stateStore.broadcastPlayerStats(stats); })
        .catch((err: unknown) => { console.warn('[Pitch] computePlayerStats error', err); });

      computePitcherStats(state.gameId)
        .then((pitcherStats) => { stateStore.broadcastPitcherStats(pitcherStats); })
        .catch((err: unknown) => { console.warn('[Pitch] computePitcherStats error', err); });

      sendSuccess(response, { gameState: stateStore.getState(), action: 'hbp' });
      return;
    }

    if (type === 'ball') {
      const newBalls = currentBalls + 1;
      stateStore.incrementPitchCount();

      if (newBalls >= 4) {
        const pitchCount = stateStore.getPitchCount();
        const battingRole = getBattingRole(state.inningHalf);
        const batterId = state.currentBatterId ?? state.lineup[battingRole][0]?.playerId ?? '';
        const pitcherId = state.rules.hasPitcher ? (state.currentPitcherId ?? undefined) : undefined;

        const walkRequest: AtBatRequest = {
          gameId: state.gameId,
          batterPlayerId: batterId,
          pitcherPlayerId: pitcherId,
          result: 'walk',
          rbi: 0,
          runs: 0,
          pitchCount,
        };

        await insertAtBat(walkRequest);
        applyAtBatToGameState(walkRequest);
        stateStore.resetPitchCount();
        stateStore.broadcast();

        computePlayerStats(state.gameId)
          .then((stats) => { stateStore.broadcastPlayerStats(stats); })
          .catch((err: unknown) => { console.warn('[Pitch] computePlayerStats error', err); });

        computePitcherStats(state.gameId)
          .then((pitcherStats) => { stateStore.broadcastPitcherStats(pitcherStats); })
          .catch((err: unknown) => { console.warn('[Pitch] computePitcherStats error', err); });

        sendSuccess(response, { gameState: stateStore.getState(), action: 'auto_walk' });
      } else {
        stateStore.sendCommand('AddBall');
        sendSuccess(response, { gameState: stateStore.getState(), action: 'ball_added' });
      }
      return;
    }

    // called_strike | swinging_strike
    const newStrikes = currentStrikes + 1;
    stateStore.incrementPitchCount();

    if (newStrikes >= 3) {
      const pitchCount = stateStore.getPitchCount();
      const battingRole = getBattingRole(state.inningHalf);
      const batterId = state.currentBatterId ?? state.lineup[battingRole][0]?.playerId ?? '';
      const pitcherId = state.rules.hasPitcher ? (state.currentPitcherId ?? undefined) : undefined;

      const kRequest: AtBatRequest = {
        gameId: state.gameId,
        batterPlayerId: batterId,
        pitcherPlayerId: pitcherId,
        result: 'strikeout',
        rbi: 0,
        runs: 0,
        pitchCount,
      };

      await insertAtBat(kRequest);
      applyAtBatToGameState(kRequest);
      stateStore.resetPitchCount();
      stateStore.broadcast();

      computePlayerStats(state.gameId)
        .then((stats) => { stateStore.broadcastPlayerStats(stats); })
        .catch((err: unknown) => { console.warn('[Pitch] computePlayerStats error', err); });

      computePitcherStats(state.gameId)
        .then((pitcherStats) => { stateStore.broadcastPitcherStats(pitcherStats); })
        .catch((err: unknown) => { console.warn('[Pitch] computePitcherStats error', err); });

      sendSuccess(response, { gameState: stateStore.getState(), action: 'auto_strikeout' });
    } else {
      stateStore.sendCommand('AddStrike');
      sendSuccess(response, { gameState: stateStore.getState(), action: 'strike_added' });
    }
  } catch (error) {
    sendError(response, 400, error);
  }
});

scorerRouter.post('/substitutions/:gameId', async (request: Request, response: Response) => {
  const databasePool = requirePool(response);
  if (!databasePool) {
    return;
  }

  try {
    const routeGameId = parseRequiredString(request.params.gameId, 'gameId');
    const payload = parseSubstitutionRequest(request.body, routeGameId);
    const stateBefore = stateStore.getState();
    const outgoingLineup = await findActiveGameLineupRow(payload.gameId, payload.outgoingPlayerId);

    if (!outgoingLineup) {
      throw new Error(`No active lineup entry found for outgoing player ${payload.outgoingPlayerId}`);
    }

    const players = await loadPlayersById([payload.incomingPlayerId, payload.outgoingPlayerId]);
    const incomingPlayer = players[payload.incomingPlayerId];
    const outgoingPlayer = players[payload.outgoingPlayerId];

    if (!incomingPlayer) {
      throw new Error(`Incoming player ${payload.incomingPlayerId} was not found`);
    }

    const lineupRole = getLineupRoleForTeam(stateBefore, outgoingLineup.team_id);
    const currentEntries = stateBefore.lineup[lineupRole];
    const outgoingEntry = currentEntries.find((entry) => entry.playerId === payload.outgoingPlayerId);

    if (!outgoingEntry) {
      throw new Error(`Outgoing player ${payload.outgoingPlayerId} is not present in the in-memory lineup`);
    }

    const battingOrder = payload.battingOrder ?? outgoingLineup.batting_order ?? outgoingEntry.order;
    const lineupPosition = resolveSubstitutionPosition(payload, outgoingLineup);
    const defensivePosition = resolveDefensivePosition(payload, outgoingLineup, lineupPosition);
    const incomingEntry: LineupEntry = {
      order: battingOrder,
      playerId: payload.incomingPlayerId,
      name: incomingPlayer.name,
      number: incomingPlayer.number,
      position: lineupPosition,
      status: 'active',
      ...(incomingPlayer.photo_asset_id ? { photoAssetId: incomingPlayer.photo_asset_id } : {}),
    };

    const nextLineup = lineupRole === 'home'
      ? {
          home: replaceLineupEntry(stateBefore.lineup.home, payload.outgoingPlayerId, incomingEntry),
          away: stateBefore.lineup.away,
        }
      : {
          home: stateBefore.lineup.home,
          away: replaceLineupEntry(stateBefore.lineup.away, payload.outgoingPlayerId, incomingEntry),
        };

    const basesBefore = stateBefore.bases as GameBasesWithPitcherResponsibility;
    const replacedRunner = payload.base ? basesBefore[payload.base] : null;
    if (payload.substitutionType === 'pinch_runner' && !replacedRunner) {
      throw new Error(`No runner found on ${payload.base} for pinch_runner substitution`);
    }

    const eventId = crypto.randomUUID();
    const eventPayload = {
      substitutionType: payload.substitutionType,
      incoming: { playerId: payload.incomingPlayerId, name: incomingPlayer.name },
      outgoing: {
        playerId: payload.outgoingPlayerId,
        name: outgoingPlayer?.name ?? outgoingEntry.name,
      },
      position: payload.position,
      base: payload.base,
      battingOrder,
    };

    const shouldSetPitcher = payload.substitutionType === 'pitching_change'
      || payload.substitutionType === 'double_switch'
      || lineupPosition.toUpperCase() === 'P';

    const connection = await databasePool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query<ResultSetHeader>(
        `UPDATE game_lineups
         SET substituted_at = CURRENT_TIMESTAMP(3), substituted_by = ?
         WHERE game_id = ? AND player_id = ? AND substituted_at IS NULL`,
        [payload.incomingPlayerId, payload.gameId, payload.outgoingPlayerId],
      );

      await connection.query<ResultSetHeader>(
        `INSERT INTO game_lineups (
          game_id,
          team_id,
          player_id,
          roster_id,
          batting_order,
          position,
          defensive_position,
          is_starter,
          is_dp,
          is_flex,
          re_entry_used,
          courtesy_running_for_roster_id
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          payload.gameId,
          outgoingLineup.team_id,
          payload.incomingPlayerId,
          battingOrder,
          lineupPosition,
          defensivePosition,
          outgoingLineup.is_dp,
          outgoingLineup.is_flex,
          outgoingLineup.re_entry_used,
          outgoingLineup.courtesy_running_for_roster_id,
        ],
      );

      await connection.query<ResultSetHeader>(
        `INSERT INTO game_events (
          id,
          game_id,
          event_type,
          inning,
          inning_half,
          batter_player_id,
          pitcher_player_id,
          payload,
          operator_id,
          outs_before,
          score_home,
          score_away
        ) VALUES (?, ?, 'substitution', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          payload.gameId,
          stateBefore.inning,
          stateBefore.inningHalf,
          payload.substitutionType === 'pinch_hitter' ? payload.incomingPlayerId : stateBefore.currentBatterId ?? null,
          shouldSetPitcher ? payload.incomingPlayerId : stateBefore.currentPitcherId ?? null,
          JSON.stringify(eventPayload),
          'live-game-scoring',
          stateBefore.outs,
          stateBefore.score.home,
          stateBefore.score.away,
        ],
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    stateStore.sendCommand(
      lineupRole === 'home' ? 'SetLineupHome' : 'SetLineupAway',
      JSON.stringify(lineupRole === 'home' ? nextLineup.home : nextLineup.away),
    );

    if (payload.substitutionType === 'pinch_hitter') {
      pendingPinchHitters.set(payload.gameId, {
        batterPlayerId: payload.incomingPlayerId,
        substitutionType: 'pinch_hitter',
      });
      stateStore.sendCommand('SetBatter', `playerId:${payload.incomingPlayerId}`);
    }

    if (payload.substitutionType === 'pinch_runner' && payload.base) {
      const responsiblePitcherId = replacedRunner?.responsiblePitcherId ?? stateBefore.currentPitcherId;
      const pinchRunner: RunnerOnBaseWithPitcher = {
        id: payload.incomingPlayerId,
        name: incomingPlayer.name,
        number: Number.parseInt(incomingPlayer.number, 10) || 0,
        originBase: replacedRunner?.originBase ?? payload.base,
        earned: replacedRunner?.earned ?? true,
        ...(responsiblePitcherId ? { responsiblePitcherId } : {}),
      };
      stateStore.sendCommand('SetBase', toSetBaseCommand(payload.base, pinchRunner));
    }

    if (shouldSetPitcher) {
      stateStore.sendCommand('SetPitcher', `playerId:${payload.incomingPlayerId}`);
    }

    response.status(201).json({ ok: true, eventId });
  } catch (error) {
    sendError(response, 400, error);
  }
});

// ─── RESET JUEGO ─────────────────────────────────────────────────────────────
scorerRouter.post('/game/reset', async (_request: Request, response: Response) => {
  try {
    const state = stateStore.getState();
    const gameId = state.gameId;

    if (!pool) {
      sendError(response, 503, 'DB no disponible');
      return;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM at_bats WHERE game_id = ?', [gameId]);
      // operator_actions no tiene game_id, se deja intacto
      await conn.query(
        `UPDATE broadcast_sessions SET state_json = JSON_SET(
          state_json,
          '$.score', JSON_OBJECT('home', 0, 'away', 0),
          '$.inning', 1,
          '$.inningHalf', 'top',
          '$.outs', 0,
          '$.bases', JSON_OBJECT('first', false, 'second', false, 'third', false),
          '$.count', JSON_OBJECT('balls', 0, 'strikes', 0),
          '$.status', 'scheduled',
          '$.currentBatterId', NULL,
          '$.currentPitcherId', NULL
        ) WHERE game_id = ?`,
        [gameId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Reiniciar engine en memoria preservando equipos y lineup
    stateStore.resetGame();

    sendSuccess(response, { message: 'Juego reiniciado correctamente', gameId });
  } catch (error) {
    sendError(response, 500, error);
  }
});
