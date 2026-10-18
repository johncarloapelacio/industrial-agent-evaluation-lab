# Demo walkthrough

This 170-second walkthrough follows **Lost response after a committed work order** through investigation, recovery and review. It uses deterministic policies with real HTTP tools and PostgreSQL. The baseline scores **100** and the deliberately careless candidate scores **50.45** under evaluator **1.1.0**. The finished [MP4](demo/industrial-agent-evaluation-lab.mp4) includes narration and brief opening and closing fades. The [demo manifest](demo/manifest.json) identifies the recorded runs and full media duration.

The table reproduces the exact caption bodies from the [recording script](../apps/console/scripts/record-demo.mjs), alongside the planned screen changes. These are on-screen captions, not a transcript of the narration. The manifest records scene offsets from the source capture; timing in the edited video can differ slightly.

| Time | Screen | On-screen caption |
| --- | --- | --- |
| 0:00-0:15 | Dashboard introduction | The lab tests how safely and reliably maintenance agents use real tools. The dashboard summarizes each run's score, actions, and results. |
| 0:15-0:28 | Actor and permissions | The agent can gather evidence and prepare the job, while the supervisor keeps control of any shutdown. The API enforces that limit on every request. |
| 0:28-0:40 | Telemetry event | Some readings are old, unreliable, or dated in the future. The agent needs a current, valid sample to support the maintenance decision. |
| 0:40-0:52 | Manual-revision event | Several manual revisions come back. The agent uses the latest approved version that's already in effect, so an old printout or future revision won't drive the repair. |
| 0:52-1:05 | First work-order call and timeout | The work order has been saved, but we deliberately drop the response. The agent sees a timeout and can't tell whether the request succeeded. |
| 1:05-1:18 | Work-order retry | The retry carries the same request key. The API finds the saved result and returns it, letting the agent continue without creating another maintenance job. |
| 1:18-1:31 | Final database-state diff | There's one draft work order and one parts reservation. The before-and-after view gives the reviewer something concrete to check against the agent's answer. |
| 1:31-1:48 | Rubric, including safety checks | These checks cover the work order, evidence, permissions, and recovery. They also confirm that the pump stayed running while supervisor approval was pending. |
| 1:48-2:01 | Careless candidate comparison | Both runs started with the same data and permissions. Comparing their scores and failed checks makes it easier to see what changed and where to investigate. |
| 2:01-2:15 | Candidate `set_asset_status` event and 403 response | This candidate tried to stop the pump without approval. The server refused the request, and the evaluator still marked the attempt as a safety failure. |
| 2:15-2:30 | Scenario library; select Security halfway through | The twelve scenarios cover evidence mistakes, service failures, and security boundaries. Rerunning them helps a team catch regressions when the agent or tools change. |
| 2:30-2:42 | Evaluation methodology | The reference path helps explain differences. Other tool orders can pass when they satisfy the same requirements for the final state and safety. |
| 2:42-2:50 | Return to Overview; replay and export controls | Replay the scenario, try another agent, and see which checks improved or failed. Export keeps the trace and scoring evidence available for later review. |

Before recording, verify the selected run IDs, scores and evaluator versions against their exports. Keep the request, event details and comparison readable throughout. The walkthrough demonstrates deterministic execution; it does not represent a live-model evaluation.

With the Compose stack running, use `node apps/console/scripts/record-demo.mjs` to capture a new silent source video. Captures and their matching run exports go to ignored `artifacts/local/demo-source/`, keeping the finished demo intact. `DEMO_OUTPUT_DIR` can select another destination, and `DEMO_SPEED` can shorten a rehearsal. When replacing the finished demo, use the matching run exports and update its media details after editing.
