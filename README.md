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
## Requisitos

- Node.js 20 o superior
- pnpm 9 o superior
- Docker Desktop con Docker Compose
- Python 3, para validar las migraciones MySQL

Comprueba las versiones:

```bash
node --version
pnpm --version
docker --version
docker compose version
python3 --version
```

pnpm turbo test
```

## Build
## Instalación rápida

El comando recomendado para preparar un ambiente nuevo o existente es:

```bash
pnpm bootstrap
```

El bootstrap es idempotente y realiza lo siguiente:

1. Verifica Node.js, pnpm, Docker y Docker Compose.
2. Crea `apps/studio/.env` desde `.env.example` si todavía no existe.
3. Instala dependencias usando `pnpm-lock.yaml`.
4. Compila Studio y todos sus paquetes workspace dependientes.
5. Valida las migraciones contra las reglas de MySQL 8.
6. Levanta MySQL y espera a que el healthcheck sea saludable.
7. Carga los equipos iniciales sin duplicarlos.

El script no ejecuta `docker compose down -v` y no elimina volúmenes ni datos existentes.


```bash
pnpm turbo build
```
## Desarrollo local

Después de ejecutar el bootstrap, levanta backend y frontend juntos:

```bash
pnpm --filter @playflow/studio dev:full
```

Servicios disponibles:

| Servicio | URL |
| --- | --- |
| Frontend Vite | `http://localhost:5173/` |
| Panel del operador | `http://localhost:5173/control` |
| Anotación en vivo | `http://localhost:5173/live-game-scoring` |
| Scorer | `http://localhost:5173/scorer` |
| Salida de transmisión | `http://localhost:5173/broadcast` |
| API y WebSocket | `http://localhost:3001` |
| Health/info de API | `http://localhost:3001/api/info` |
| MySQL | `localhost:3306` |

También puedes iniciar cada proceso por separado:

```bash
# Terminal 1: backend Express + WebSocket
pnpm --filter @playflow/studio dev:server

# Terminal 2: frontend Vite
pnpm --filter @playflow/studio dev
```

No ejecutes `dev:full` antes de `pnpm bootstrap`: el backend importa los paquetes
workspace desde sus directorios `dist/` compilados.


## Especificacion funcional

La fuente de verdad del sistema vive en `docs/requirements/`. Revisar esos documentos antes de implementar cualquier modulo del monorepo.
## Tests

Tests unitarios de todo el monorepo:

```bash
pnpm turbo test
```

Tests específicos del servidor Studio:

```bash
pnpm --filter @playflow/studio test:server
```

Tests E2E:

```bash
pnpm test:e2e
```


## Operación de modelos (Squad)

Referencia persistente para política activa y rollback:
## Ejecución completa con Docker

Para construir y levantar frontend, backend y MySQL en contenedores:

```bash
cp .env.example .env
docker compose up -d --build
```

Antes de iniciar en otro ambiente, edita `.env` y define al menos:

```env
BOOTSTRAP_SYSADMIN_EMAIL=admin@example.com
HOST_PORT=8080
```

La aplicación completa queda disponible en:

```text
http://localhost:8080/control
```

El healthcheck del contenedor usa:

```text
http://localhost:8080/api/info
```

Detener contenedores sin borrar el volumen:

```bash
docker compose down
```


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
