# Contributing

Use Node.js 24, Python 3.13 or 3.14, and PostgreSQL 17. The README describes native and Compose workflows. Commit source, lockfiles, scenario specifications and documentation; keep `.env`, local database files, dependencies and generated test artifacts out of version control.

For a tool change, update its strict argument schema, authorization and relationship checks, response projection, TypeScript database contracts and Python response validator together. A mutation must keep its state changes, idempotency record and success audit in one transaction. Add a meaningful regression test for the boundary being changed.

For a scenario, assign unique evidence IDs, a fixed UTC clock and an isolated seed. Keep expected outcomes in the trusted specification. The agent-facing context must not contain faults or grader expectations. Check normalized units, sensor validity, effective manual dates and scoped technician/part relationships before declaring the reference outcome. Define rubric groups explicitly; their positive weights must total 100.

Run `npm run build`, the TypeScript tests with `TEST_DATABASE_URL`, and `python -m pytest` with `LAB_INTEGRATION=1`. Run the Playwright review flow after console or public API changes. Label deterministic policy runs separately from live-model evaluations in reports and documentation.

If a change alters scoring, explain the affected assertion and why its expected behavior follows from the scenario. Retain meaningful partial credit. Golden-tool sequence changes must not penalize an otherwise valid alternative ordering.
