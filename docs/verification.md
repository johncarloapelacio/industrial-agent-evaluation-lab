# Verification record

Verified locally on October 17, 2026 using real PostgreSQL 17 and HTTP services. The final audit also ran the source in a clean Linux environment with Python 3.13, Node.js 24 and Chromium, using native services against a fresh database to check the CI startup sequence. Windows checks used Python 3.14. The review console is served by Docker Compose on `127.0.0.1:8080`. No external model was called during these checks.

| Check | Executed result |
| --- | --- |
| Python unit and cross-service integration suite | **365 passed** on Linux and Windows, no skips |
| TypeScript operational API suite | **63 passed**, including 40 real HTTP/PostgreSQL contracts; no skips |
| Console unit/component suite | **25 passed** |
| Playwright production review flow | **2 passed** against the Compose console, including keyboard dialog dismissal |
| Browser network recovery | Detail, comparison and export requests recovered after network access returned; a delayed refresh preserved a newer selection |
| TypeScript production builds | API and console passed |
| Docker Compose | All four services built, started and reported healthy |
| Fresh demo startup | Three actual runs created: two passing baselines and one failing careless candidate |
| Interrupted-process recovery | A committed work order and reservation survived a forced process kill; two restarts added no duplicate operations |
| Twelve-scenario baseline suite | All twelve scored 100/100 using real tools and persisted state |
| Composed fault matrix | All 48 ordinary-tool and six concurrent-reservation fault combinations passed against real services |
| Concurrent replay | Five replays kept independent scopes and left the original run unchanged |
| Python dependency advisory audit | No known vulnerabilities reported for the hash-locked dependency set |
| Both npm advisory audits | Zero vulnerabilities reported |
| GitHub Actions workflow syntax | `actionlint` passed, including shell-command checks |
| Native artifacts | Scenario JSON, saved reports, PNG screenshots and narrated MP4 opened and inspected |
| Source package | ZIP integrity, sensitive-file exclusions, local links and artifact metadata checked |
| Secret scan and Git exclusions | Gitleaks reported no leaks; environment files, local tools, dependencies and generated test data are ignored |

The Python suite includes actual lost-response recovery, concurrent reservation dispatch, final database assertions, scoped denials, sensitive-output containment, saved-report reevaluation, isolated replay, comparison and export. Operational contracts separately exercise different-key contention for the final stock item, same-key deduplication, identity-field rejection, cross-run credentials/relationships, role checks and asset-specific supervisor approval.

Tests for the optional compatible adapter use local protocol fixtures to check payload handling and execution bounds without contacting a model. One upstream Starlette test-client deprecation warning was emitted; the tests passed.

## Behavior covered

The current evaluator (`1.1.2`) checks workflow changes beyond the requested asset, actor attribution, draft/pending states, evidence links and stock reconciliation. Authorization grading includes attempted sensitive disclosures and known out-of-scope probes, even when the API blocks them. A scoped denial satisfies the investigation requirement only for the requested asset. Failure evidence is ordered consistently across process restarts.

The API rejects recognizable private contact or credential text in work-order titles and approval reasons before storage. It recovers from a lost idle database connection, preserves complete technical evidence in responses, and retains valid correlation IDs for malformed-request denials. Invalid Unicode, URL encoding and request compression produce readable, audited errors. Unknown tool names receive the same sanitization as arguments. Invalid seed values roll back the entire scope rather than leaving partial records.

Privacy checks cover text in JSON keys as well as values and redaction paths, including acronym-style credential fields. Correlation IDs containing recognizable private text are replaced before response headers or audit storage; valid IDs retain their links. Long technical text does not stall the email matcher. Real-service regressions deliver notes and procedures at their full source limits, including text expanded by redaction. When delivered evidence exceeds the sanitizer limit, the trace identifies the truncation and the workflow stops before mutation.

Timestamp checks preserve microseconds across both services and PostgreSQL, including readings immediately before and after the scenario clock. UUID aliases remain equivalent during response validation and idempotent retries. Concurrent deliveries preserve their own validation links and retry numbers. A valid sibling can confirm a reservation after a lost or malformed reply; conflicting result IDs are rejected before agent use and by the evaluator.

Frontend regressions cover delayed responses overwriting newer selections, stuck loading, failed polls, incomplete comparisons and a successful run followed by a failed history refresh. Closing a dialog returns keyboard focus to its invoking control.

