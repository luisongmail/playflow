# Copilot Instructions — PlayFlow

**Sistema de overlays para transmisión de béisbol en vivo (PlayFlow) — Club Mineros de Santiago**  
Stack: Turborepo + pnpm | React + TypeScript + Vite + Tailwind | Supabase + Vercel | Vitest + Playwright

## Estructura del monorepo

```
packages/core/              → Contratos IC-003, tipos, envelopes (fuente: 09-integration-contracts.md)
packages/design-system/     → Tokens visuales y componentes base (fuente: 02-design-system.md)
packages/asset-manager/     → Motor de assets, fuente única de verdad visual (fuente: 03-asset-manager.md)
packages/game-engine/       → Motor deportivo, fuente única de verdad deportiva (fuente: 04-game-engine.md)
packages/sponsor-engine/    → Reglas comerciales (fuente: 05-sponsor-engine.md)
packages/event-engine/      → Transforma eventos deportivos en acciones (fuente: 06-event-engine.md)
packages/scene-engine/      → Gestión de escenas de transmisión (fuente: 07-scene-engine.md)
packages/overlay-manager/   → Orquestador de renders (fuente: 08-overlay-manager.md)
packages/layout-manager/    → Orquestador visual — zonas, Preview/Program (fuente: 01-layout-manager.md)
packages/overlays/{name}/   → Overlays individuales (fuentes: 10-22)
apps/studio/                → Browser Source + panel del operador real en `/control` (fuente: 24)
infra/supabase/             → Migraciones PostgreSQL + seed
docs/requirements/          → Especificaciones funcionales vigentes (NO modificar sin aprobación explícita)
```

## Documentos de requerimientos (`docs/requirements/`)

Antes de implementar cualquier módulo, leer el documento correspondiente. Son la fuente de verdad del sistema.

| Archivo | Módulo | Estado |
|---------|--------|--------|
| `00-master-index.md` | Índice maestro + principios del sistema | APROBADO |
| `01-layout-manager.md` | Layout Manager — zonas, Preview/Program, perfiles | CERRADO |
| `02-design-system.md` | Design System — paleta, tipografías, grid, safe area | CERRADO |
| `03-asset-manager.md` | Asset Manager — flujo de vida, metadata, assetId | CERRADO |
| `04-game-engine.md` | Game Engine — estado deportivo, comandos, eventos, auditoría | CERRADO |
| `05-sponsor-engine.md` | Sponsor Engine — campañas, placements, vigencias | CERRADO |
| `06-event-engine.md` | Event Engine — eventos → acciones visuales/comerciales | CERRADO |
| `07-scene-engine.md` | Scene Engine — catálogo de escenas, transiciones | CERRADO |
| `08-overlay-manager.md` | Overlay Manager — contrato de render, estados | CERRADO |
| `09-integration-contracts.md` | Contratos de integración — envelope IC-003, tipos de mensaje | CERRADO |
| `10-scorebug.md` | Overlay Scorebug — marcador permanente | CERRADO |
| `11-batter-overlay.md` | Overlay Bateador | CERRADO |
| `12-lineup.md` | Overlay Lineup | CERRADO |
| `13-next-batters.md` | Overlay Próximos Bateadores | CERRADO |
| `14-pitcher-overlay.md` | Overlay Pitcher | CERRADO |
| `15-substitution-overlay.md` | Overlay Sustitución | CERRADO |
| `16-game-event-overlay.md` | Overlay Evento de Juego | CERRADO |
| `17-inning-transition.md` | Overlay Transición de Entrada | CERRADO |
| `18-final-score-overlay.md` | Overlay Marcador Final | CERRADO |
| `19-sponsor-break-overlay.md` | Overlay Pausa Comercial | CERRADO |
| `20-announcement-overlay.md` | Overlay Anuncio | CERRADO |
| `21-social-lower-third.md` | Overlay Lower Third Social | CERRADO |
| `22-countdown-overlay.md` | Overlay Cuenta Regresiva | CERRADO |
| `23-overlay-lifecycle.md` | Ciclo de vida de overlays | CERRADO |
| `24-operator-control-panel.md` | Panel del Operador — acciones, roles, reglas de seguridad | CERRADO |
| `25-qa-acceptance-checklist.md` | Checklist de aceptación QA | CERRADO |
| `26-master-package-index.md` | Índice final del paquete + orden de implementación | CERRADO |
| `27-live-game-scoring-assets.md` | Assets y flujos de live scoring | ACTIVO |
| `28-baserunning-events.md` | Eventos de corrido de bases | ACTIVO |
| `29-professional-data-standards.md` | Estándares profesionales de datos y métricas | ACTIVO |
| `30-security-access-control-audit.md` | Seguridad, control de acceso y auditoría | ACTIVO |
| `31-Refactor - COMPLETE.md` | Estado consolidado del refactor | REFERENCIA |
```

## Comandos

```bash
pnpm install              # instalar dependencias
pnpm turbo build          # compilar todos los paquetes
pnpm turbo test           # tests unitarios (Vitest)
pnpm turbo lint           # lint
pnpm turbo typecheck      # type check
pnpm turbo dev            # modo desarrollo
pnpm changeset            # crear changeset para release semántico
```

## Regla de calidad obligatoria (no negociable)

- **No implementar sin prueba primero:** antes de cambiar código, agregar/ajustar pruebas que reproduzcan el caso real reportado.
- **No ocultar errores:** no usar fallbacks silenciosos para “pasar”; exponer causa raíz con código de error explícito y mensaje accionable.
- **Cierre de tarea:** no se considera resuelto hasta que la prueba nueva falle antes del fix y pase después del fix.

## Protocolo operativo de sesiones (resiliente a reinicios)

- **Un objetivo por sesión/bloque:** no mezclar fixes no relacionados en el mismo ciclo.
- **Contexto mínimo útil:** error real, archivos objetivo y criterio de cierre explícito.
- **Límite de iteración:** máximo 2 intentos por enfoque; si falla, escalar modelo/estrategia.
- **Validación mínima obligatoria:** prueba real del endpoint/flujo tocado + typecheck del alcance.
- **Cierre estricto:** entregar resultado, dejar estado limpio y abrir siguiente bloque en sesión nueva.
- **Control de costo:** evitar paralelismo innecesario; usar agentes/modelos caros solo en tareas críticas.

## Arquitectura — principios clave

- **Fuente única de verdad deportiva:** Game Engine. Ningún overlay calcula marcador, inning, outs, bases ni conteo.
- **Fuente única de verdad visual:** Asset Manager. Todos los recursos se consumen por `assetId`, nunca por ruta local.
- **Contratos explícitos:** Todo mensaje entre componentes usa el envelope estándar `IC-003`: campos obligatorios `schemaVersion`, `messageType`, `correlationId`, `source`, `target`, `timestamp`, `payload`. Ver `packages/core/src/index.ts`.
- **Flujo visual:** `hidden` → `preview` → (Take) → `live`. Nunca saltar Preview a Program.
- **Canvas:** 1920×1080, Grid 24×12, Safe Area 60px.
- **Overlays independientes:** componentes aislados que consumen datos, no los calculan ni los almacenan.
- **Toda corrección manual se audita** (GE-017): operador, comando, estado anterior, estado nuevo, motivo.

## Design tokens (02-design-system.md)

| Token | Valor |
|-------|-------|
| Mineros Red | `#D71920` |
| Mineros Navy | `#1B2F5B` |
| Mineros Gold | `#D4AF37` |
| Broadcast Black | `#0D0D0D` |
| Tipografía principal | Bebas Neue |
| Tipografía secundaria | Inter / fallback Arial |
| Espaciado base | 4px (escala: 4,8,12,16,24,32,48,64) |
| Bordes | 6px (componentes), 4px (badges), 8px (full screen) |
| Sombra | `0px 2px 8px rgba(0,0,0,.25)` |

