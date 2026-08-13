# PlayFlow

Sistema de overlays para transmisión de béisbol en vivo del Club Mineros de Santiago.
Es un monorepo basado en pnpm, Turborepo, React, TypeScript, Vite, Express y MySQL.

## Requisitos

- Node.js 20 o superior
- pnpm 9 o superior
- Docker Desktop con Docker Compose
- Python 3, para validar las migraciones MySQL

Comprueba las herramientas:

```bash
node --version
pnpm --version
docker --version
docker compose version
python3 --version
```

Todos los comandos deben ejecutarse desde la raíz del repositorio:

```bash
cd /ruta/al/proyecto/playflow
```

## Preparación del ambiente

El comando recomendado para preparar un ambiente nuevo o existente es:

```bash
pnpm bootstrap
```

El bootstrap es idempotente y verifica herramientas, instala dependencias con el
lockfile, compila Studio y sus dependencias workspace, valida las migraciones,
levanta MySQL, espera el healthcheck y carga los equipos iniciales sin duplicarlos.
No elimina volúmenes ni datos existentes.

## Desarrollo local

```bash
pnpm bootstrap
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

Para iniciar cada proceso por separado:

```bash
pnpm --filter @playflow/studio dev:server
pnpm --filter @playflow/studio dev
```

No ejecutes `dev:full` antes de compilar los paquetes workspace: el backend
importa sus entradas desde `dist/`.

## Usuario SysAdmin y OTP

El usuario inicial se configura con `BOOTSTRAP_SYSADMIN_EMAIL`. En desarrollo,
deja `SMTP_HOST` vacío o comentado en `apps/studio/.env` para ver el código OTP
en el terminal del backend. Si configuras SMTP, el código se envía por correo.

```env
BOOTSTRAP_SYSADMIN_EMAIL=luison@playflow.cl
# SMTP_HOST=
```

Después de cambiar `.env`, reinicia el backend y solicita un código nuevo. Un OTP
verificado se consume y no puede reutilizarse.

## Variables de entorno

El archivo de referencia es [.env.example](.env.example). Para desarrollo local,
`pnpm bootstrap` lo copia automáticamente a `apps/studio/.env` si no existe.

```env
DATABASE_URL=mysql://playflow_app:dev_password@localhost:3306/playflow_db
PORT=3001
NODE_ENV=development
BOOTSTRAP_SYSADMIN_EMAIL=luison@playflow.cl
```

Para producción o staging, configura SMTP con valores reales y nunca incluyas
contraseñas en Git:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASSWORD=...
EMAIL_FROM=no-reply@playflow.app
EMAIL_FROM_NAME=PlayFlow
```

## Base de datos MySQL

```bash
docker compose up -d --wait db
```

Las migraciones de `infra/mysql/migrations/` se ejecutan automáticamente al crear
un volumen MySQL nuevo. El seed nacional está en
[009_seed_national_teams.sql](infra/mysql/migrations/009_seed_national_teams.sql).

Para cargar los equipos manualmente en un volumen existente:

```bash
docker exec -i playflow-db \
	mysql -uplayflow_app -pdev_password playflow_db \
	< infra/mysql/seed-national-teams.sql
```

Equipos iniciales: `team-argentina`, `team-bolivia` y `team-ecuador`.

Verificar la base:

```bash
docker compose ps
docker exec playflow-db mysql -uplayflow_app -pdev_password playflow_db \
	-e "SHOW TABLES;"
```

### Backup y restore

```bash
pnpm db:backup
pnpm db:restore
```

`docker compose down -v` elimina el volumen MySQL. Úsalo solo después de crear un
backup o cuando quieras reinicializar completamente la base:

```bash
docker compose down -v
pnpm bootstrap
```

## Ejecución completa con Docker

Para construir y levantar frontend, backend y MySQL en contenedores:

```bash
pnpm bootstrap
# Edita el .env de la raíz y define SMTP_HOST, SMTP_PASSWORD,
# BOOTSTRAP_SYSADMIN_EMAIL y HOST_PORT.
docker compose up -d --build
```

La aplicación queda disponible en `http://localhost:8080/control` y el healthcheck
en `http://localhost:8080/api/info`.

Docker Compose lee las variables del `.env` de la raíz. El archivo
`apps/studio/.env` se usa para desarrollo local con `dev:full`; no sustituye al
`.env` raíz cuando se ejecuta Docker.

