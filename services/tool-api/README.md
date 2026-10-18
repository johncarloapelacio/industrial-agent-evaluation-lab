# Operational tool API

The Express/TypeScript service exposes nine maintenance tools backed by real PostgreSQL. The agent receives HTTP results; it never receives a database connection. See [database guarantees](../../database/README.md), the [architecture](../../docs/architecture.md), and the [threat model](../../docs/threat-model.md).

## Run locally

From the repository root, start PostgreSQL and install dependencies:

```sh
docker compose up -d --wait postgres
npm --prefix services/tool-api ci
npm --prefix services/tool-api run build
npm --prefix services/tool-api start
```

The service defaults to `http://127.0.0.1:3001`. `npm --prefix services/tool-api run dev` runs the source with reload. Stop Compose's `tools` container before starting a native process on the same port.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://lab:lab@localhost:5432/lab` | PostgreSQL connection |
| `LAB_INTERNAL_KEY` | `local-internal-key` | Protect scope creation and snapshots |
| `HOST` | `127.0.0.1` | Native bind address; Docker supplies `0.0.0.0` inside its container |
| `PORT` | `3001` | Listening port |
| `SCHEMA_PATH` | Repository `database/schema.sql` | Optional migration-file override |

Native processes read environment variables directly; they do not automatically load the root `.env`. Startup applies the idempotent schema transactionally under a migration lock. `GET /health` checks the database connection and returns 503 when it is unavailable.

## Tool contract

Call `POST /tools/:name` with `Authorization: Bearer <run-token>`, `X-Run-Id`, and an optional `X-Correlation-Id`. Invalid correlation IDs or IDs containing recognizable private text are replaced with a fresh UUID before they are returned or audited. Mutations require an `Idempotency-Key` of 1–128 letters, digits, dots, underscores, colons or hyphens. Reuse that key and identical arguments when recovering an uncertain response.

| Tool | Arguments | Permission |
| --- | --- | --- |
| `get_asset` | `asset_id` | Scoped reader |
| `query_telemetry` | `asset_id` | Scoped reader |
| `get_manual_revision` | `asset_id` | Scoped reader |
| `search_inventory` | `part_id` | Scoped reader |
| `list_technicians` | `asset_id`, optional `certification` | Scoped reader |
| `reserve_part` | `asset_id`, `part_id`, positive integer `quantity` | Technician or supervisor |
| `create_work_order` | `asset_id`, `title`, `priority`, `evidence_ids`; optional `reservation_id`, `technician_id` | Technician or supervisor |
| `request_supervisor_approval` | `asset_id`, `reason` | Technician or supervisor |
| `set_asset_status` | `asset_id`, `status: "offline"`, `approval_id` | Supervisor with approved same-run, same-asset authorization |

Success has the shape `{"data": {...}}`, with 200 for reads and 201 for mutations. Errors have the shape `{"error":{"code":"...","message":"..."}}`. Common statuses are 400 for malformed URL or compressed-body encoding, 401 for invalid credentials, 403 for role/run/approval denials, 404 for unavailable resources, 409 for stock/idempotency/workflow conflicts, 415 for unsupported request encoding, and 422 for invalid JSON, arguments or relationships. An inventory search returns an empty collection when a matching part is outside scope. Successful idempotency replays return the original response and `Idempotency-Replayed: true`.

The credential binds run, actor, role, facility and tenant server-side. Strict schemas reject identity overrides and extra fields. Asset access, reservation relationships, technician availability/certification, and evidence references are checked independently of agent instructions. Work orders remain drafts; `priority` is `normal` or `urgent`. Work-order titles and approval reasons containing recognized email, phone or bearer-credential patterns are rejected with 422 `SENSITIVE_CONTENT` before persistence. Evidence must belong to the asset/run and cannot reference a future observation or an unapproved or not-yet-effective manual. The evaluator separately checks freshness, the current revision, component choice and final workflow correctness.

`get_manual_revision` returns competing revisions, and telemetry can include stale or invalid sensors. These are investigation evidence. Their presence does not authorize an action or establish which record the agent should use.

Operational responses preserve complete validated collections and technical text while redacting configured sensitive content. Audit summaries separately bound collection and text length. PostgreSQL timestamps are serialized as ISO strings with microseconds preserved. Seed timestamps allow up to six fractional digits; greater precision is rejected rather than rounded. UUID arguments are canonicalized before idempotency fingerprints are calculated.

## Trusted internal interface

`POST /internal/scopes`, authenticated with `X-Internal-Key`, accepts `run_id` and the trusted scenario specification. It atomically seeds one scope and returns a new random credential plus actor context. Invalid database values or duplicate seed records return 422 with no partial scope; an existing run ID returns 409. Only the credential hash is stored. `GET /internal/scopes/:run_id/snapshot`, protected by the same key, returns the synthetic domain state and audit records for evaluation. These routes must remain outside the agent's tool surface.

The seed accepts technical records rather than approved shutdown permits or employee contacts. No exposed tool grants approval. Authenticated tool requests, including schema, role and scope denials, are audited with sanitized arguments/results. Unknown or unauthenticated credentials cannot be attributed to a run and do not create per-run audit records. Successful mutations, idempotency records and their audit commit together.

## Verification and bounds

Use Node.js 24 and PostgreSQL 17. From the repository root in PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://lab:lab@127.0.0.1:5432/lab'
npm --prefix services/tool-api test
```

The verified suite contains 63 tests: 23 validation/redaction tests and 40 native HTTP/PostgreSQL contracts. Database contracts run an ephemeral HTTP listener against the configured real database, create UUID-scoped fixtures and delete only their own fixture rows. They cover scope, permissions, atomic retries, stock contention, relationships, privacy-safe writes, complete evidence delivery, correlation preservation, malformed requests, atomic seed rejection, timestamp precision, UUID aliases, Unicode validation and idle-connection recovery. Without `TEST_DATABASE_URL`, those 40 tests explicitly skip.

The API bounds JSON bodies to 2 MiB, reservation quantity to 10,000, key length to 128 characters, transactional lock waits to five seconds, and tool statements to ten seconds. Sanitization is a bounded heuristic for configured fields and recognizable secrets/contact text. This service does not provide production identity, TLS, PostgreSQL row-level security, rate limiting, durable unauthenticated-request logging, or automatic retention. Default credentials support the local synthetic demonstration only.