## Plan de releases semántico

| Release | Contenido |
|---------|-----------|
| v0.1.0 | Design System tokens + Asset Manager + Scorebug |
| v0.2.0 | Game Engine + Layout Manager + Overlay Manager + Integration Contracts |
| v0.3.0 | Batter, Lineup, Next Batters, Pitcher, Substitution, Game Event overlays |
| v0.4.0 | Inning Transition, Final Score |
| v0.5.0 | Sponsor Break, Announcement, Social Lower Third, Countdown |
| v1.0.0 | Overlay Lifecycle, Control Panel, QA Acceptance Checklist, e2e tests |

## Squad AI Team

This repo uses **Squad** (`create-squad`) to manage an AI agent team. The coordinator lives at `.github/agents/squad.agent.md`. Team roster, routing rules, and decisions are tracked under `.squad/`.

- **Trigger Squad** by talking to the coordinator: _"Squad, build X"_ or _"{AgentName}, fix Y"_
- **Team state files** (`.squad/decisions.md`, `.squad/agents/*/history.md`) are append-only — never rewrite or reorder entries
- **Shared decisions** go to `.squad/decisions/inbox/{agent}-{slug}.md` (drop-box pattern) — Scribe merges them into `decisions.md`
- **Ceremonies** are defined in `.squad/ceremonies.md` — a Design Review runs automatically before any multi-agent task involving 2+ agents on shared systems

## Git Workflow

All feature work branches from `develop`, not `main`.

| Branch | Purpose |
|--------|---------|
| `main` | Stable released code only |
| `develop` | Integration — all feature work lands here |

**Branch naming (estándar):** `dev/yyyy/mm/dd/{kebab-slug}` — e.g. `dev/2026/06/30/admin-sessions-pagination`

```bash
# Start issue work
git checkout develop && git pull origin develop
git checkout -b dev/{yyyy}/{mm}/{dd}/{slug}

# Open draft PR targeting develop
gh pr create --base develop --title "{description}" --body "Closes #{number}" --draft

# After merge cleanup
git checkout develop && git pull origin develop
git branch -d dev/{yyyy}/{mm}/{dd}/{slug}
git push origin --delete dev/{yyyy}/{mm}/{dd}/{slug}
```

**Never** branch from `main`, target `main` directly in a PR, or commit directly to `main`/`develop`.

**Parallel issues:** Use `git worktree` (one worktree per issue) rather than branch-switching. Name worktrees `../{repo-name}-{issue-number}`.

## Reviewer Rejection — Strict Lockout

When a reviewer rejects work, the original author is **locked out** of that artifact — they cannot self-revise, advise, or co-author the fix. A different agent must own the revision. Lockout persists through the full revision cycle; if all eligible agents are locked out, escalate to the user.

## MCP State Bridge

The `squad_state` MCP server provides `squad_state_read/write/append/delete/list` tools for agents to persist state without hand-rolling git commits. Configured in `.copilot/mcp-config.json`. Agents must use these tools for mutable `.squad/` state — they must not switch branches or commit squad state directly.

<!-- mermaid-ai-skills:start -->
## Mermaid Diagrams

When the user asks to create, edit, or visualize a diagram, follow the
instructions in `.github/instructions/mermaid.instructions.md`.
<!-- mermaid-ai-skills:end -->