Para detener contenedores sin borrar el volumen:

```bash
docker compose down
```

## Comandos del proyecto

```bash
pnpm bootstrap                                  # prepara ambiente y base de datos
pnpm --filter @playflow/studio dev:full         # backend + frontend
pnpm --filter @playflow/studio dev:server       # solo backend
pnpm --filter @playflow/studio dev              # solo frontend
pnpm turbo build                                # compila todos los paquetes
pnpm --filter @playflow/studio build            # compila Studio
pnpm turbo typecheck                            # verifica tipos
pnpm turbo lint                                 # lint
pnpm turbo test                                 # tests unitarios
pnpm test:e2e                                   # tests Playwright
```

## Rutas principales

| Ruta | Uso |
| --- | --- |
| `/login` | Inicio de sesión |
| `/control` | Panel del operador |
| `/control/admin` | Administración SysAdmin |
| `/live-game-scoring` | Scoring del juego en vivo |
| `/scorer` | Vista del anotador |
| `/broadcast` | Salida de transmisión |
| `/overlay/:overlayId` | Render de un overlay |
| `/settings/mfa` | Configuración MFA |
| `/admin/audit` | Visor de auditoría |
| `/admin/permissions` | Simulador de permisos |

## Tests

```bash
pnpm turbo test
pnpm --filter @playflow/studio test:server
pnpm test:e2e
```

## Estructura principal

```text
apps/studio/              Aplicación web, API Express y WebSocket
packages/core/            Contratos y tipos compartidos
packages/game-engine/     Fuente de verdad del estado deportivo
packages/device-adapters/ Adaptadores de dispositivos y CSV
packages/overlays/        Overlays individuales de transmisión
infra/mysql/migrations/   Esquema, migraciones y seeds iniciales
scripts/bootstrap.sh      Preparación reproducible del ambiente
tests/e2e/                Pruebas end-to-end
docs/requirements/        Especificaciones funcionales
```

## Solución de problemas

### `pnpm: command not found`

```bash
corepack enable
corepack prepare pnpm@9.0.0 --activate
```

### `Cannot find package .../dist/index.js`

Compila las dependencias workspace:

```bash
pnpm bootstrap
```

O manualmente:

```bash
pnpm install
pnpm turbo build --filter=@playflow/studio...
```

### El OTP no aparece en el terminal

Comprueba que `SMTP_HOST` esté vacío o comentado en `apps/studio/.env`, reinicia
el backend y solicita un código nuevo con `BOOTSTRAP_SYSADMIN_EMAIL`.

### El OTP no llega por correo

Comprueba que el `.env` de la raíz tenga `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD` y `EMAIL_FROM`. Después recrea el contenedor de aplicación:

```bash
docker compose up -d --build
docker logs -f playflow-studio
```

Un envío aceptado por SMTP aparece como `OTP aceptado por SMTP` con un
`messageId`. Si aparece esa confirmación pero el correo no llega, revisa el
dashboard de Resend, la carpeta de spam y que el dominio de `EMAIL_FROM` esté
verificado en Resend. Para `noreply@playflow.cl`, el dominio `playflow.cl` debe
estar verificado y sus registros DNS de Resend deben estar publicados.

### MySQL no inicia o falla el healthcheck

```bash
docker logs playflow-db
docker compose ps
```

Si el volumen tiene una inicialización parcial de desarrollo, crea un backup si
corresponde y luego reinicializa:

```bash
pnpm db:backup

pnpm bootstrap
```

## Especificación funcional

La fuente de verdad funcional está en [docs/requirements](docs/requirements/).
Revisa el documento correspondiente antes de modificar un módulo.

## Plan de releases

| Release | Contenido |
| --- | --- |
| v0.1.0 | Design System tokens, Asset Manager y Scorebug |
| v0.2.0 | Game Engine, Layout Manager, Overlay Manager e Integration Contracts |
| v0.3.0 | Batter, Lineup, Next Batters, Pitcher, Substitution y Game Event |
| v0.4.0 | Inning Transition y Final Score |
| v0.5.0 | Sponsor Break, Announcement, Social Lower Third y Countdown |
| v1.0.0 | Overlay Lifecycle, Control Panel y pruebas E2E |

## Operación de modelos

La política activa y el procedimiento de rollback están documentados en
[MODEL_POLICY_ROLLBACK.md](MODEL_POLICY_ROLLBACK.md).
