# Operational database

`schema.sql` is the initial, idempotent operational schema. The tool API applies it at startup in one transaction under an advisory migration lock. PostgreSQL 17 is the Compose default. The control plane owns its separate run and trace tables.

Each domain primary key includes `run_id`, and every relationship references both run and entity ID. Operational credentials are random 256-bit values; only SHA-256 hashes are stored. Actor identity, role, tenant, facility, and deterministic scenario clock are bound to that credential at scope creation. Tool arguments cannot override them.

Inventory reservations lock the scoped stock row and check remaining quantity before decrementing. Mutation deduplication serializes a `(run, actor, tool, key)` tuple with a transaction-scoped advisory lock. The stock change, workflow record, successful audit, and saved idempotency response commit together. Work orders additionally have a unique `(run_id, asset_id)` constraint. A new request key cannot duplicate the same asset workflow.

The private scope seed endpoint accepts technical records, not authorization approvals or employee contact fields. No agent tool grants shutdown approval. The shutdown endpoint requires a supervisor and a separately recorded approved request for the same run and asset.

Run the actual database contract suite against an existing disposable development database:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://lab:lab@localhost:5432/lab'
cd services/tool-api
npm test
```

The suite creates random isolated run IDs and deletes only its own fixtures. Without `TEST_DATABASE_URL`, the real database suite is explicitly skipped and the schema/validation unit tests still run. CI sets the variable and exercises native HTTP requests, authorization denials, transaction replay, stock contention, evidence relationships, and shutdown state transitions against PostgreSQL.
