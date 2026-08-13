#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[bootstrap] %s\n' "$1"
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 20+ es requerido.'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm 9+ es requerido.'
command -v docker >/dev/null 2>&1 || fail 'Docker es requerido.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose no esta disponible.'

node_major="$(node -p 'process.versions.node.split(".")[0]')"
pnpm_major="$(pnpm --version | cut -d. -f1)"
(( node_major >= 20 )) || fail "Node.js 20+ requerido; encontrado: $(node --version)"
(( pnpm_major >= 9 )) || fail "pnpm 9+ requerido; encontrado: $(pnpm --version)"

if [[ ! -f apps/studio/.env ]]; then
  [[ -f .env.example ]] || fail 'No existe .env.example para crear la configuracion local.'
  cp .env.example apps/studio/.env
  log 'Creado apps/studio/.env desde .env.example.'
else
  log 'apps/studio/.env ya existe; se conserva la configuracion actual.'
fi

log 'Instalando dependencias con pnpm-lock.yaml.'
pnpm install --frozen-lockfile

log 'Compilando Studio y sus paquetes workspace dependientes.'
pnpm turbo build --filter=@playflow/studio...

log 'Validando migraciones MySQL 8.'
python3 infra/mysql/lint-migrations.sh

log 'Levantando MySQL y esperando el healthcheck.'
docker compose up -d --wait db

log 'Cargando equipos iniciales de forma idempotente.'
docker exec -i playflow-db mysql -uplayflow_app -pdev_password playflow_db < infra/mysql/seed-national-teams.sql

log 'Bootstrap completado. Inicia la aplicacion con: pnpm --filter @playflow/studio dev:full'
log 'Vista principal: http://localhost:5173/control'
