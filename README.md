# Mineros Broadcast

Monorepo del sistema de overlays para transmision de beisbol en vivo del Club Mineros de Santiago. Incluye contratos compartidos, paquetes base, overlays y aplicaciones para operacion y salida al aire.

## Prerrequisitos

- Node.js 20+
- pnpm 9+

## Instalacion

```bash
pnpm install
```

## Desarrollo

```bash
pnpm turbo dev
```

## Preparar un ambiente desde cero

Desde la raiz del repositorio, ejecuta:

```bash
pnpm bootstrap
pnpm --filter @playflow/studio dev:full
```

`pnpm bootstrap` instala las dependencias con el lockfile, valida las migraciones,
levanta MySQL, espera a que este saludable y carga los equipos iniciales de forma
idempotente. No elimina volumenes ni datos existentes.

Para ejecutar la aplicacion completa en Docker:

```bash
docker compose up -d --build
```

La interfaz queda disponible en `http://localhost:8080/control`.

## Tests

```bash
pnpm turbo test
```

## Build

```bash
pnpm turbo build
```

## Especificacion funcional

La fuente de verdad del sistema vive en `docs/requirements/`. Revisar esos documentos antes de implementar cualquier modulo del monorepo.

## Operación de modelos (Squad)

Referencia persistente para política activa y rollback:

- `MODEL_POLICY_ROLLBACK.md`

## Plan de releases

| Release | Contenido |
| --- | --- |
| v0.1.0 | Design System tokens + Asset Manager + Scorebug |
| v0.2.0 | Game Engine + Layout Manager + Overlay Manager + Integration Contracts |
| v0.3.0 | Batter, Lineup, Next Batters, Pitcher, Substitution, Game Event overlays |
| v0.4.0 | Inning Transition, Final Score |
| v0.5.0 | Sponsor Break, Announcement, Social Lower Third, Countdown |
| v1.0.0 | Overlay Lifecycle, Control Panel, QA Acceptance Checklist, e2e tests |
