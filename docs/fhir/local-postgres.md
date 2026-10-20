# Local FHIR PostgreSQL

This adds a dedicated PostgreSQL instance for future HAPI FHIR modeling.
It does not start HAPI FHIR or a mapping service and does not copy CHS patient data.

## Isolation and connection settings

| Setting | Value |
| --- | --- |
| Compose file | `compose.fhir.yaml` |
| Compose project | `chs-fhir` |
| Service | `fhir-pgsql` |
| Expected container | `chs-fhir-fhir-pgsql-1` |
| Image | `postgres:18-alpine` |
| Host connection | `127.0.0.1:5434` |
| Connection within this Compose network | `fhir-pgsql:5432` |
| Database | `hapi_fhir` |
| User | `fhir` |
| Password | Generated locally in `.local-fhir/postgres.env` |
| Persistent volume | `chs-fhir_fhir-postgres-data` |

The default CHS operations Compose file, operations database on port 5432,
Keycloak on port 18080, and desktop synchronization remain unchanged. Port 5434
also avoids the church application's existing port 5433 assignment.
The new project has its own default Docker network and named volume.

PostgreSQL 18 uses the `/var/lib/postgresql` volume mount; do not substitute
the older `/var/lib/postgresql/data` mount. The major version is fixed at 18,
while the image tag allows PostgreSQL patch updates.

## Start from Windows Git Bash

Run from your `E:/health-app/CHS-web` checkout with Docker Desktop running:

```bash
pnpm local:fhir:setup
docker compose -p chs-fhir -f compose.fhir.yaml config --quiet
pnpm local:fhir:up
pnpm local:fhir:status
docker compose -p chs-fhir -f compose.fhir.yaml exec -T fhir-pgsql psql -U fhir -d hapi_fhir -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user;'
```

Expect a healthy container under a new **chs-fhir** group in Docker Desktop,
and a query result containing database `hapi_fhir` and user `fhir`.
The startup command waits up to 120 seconds for database health after pulling
the image. This is a SQL endpoint, not a browser page or a FHIR API yet.

The setup script creates a random password without displaying it and never
overwrites an existing credentials file. It does not edit the operations `.env`.
For a SQL client, read the password locally from the generated file; do not
commit or share it. Use `config --quiet` rather than sharing expanded Compose
configuration, which can expose environment values.

## Stop and restart without deleting data

```bash
pnpm local:fhir:stop
pnpm local:fhir:up
```

The named volume retains data across stops, restarts, and container recreation.
Do not run `down --volumes` or delete the volume unless you intend to discard
this FHIR database. Keep `.local-fhir/postgres.env` with the local installation:
generating a different password does not change an already initialized database.
PostgreSQL initialization settings take effect only for an empty data directory.

If host port 5434 is occupied, change only the host port in `compose.fhir.yaml`.
Keep the `127.0.0.1` binding and the container port 5432. Commands in this guide
explicitly select the new Compose project and file; do not combine this file
with `compose.yaml` or `compose.local-auth.yaml`.

## Next integration step

Add HAPI FHIR to this project's network, connected to
`jdbc:postgresql://fhir-pgsql:5432/hapi_fhir`. HAPI will manage its own database
schema. Do not run the CHS operations migrations against this database.
The eventual mapping service will submit resources through HAPI's FHIR API.
The generated database role is for local development; deployment credentials
and access controls will be configured separately.

## References

- [Official PostgreSQL Docker image: initialization and PostgreSQL 18 storage](https://hub.docker.com/_/postgres)
- [HAPI FHIR PostgreSQL support and required dialect](https://hapifhir.io/hapi-fhir/docs/server_jpa/database_support.html)
- [Docker Compose project names](https://docs.docker.com/compose/how-tos/project-name/)