Model and tool JSON parsing rejects non-finite numbers, and unsupported local values remain safe to store in traces. Invalid reviewer requests return sanitized validation errors without starting a run. Unrecoverable model-response errors leave an inspectable failed run; arguments that cannot be serialized as finite JSON never reach the operational API. Accepted UUID aliases resolve consistently through run lookup, replay and export.

The optional model adapter validates an entire tool-call batch before dispatch, rejects truncated or inconsistent completions, and reports configured turn and dispatch limits as budget exhaustion. Scenario loading checks that seed records match the API contract and that declared monitor or maintenance decisions agree with the current approved limits. These protocol checks use local fixtures; they do not establish real-model quality.

Compact navigation now keeps accessible button names, scenario filters expose their selected state, and run search accepts the provider names shown on screen. Overview labels distinguish the recent-run window from all-time history and the scenario library from execution coverage. The screenshots were refreshed from an isolated demonstration database; the edited video remains unchanged.

Initial and final snapshots must include all operational collections with identified records. Missing state is reported as unavailable; it cannot prove that no mutations occurred. Malformed observations leave an inspectable failed run. State diffs require two complete observations, including during recovery of older interrupted runs. The console displays unavailable comparisons explicitly and labels interrupted timing as partial.

Refreshing after a failed detail load retries that request without overriding a newer selection. A failed selection preserves polling and comparisons for the run still visible. Stale history responses cannot overwrite a more recent completed observation or remove a new replay. Comparison and export retries clear their previous error messages when a new request starts.

## Reproduce

Start the stack with the README command. Install the source's locked Python and npm dependencies, then enable the database suites:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://lab:lab@127.0.0.1:5432/lab'
$env:LAB_INTEGRATION = '1'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:8080'
npm.cmd test
.venv\Scripts\python.exe -m pytest -q
npm.cmd --prefix apps/console exec -- playwright install chromium
npm.cmd run test:e2e
```

The API test command includes its unit and database suites. Python integration tests call the running control plane, which calls the running operational service and PostgreSQL. Browser tests perform real executions and inspect the resulting review screens; they do not intercept application routes.

Use `python scripts/seed_demo.py --all` to create and export a fresh baseline suite. Use `POST /api/runs/{id}/evaluate` to reevaluate a stored trajectory with the installed engine. Reports and response headers identify evaluator versions; a scoring change can alter a historical result. Replay starts another isolated scope from the saved specification; identifiers, wall-clock timing and live-model wording are allowed to vary.

## Saved demonstration evidence

The [demo manifest](demo/manifest.json) identifies the actual recorded runs, caption text and media details. The [baseline export](demo/baseline-run.json) scored 100 and the [careless export](demo/candidate-run.json) scored 50.45 under evaluator `1.1.0`. These historical exports retain the version shown at capture; current runs use `1.1.2`. Both recorded trajectories keep the same scores when reevaluated with `1.1.2`. These runs used deterministic policies with real HTTP tools and PostgreSQL. The narrated [MP4](demo/industrial-agent-evaluation-lab.mp4) lasts 2:56.20 and includes the captioned walkthrough. The video played through successfully, and its stereo audio decoded throughout. Screenshots show fresh runs against the current release; each execution has its own run IDs.

## Verification limits

The GitHub workflow includes a PostgreSQL-backed verification job and a separate fresh Compose smoke job; both run on push or pull request. [Hosted execution results](https://github.com/johncarloapelacio/industrial-agent-evaluation-lab/actions/workflows/ci.yml) record the outcome for each published commit. The README badge shows the latest main-branch result. The checks above were executed locally; hosted execution is recorded separately.

The optional compatible-model adapter is implemented and protocol-tested. No provider credentials were supplied and no real-model trajectory was recorded. Live performance and a public network deployment remain distinct from the verified local system. The default topology supports one control-plane worker; see the threat model and operations guide before expanding it.

Dependency advisory results describe the registry databases queried at verification time; they are not a guarantee against undisclosed issues. The repository's dependency update configuration and CI advisory checks support continued maintenance.

The workflow uses the current major versions documented by the official [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node), [setup-python](https://github.com/actions/setup-python) and [upload-artifact](https://github.com/actions/upload-artifact) projects.
