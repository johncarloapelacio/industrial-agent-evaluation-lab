export interface Actor {
  id: string;
  role: string;
  facility_id: string;
  tenant_id: string;
}
export type Provider = 'baseline' | 'careless' | 'openai-compatible';
export interface Scenario {
  id: string;
  name: string;
  category: string;
  description: string;
  request: string;
  actor: Actor;
  asset_id: string;
}
export interface RunSummary {
  id: string;
  scenario_id: string;
  scenario_name: string;
  category: string;
  status: string;
  provider: Provider;
  score: number | null;
  passed: boolean | null;
  created_at: string;
  tool_calls: number;
  retries: number;
  duration_ms: number;
}
export interface TraceEvent {
  id: string;
  parent_event_id: string | null;
  correlation_id: string;
  step: number;
  kind: string;
  state: string;
  tool?: string;
  arguments: Record<string, unknown>;
  status?: number;
  result: Record<string, unknown>;
  attempt: number;
  latency_ms: number;
  started_at: string;
  state_changes: unknown[];
  error?: string;
}
export interface Criterion {
  id: string;
  label: string;
  weight: number;
  earned: number;
  passed: boolean;
  expected: unknown;
  observed: unknown;
  event_ids: string[];
  explanation: string;
}
export interface Violation {
  rule: string;
  event_id: string;
  attempted_action: unknown;
  observed: unknown;
  expected: unknown;
}
export interface Report {
  score: number;
  passed: boolean;
  criteria: Criterion[];
  violations: Violation[];
  metrics: { tool_calls: number; retries: number; latency_ms: number };
  golden_comparison: { expected: string[]; observed: string[]; missing: string[]; extra: string[] };
}
export interface StateDiff {
  entity: string;
  id: string;
  before: unknown;
  after: unknown;
}
export interface Run extends RunSummary {
  request: string;
  actor: Actor;
  asset_id: string;
  clock: string;
  events: TraceEvent[];
  initial_state: Record<string, unknown>;
  final_state: Record<string, unknown>;
  state_diff: StateDiff[];
  report: Report;
  final_response: {
    decision: string;
    summary: string;
    evidence_ids: string[];
    recommended_action: string;
  };
  golden_tools: string[];
  completion_reason: string;
  replay_of?: string;
  recovery?: { duration_incomplete?: boolean };
}
export interface Comparison {
  left: RunSummary;
  right: RunSummary;
  score_delta: number;
  tool_call_delta: number;
  comparable?: boolean;
  note?: string;
  criteria: { id: string; left_passed: boolean; right_passed: boolean }[];
}
