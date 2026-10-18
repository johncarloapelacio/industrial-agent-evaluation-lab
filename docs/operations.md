# Running and maintaining the lab

The supported demonstration topology is one control-plane worker, one tool API, one review console and one PostgreSQL server. Docker Compose publishes each service only on loopback. The source API documentation remains available on port 8000 for local inspection; the console proxies `/api` to that service.

## Data and lifecycle

Each execution creates a random UUID scope with separately seeded domain rows and a random bearer credential. Only a hash of that credential is stored by the operational API. The provider never receives it in conversational context; the transport adds it to HTTP requests. Replay uses the stored scenario snapshot and a new scope, so later fixture edits do not silently change a replay's inputs.

`lab_runs` stores sanitized review documents. `operations.*` stores domain state, idempotent mutation responses and audits. Containers are disposable; the `lab-data` volume preserves PostgreSQL state. `docker compose stop` stops without removing that data. Run history lists the most recent 200 evaluations; older runs remain available by ID through the review API. There is no automatic retention deletion in this release. Keep exported reports only as long as your local evaluation purpose requires.

For a local backup, run `docker compose exec -T postgres pg_dump -U lab lab` and redirect its output using your shell to a protected file. Restore only into an appropriate isolated PostgreSQL database. Adjust database/user arguments if you changed the defaults. Never add backups or `.env` to version control.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Native-service PostgreSQL connection string; Compose supplies an internal service hostname |
| `LAB_INTERNAL_KEY` | Internal seed/snapshot service credential; not given to the agent or browser |
| `LAB_REVIEW_KEY` | Reviewer bearer token required to execute, replay or reevaluate runs |
| `TOOL_API_URL` | Native control plane's operational service origin |
| `LAB_SEED_DEMO` | `1` seeds three actual runs only when the run store is empty |
| `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY` | Optional compatible provider configuration |
| `MODEL_MAX_STEPS` | Optional provider turn limit, capped at 40 |

The console's reviewer setting stores a token for the current browser session. It is a local demonstration convenience. Agent calls cannot use the reviewer key or internal key through the operational tools. Read-only review endpoints are intentionally available without authentication on localhost. A deployment with multiple reviewers needs authenticated read access and ownership rules.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `docker` command unavailable after Windows installation | Open a new terminal so it receives Docker's updated PATH |
| Docker cannot start its engine | Start Docker Desktop; complete WSL 2 setup and any requested Windows restart |
| Port already allocated | Stop a native service or another local application using 5432, 3001, 8000 or 8080 |
| Console shows services unavailable | Inspect `docker compose ps` and `docker compose logs control tools postgres` |
| New evaluation returns 401 | Match the console reviewer setting to the server's `LAB_REVIEW_KEY` |
| Optional live run stops immediately | Configure a reachable compatible origin and model; inspect validation events, without sharing secrets |
| Baseline unexpectedly fails after a change | Inspect response-contract events, selected evidence, final state and exact failed assertions; run the real integration suite |

Do not solve an authorization failure by adding identity fields to tool arguments. The server binds identity to the run credential and rejects mass assignment. Do not retry a mutation with a new idempotency key merely because its response was lost.

## Demo watch page

The public [watch page](https://johncarloapelacio.github.io/industrial-agent-evaluation-lab/) plays the recorded demo in the browser and keeps a separate MP4 download link. The interactive lab runs locally through Compose.

Run `python scripts/build_demo_site.py` to stage the page, stylesheet, poster and unchanged video in `artifacts/local/demo-site/`. The build verifies the video's recorded checksum. To preview it locally, run `python -m http.server 8095 --bind 127.0.0.1 --directory artifacts/local/demo-site` and open http://127.0.0.1:8095.

The `demo-pages.yml` workflow publishes those four public files to GitHub Pages when the page or media changes on `main`. The repository's source, run data and service configuration are outside that deployment.

## Packaging

Run `python scripts/package_release.py` to create `artifacts/local/industrial-agent-evaluation-lab.zip`. It includes source, tests, dependency lockfiles, documentation, screenshots and the recorded demo under an `industrial-agent-evaluation-lab` directory. It excludes `.env`, installed dependencies, local tools, build output and machine-local test data. Native installation can be recreated from the committed lockfiles.

Before network deployment, replace local shared keys with real identity and per-reviewer authorization, use TLS and managed secrets, isolate database roles, enforce retention and access policies, and review the threat model. No publicly hosted deployment is implied by a local Compose launch.
