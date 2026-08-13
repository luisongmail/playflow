import crypto from 'node:crypto';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool } from '../db';

const REFRESH_TOKEN_DAYS = Number(process.env.JWT_REFRESH_TOKEN_DAYS ?? 30);
const COOKIE_NAME = 'pf_refresh';

export { COOKIE_NAME as REFRESH_COOKIE_NAME };

function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email: string;
}

/** Crea sesión + refresh token. Devuelve el token opaco (para enviar en cookie). */
export async function createSession(
  userId: string,
  ip: string,
  userAgent: string,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = `sess_${crypto.randomBytes(15).toString('hex')}`;
  const refreshToken = generateOpaqueToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000);

  if (!pool) {
    // Dev sin DB
    return { sessionId, refreshToken };
  }

  const conn = await pool.getConnection();
  try {
    await conn.execute<ResultSetHeader>(
      `INSERT INTO sessions (session_id, user_id, created_at, last_seen_at, ip, user_agent_hash, status)
       VALUES (?, ?, NOW(), NOW(), ?, ?, 'active')`,
      [sessionId, userId, ip, hashToken(userAgent)],
    );

    await conn.execute<ResultSetHeader>(
      `INSERT INTO refresh_tokens (token_id, session_id, user_id, token_hash, expires_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [`rt_${crypto.randomUUID().replace(/-/g, '')}`, sessionId, userId, tokenHash, expiresAt],
    );
  } finally {
    conn.release();
  }

  return { sessionId, refreshToken };
}

export type RefreshResult =
  | { ok: true; sessionId: string; userId: string; newRefreshToken: string }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'reuse_detected' };

/** Rota el refresh token. Detecta reuso y revoca todas las sesiones del usuario si ocurre. */
export async function rotateRefreshToken(incomingToken: string): Promise<RefreshResult> {
  if (!pool) {
    return { ok: false, reason: 'expired' };
  }

  const tokenHash = hashToken(incomingToken);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT token_id, session_id, user_id, status, expires_at, replaced_by_token_id
       FROM refresh_tokens WHERE token_hash = ?`,
      [tokenHash],
    );

    if (rows.length === 0) return { ok: false, reason: 'expired' };

    const rt = rows[0];

    // Si ya fue rotado → reuso detectado → revocar todas las sesiones del usuario
    if (rt.replaced_by_token_id || rt.status === 'rotated') {
      await conn.execute(
        `UPDATE sessions SET status = 'revoked' WHERE user_id = ? AND status = 'active'`,
        [rt.user_id],
      );
      await conn.execute(
        `UPDATE refresh_tokens SET status = 'revoked' WHERE user_id = ? AND status IN ('active','rotated')`,
        [rt.user_id],
      );
      await recordSecurityEvent(conn, rt.user_id as string, 'refresh_token_reuse', 'critical');
      return { ok: false, reason: 'reuse_detected' };
    }

    if (rt.status !== 'active') return { ok: false, reason: 'expired' };
    if (new Date(rt.expires_at as string) < new Date()) {
      await conn.execute(`UPDATE refresh_tokens SET status = 'expired' WHERE token_id = ?`, [rt.token_id]);
      return { ok: false, reason: 'expired' };
    }

    // Emitir nuevo token
    const newToken = generateOpaqueToken();
    const newHash = hashToken(newToken);
    const newExpires = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86_400_000);
    const newTokenId = `rt_${crypto.randomUUID().replace(/-/g, '')}`;

    await conn.execute(
      `INSERT INTO refresh_tokens (token_id, session_id, user_id, token_hash, expires_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [newTokenId, rt.session_id, rt.user_id, newHash, newExpires],
    );

    // Marcar el anterior como rotado, apuntando al nuevo
    await conn.execute(
      `UPDATE refresh_tokens SET status = 'rotated', replaced_by_token_id = ? WHERE token_id = ?`,
      [newTokenId, rt.token_id],
    );

    // Actualizar last_seen_at de la sesión
    await conn.execute(
      `UPDATE sessions SET last_seen_at = NOW() WHERE session_id = ? AND status = 'active'`,
      [rt.session_id],
    );

    return { ok: true, sessionId: rt.session_id as string, userId: rt.user_id as string, newRefreshToken: newToken };
  } finally {
    conn.release();
  }
}

/** Revoca la sesión y su refresh token activo */
export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  if (!pool) return;
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE sessions SET status = 'revoked', revoked_at = NOW() WHERE session_id = ? AND user_id = ?`,
      [sessionId, userId],
    );
    await conn.execute(
      `UPDATE refresh_tokens SET status = 'revoked' WHERE session_id = ? AND status = 'active'`,
      [sessionId],
    );
  } finally {
    conn.release();
  }
}

async function recordSecurityEvent(
  conn: Awaited<ReturnType<NonNullable<typeof pool>['getConnection']>>,
  userId: string,
  eventType: string,
  severity: string,
): Promise<void> {
  try {
    await conn.execute(
      `INSERT INTO security_events (event_type, severity, user_id) VALUES (?, ?, ?)`,
      [eventType, severity, userId],
    );
  } catch {
    // No bloquear el flujo principal por un fallo en el event log
  }
}

export function buildRefreshCookie(token: string): string {
  const maxAge = REFRESH_TOKEN_DAYS * 86_400;
  const secure = process.env.COOKIE_SECURE !== 'false';
  const sameSite = process.env.COOKIE_SAME_SITE ?? 'Strict';

  return [
    `${COOKIE_NAME}=${token}`,
    `HttpOnly`,
    secure ? `Secure` : '',
    `SameSite=${sameSite}`,
    `Path=/api/auth/token/refresh`,
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/token/refresh; Max-Age=0`;
}
