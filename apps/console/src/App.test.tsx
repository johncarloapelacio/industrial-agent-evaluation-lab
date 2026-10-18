import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shows a real empty workspace without inventing an evaluated run', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  render(<App />);
  await expect(screen.findByText('Put an agent on the plant floor.')).resolves.toBeVisible();
  expect(screen.getByRole('button', { name: 'Run your first evaluation' })).toBeDisabled();
  expect(screen.queryByText('PASSED')).not.toBeInTheDocument();
});

it('reports a service failure without presenting success metrics as actual runs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')));
  render(<App />);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable'));
  expect(screen.getByText('Services unavailable')).toBeVisible();
  expect(screen.getByRole('button', { name: /^New evaluation$/ })).toBeDisabled();
  expect(screen.queryByText('PASSED')).not.toBeInTheDocument();
});

it('exposes the selected scenario category and keeps it aligned with the visible results', async () => {
  const scenarios = [
    { id: 'pump', name: 'Pump investigation', category: 'normal' },
    { id: 'access', name: 'Facility access boundary', category: 'security' },
  ].map((scenario) => ({
    ...scenario,
    description: 'Review the maintenance request.',
    request: 'Investigate the pump.',
    actor: runFixture('Actor').actor,
    asset_id: 'P-204',
  }));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        response(
          url === '/api/health' ? { status: 'healthy' } : url === '/api/scenarios' ? scenarios : [],
        ),
      ),
  );
  render(<App />);
  await screen.findByText('Put an agent on the plant floor.');
  fireEvent.click(screen.getByRole('button', { name: 'Scenario library' }));
  const filters = screen.getByRole('group', { name: 'Scenario category' });
  const all = within(filters).getByRole('button', { name: /^All scenarios/ });
  const security = within(filters).getByRole('button', { name: /^security/ });
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(security).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('heading', { name: 'Pump investigation' })).toBeVisible();
  fireEvent.click(security);
  expect(all).toHaveAttribute('aria-pressed', 'false');
  expect(security).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: 'Facility access boundary' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Pump investigation' })).not.toBeInTheDocument();
});

it('keeps the workspace usable when a concurrent run has not produced its report', async () => {
  const pending = {
    id: 'pending-run',
    scenario_id: 'pump',
    scenario_name: 'Pump investigation',
    category: 'normal',
    status: 'running',
    provider: 'baseline',
    score: null,
    passed: null,
    created_at: '2026-10-17T08:00:00Z',
    tool_calls: 0,
    retries: 0,
    duration_ms: 0,
    events: [],
    report: null,
    final_response: {},
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/health')
          ? { status: 'healthy' }
          : url.endsWith('/scenarios')
            ? []
            : url.endsWith('/runs')
              ? [pending]
              : pending,
    })),
  );
  render(<App />);
  await expect(
    screen.findByText('Evaluation is running. Waiting for the completed report…'),
  ).resolves.toBeVisible();
  expect(screen.getByText('Local services connected')).toBeVisible();
  expect(screen.queryByText('FAILED')).not.toBeInTheDocument();
});

function runFixture(id: string) {
  return {
    id,
    scenario_id: id,
    scenario_name: `Workflow ${id}`,
    category: 'normal',
    status: 'completed',
    provider: 'baseline',
    score: 100,
    passed: true,
    created_at: '2026-10-17T08:00:00Z',
    tool_calls: 1,
    retries: 0,
    duration_ms: 5,
    request: 'Investigate the pump.',
    actor: { id: 'technician', role: 'technician', facility_id: 'west', tenant_id: 'lab' },
    asset_id: 'P-204',
    clock: '2026-10-17T08:00:00Z',
    events: [
      {
        id: `event-${id}`,
        parent_event_id: null,
        correlation_id: id,
        step: 1,
        kind: 'tool',
        state: 'call_tool',
        tool: 'get_asset',
        arguments: {},
        status: 200,
        result: {},
        attempt: 1,
        latency_ms: 1,
        started_at: '2026-10-17T08:00:00Z',
        state_changes: [],
      },
    ],
    initial_state: {},
    final_state: {},
    state_diff: [],
    report: {
      score: 100,
      passed: true,
      criteria: [],
      violations: [],
      metrics: { tool_calls: 1, retries: 0, latency_ms: 1 },
      golden_comparison: { expected: [], observed: [], missing: [], extra: [] },
    },
    final_response: {
      decision: 'monitor',
      summary: `Conclusion ${id}`,
      evidence_ids: [],
      recommended_action: 'Monitor the next shift.',
    },
    golden_tools: [],
    completion_reason: 'finished',
  };
}
function response(data: unknown) {
  return { ok: true, json: async () => data };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshotFixture() {
  return {
    assets: [{ id: 'P-204', status: 'running' }],
    telemetry: [],
    manuals: [],
    inventory: [],
    technicians: [],
    reservations: [],
    work_orders: [],
    approval_requests: [],
    audit: [],
  };
}

it.each(['initial_state', 'final_state'] as const)(
  'reports unavailable state when %s is missing instead of asserting no changes',
  async (missing) => {
    const run = {
      ...runFixture('Unavailable'),
      initial_state: snapshotFixture(),
      final_state: snapshotFixture(),
      [missing]: {},
      passed: false,
      score: 50,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (url: string) =>
          response(
            url === '/api/health'
              ? { status: 'healthy' }
              : url === '/api/scenarios'
                ? []
                : url === '/api/runs'
                  ? [run]
                  : run,
          ),
        ),
    );
    render(<App />);
    await screen.findByText('Conclusion Unavailable');
    fireEvent.click(screen.getByRole('tab', { name: 'State changes' }));
    expect(screen.getByRole('heading', { name: 'State comparison unavailable' })).toBeVisible();
    expect(screen.getByText(/cannot establish which database changes occurred/)).toBeVisible();
    expect(screen.queryByText('No persistent changes')).not.toBeInTheDocument();
    expect(screen.queryByText('0 changes')).not.toBeInTheDocument();
    expect(screen.getByText('Inspect initial and final snapshots')).toBeVisible();
  },
);

it('identifies unchanged state when complete observations establish an empty diff', async () => {
  const run = {
    ...runFixture('Unchanged'),
    initial_state: snapshotFixture(),
    final_state: snapshotFixture(),
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        response(
          url === '/api/health'
            ? { status: 'healthy' }
            : url === '/api/scenarios'
              ? []
              : url === '/api/runs'
                ? [run]
                : run,
        ),
      ),
  );
  render(<App />);
  await screen.findByText('Conclusion Unchanged');
  fireEvent.click(screen.getByRole('tab', { name: /^State changes/ }));
  expect(screen.getByRole('heading', { name: 'No persistent changes' })).toBeVisible();
  expect(
    screen.getByText('The database state remained the same as the initial seed.'),
  ).toBeVisible();
  expect(screen.queryByText('State comparison unavailable')).not.toBeInTheDocument();
});

it('labels interrupted execution timing as partial instead of a total duration', async () => {
  const run = { ...runFixture('Recovered'), recovery: { duration_incomplete: true } };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        response(
          url === '/api/health'
            ? { status: 'healthy' }
            : url === '/api/scenarios'
              ? []
              : url === '/api/runs'
                ? [run]
                : run,
        ),
      ),
  );
  render(<App />);
  await screen.findByText('Conclusion Recovered');
  expect(screen.getByText('partial duration')).toBeVisible();
  expect(screen.queryByText('total duration')).not.toBeInTheDocument();
  expect(
    screen.getByTitle('Recorded timing excludes the interruption and time until recovery.'),
  ).toBeVisible();
});

it('retries a failed initial run read when the workspace is refreshed', async () => {
  const run = runFixture('Initial');
  let detailReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response([run]);
      if (++detailReads === 1) throw new TypeError('Initial detail network failure');
      return response(run);
    }),
  );
  render(<App />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Conclusion Initial')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
  await screen.findByText('Conclusion Initial');
  expect(detailReads).toBe(2);
  expect(screen.queryByText('Put an agent on the plant floor.')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not let initial-read recovery replace a run selected during the refresh', async () => {
  const runs = ['Initial', 'Selected'].map(runFixture);
  const scenarios = [
    {
      id: 'pump',
      name: 'Pump scenario',
      category: 'normal',
      description: 'Review the pump.',
      request: 'Investigate the pump.',
      actor: runs[0].actor,
      asset_id: 'P-204',
    },
  ];
  const slowHistory = deferred<ReturnType<typeof response>>();
  let listReads = 0;
  let initialDetailReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response(scenarios);
      if (url === '/api/runs') return ++listReads === 1 ? response(runs) : slowHistory.promise;
      if (url.endsWith('/Initial')) {
        initialDetailReads += 1;
        throw new TypeError('Initial detail network failure');
      }
      return response(runs[1]);
    }),
  );
  render(<App />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
  fireEvent.click(screen.getByRole('button', { name: /^Workflow Selected/ }));
  await screen.findByText('Conclusion Selected');
  await act(async () => slowHistory.resolve(response(runs)));
  expect(screen.getByText('Conclusion Selected')).toBeVisible();
  expect(initialDetailReads).toBe(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears a failed comparison message when a new comparison succeeds', async () => {
  const runs = ['A', 'B'].map(runFixture);
  let comparisons = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response(runs);
      if (url.endsWith('/compare/B')) {
        if (++comparisons === 1) throw new TypeError('Comparison network failure');
        return response({
          left: runs[0],
          right: runs[1],
          score_delta: 0,
          tool_call_delta: 0,
          comparable: true,
          criteria: [],
        });
      }
      return response(runs[0]);
    }),
  );
  const { container } = render(<App />);
  await screen.findByText('Conclusion A');
  fireEvent.click(screen.getByRole('tab', { name: 'Compare runs' }));
  const comparison = screen.getByLabelText('Comparison run');
  fireEvent.change(comparison, { target: { value: 'B' } });
  await screen.findByText('Comparison network failure');
  fireEvent.change(comparison, { target: { value: '' } });
  fireEvent.change(comparison, { target: { value: 'B' } });
  await waitFor(() => expect(container.querySelector('.comparison-result')).toBeVisible());
  expect(comparisons).toBe(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears a failed export message when a retry downloads the run', async () => {
  const run = runFixture('Export');
  let exports = 0;
  const createObjectURL = vi.fn(() => 'blob:evaluation-export');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response([run]);
      if (url.endsWith('/export') && ++exports === 1) throw new TypeError('Export network failure');
      return response(run);
    }),
  );
  render(<App />);
  await screen.findByText('Conclusion Export');
  const exportButton = screen.getByRole('button', { name: 'Export' });
  fireEvent.click(exportButton);
  await screen.findByText('Export network failure');
  fireEvent.click(exportButton);
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(exports).toBe(2);
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:evaluation-export');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('finds runs by displayed provider labels while preserving internal provider searches', async () => {
  const runs = [
    runFixture('Baseline'),
    { ...runFixture('Candidate'), provider: 'careless' },
    { ...runFixture('Live'), provider: 'openai-compatible' },
  ];
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        response(
          url === '/api/health'
            ? { status: 'healthy' }
            : url === '/api/scenarios'
              ? []
              : url === '/api/runs'
                ? runs
                : runs[0],
        ),
      ),
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Workflow Baseline' });
  fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
  const search = screen.getByRole('textbox', { name: 'Search runs' });
  for (const [query, workflow] of [
    ['Flawed candidate', 'Candidate'],
    ['careless', 'Candidate'],
    ['Live model', 'Live'],
    ['openai-compatible', 'Live'],
    ['Deterministic baseline', 'Baseline'],
  ]) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getByRole('button', { name: new RegExp(`^Workflow ${workflow}`) })).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  }
});

it('does not let a slow older run response replace the newer selection', async () => {
  const runs = ['A', 'B', 'C'].map(runFixture);
  const slow = deferred<ReturnType<typeof response>>();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === '/api/health'
          ? response({ status: 'healthy' })
          : url === '/api/scenarios'
            ? response([])
            : url === '/api/runs'
              ? response(runs)
              : url === '/api/runs/B'
                ? slow.promise
                : response(runs.find((run) => url.endsWith(`/${run.id}`))),
      ),
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Workflow A' });
  fireEvent.click(screen.getByRole('button', { name: /^Workflow B/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Workflow C/ }));
  await screen.findByRole('heading', { name: 'Workflow C' });
  await act(async () => slow.resolve(response(runs[1])));
  expect(screen.getByRole('heading', { name: 'Workflow C' })).toBeVisible();
  expect(screen.getByText('Conclusion C')).toBeVisible();
});

it('keeps comparison results paired with the latest chosen comparison run', async () => {
  const runs = ['A', 'B', 'C'].map(runFixture);
  const slow = deferred<ReturnType<typeof response>>();
  const comparison = (right: (typeof runs)[number], delta: number) => ({
    left: runs[0],
    right,
    score_delta: delta,
    tool_call_delta: 0,
    criteria: [],
    comparable: true,
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === '/api/health'
          ? response({ status: 'healthy' })
          : url === '/api/scenarios'
            ? response([])
            : url === '/api/runs'
              ? response(runs)
              : url.endsWith('/compare/B')
                ? slow.promise
                : url.endsWith('/compare/C')
                  ? response(comparison(runs[2], 7))
                  : response(runs[0]),
      ),
  );
  const { container } = render(<App />);
  await screen.findByRole('heading', { name: 'Workflow A' });
  fireEvent.click(screen.getByRole('tab', { name: 'Compare runs' }));
  fireEvent.change(screen.getByLabelText('Comparison run'), { target: { value: 'B' } });
  fireEvent.change(screen.getByLabelText('Comparison run'), { target: { value: 'C' } });
  await waitFor(() =>
    expect(container.querySelector('.comparison-result')).toHaveTextContent('+7'),
  );
  await act(async () => slow.resolve(response(comparison(runs[1], 19))));
  expect(container.querySelector('.comparison-result')).toHaveTextContent('+7');
  expect(container.querySelector('.comparison-result')).not.toHaveTextContent('+19');
});

it('supports the keyboard tab contract and excludes ungraded comparison runs', async () => {
  const run = runFixture('A');
  const pending = {
    ...runFixture('Pending'),
    status: 'running',
    score: null,
    passed: null,
    report: null,
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        response(
          url === '/api/health'
            ? { status: 'healthy' }
            : url === '/api/scenarios'
              ? []
              : url === '/api/runs'
                ? [run, pending]
                : run,
        ),
      ),
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Workflow A' });
  fireEvent.keyDown(screen.getByRole('tab', { name: /^Tool trajectory/ }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Compare runs' })).toHaveFocus();
  expect(screen.queryByRole('option', { name: /Workflow Pending/ })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Compare runs' }), { key: 'Home' });
  expect(screen.getByRole('tab', { name: /^Tool trajectory/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

it('retains a completed evaluation when the subsequent history refresh fails', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  const run = runFixture('Committed');
  const scenario = {
    id: 'pump',
    name: 'Pump scenario',
    category: 'normal',
    request: 'Investigate.',
    actor: run.actor,
    asset_id: 'P-204',
  };
  let listReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([scenario]);
      if (options.method === 'POST') return response(run);
      if (++listReads === 1) return response([]);
      throw new TypeError('History network failure');
    }),
  );
  render(<App />);
  await screen.findByText('Put an agent on the plant floor.');
  fireEvent.click(screen.getByRole('button', { name: /^New evaluation$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Start evaluation' }));
  await screen.findByRole('heading', { name: 'Workflow Committed' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The evaluation completed, but run history could not refresh',
  );
  expect(screen.getByText('Conclusion Committed')).toBeVisible();
});

it('retries a failed background poll and shows the eventual completed report', async () => {
  const completed = runFixture('Pending');
  const pending = {
    ...completed,
    status: 'running',
    report: null,
    score: null,
    passed: null,
    final_response: {},
  };
  const slowForeground = deferred<ReturnType<typeof response>>();
  let detailReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response([pending]);
      detailReads += 1;
      if (detailReads === 2) return slowForeground.promise;
      if (detailReads === 3) throw new TypeError('Temporary read failure');
      return response(detailReads === 1 ? pending : completed);
    }),
  );
  render(<App />);
  await screen.findByText('Evaluation is running. Waiting for the completed report…');
  expect(screen.getByRole('button', { name: 'Replay scenario' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /^Workflow Pending/ }));
  await screen.findByText('Live refresh failed. Retrying automatically.', {}, { timeout: 3000 });
  await screen.findByText('PASSED', {}, { timeout: 3000 });
  await act(async () => slowForeground.resolve(response(pending)));
  expect(screen.getByText('PASSED')).toBeVisible();
  expect(
    screen.queryByText('Live refresh failed. Retrying automatically.'),
  ).not.toBeInTheDocument();
}, 8000);

it('keeps comparisons usable for the visible run after another run fails to load', async () => {
  const runs = ['A', 'B', 'C'].map(runFixture);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response(runs);
      if (url === '/api/runs/B') throw new TypeError('Selected run could not load');
      if (url.endsWith('/compare/C'))
        return response({
          left: runs[0], right: runs[2], score_delta: 7,
          tool_call_delta: 0, comparable: true, criteria: [],
        });
      return response(runs[0]);
    }),
  );
  const { container } = render(<App />);
  await screen.findByText('Conclusion A');
  fireEvent.click(screen.getByRole('button', { name: /^Workflow B/ }));
  await screen.findByText('Selected run could not load');
  expect(screen.getByText('Conclusion A')).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Compare runs' }));
  fireEvent.change(screen.getByLabelText('Comparison run'), { target: { value: 'C' } });
  await waitFor(() =>
    expect(container.querySelector('.comparison-result')).toHaveTextContent('+7'),
  );
});

it('resumes polling the visible running evaluation after a failed selection', async () => {
  const completed = runFixture('A');
  const pending = {
    ...completed, status: 'running', score: null,
    passed: null, report: null, final_response: {},
  };
  const other = runFixture('B');
  const slowSelection = deferred<ReturnType<typeof response>>();
  let detailReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([]);
      if (url === '/api/runs') return response([pending, other]);
      if (url === '/api/runs/B') return slowSelection.promise;
      return response(++detailReads === 1 ? pending : completed);
    }),
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Workflow A' });
  fireEvent.click(screen.getByRole('button', { name: /^Workflow B/ }));
  // Let the old poll timer expire while selection B is still in flight.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    slowSelection.resolve({ ok: false, json: async () => ({ detail: 'Selected run could not load' }) });
  });
  await screen.findByText('Selected run could not load');
  await screen.findByText('Conclusion A', {}, { timeout: 2500 });
  expect(detailReads).toBe(2);
}, 6000);

it('does not replace a completed live observation with older refreshed history', async () => {
  const completed = runFixture('A');
  const pending = {
    ...completed, status: 'running', score: null,
    passed: null, report: null, final_response: {},
  };
  const slowHistory = deferred<ReturnType<typeof response>>();
  let historyReads = 0;
  let detailReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([{ id: 'pump', name: 'Pump scenario' }]);
      if (url === '/api/runs')
        return ++historyReads === 1 ? response([pending]) : slowHistory.promise;
      return response(++detailReads === 1 ? pending : completed);
    }),
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Workflow A' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
  await screen.findByText('Conclusion A', {}, { timeout: 2500 });
  await act(async () => slowHistory.resolve(response([pending])));
  const row = screen.getByRole('button', { name: /^Workflow A/ }).closest('tr')!;
  expect(within(row).getByText('Passed')).toBeVisible();
  expect(within(row).queryByText('running')).not.toBeInTheDocument();
}, 5000);

it('retains a newly committed replay when an older workspace refresh arrives last', async () => {
  const initial = runFixture('A');
  const replay = runFixture('Replay');
  const slowHistory = deferred<ReturnType<typeof response>>();
  let historyReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      if (url === '/api/health') return response({ status: 'healthy' });
      if (url === '/api/scenarios') return response([{ id: 'pump', name: 'Pump scenario' }]);
      if (url === '/api/runs') {
        historyReads += 1;
        return historyReads === 1
          ? response([initial])
          : historyReads === 2
            ? slowHistory.promise
            : response([replay, initial]);
      }
      return response(options.method === 'POST' ? replay : initial);
    }),
  );
  render(<App />);
  await screen.findByText('Conclusion A');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replay scenario' }));
  await screen.findByText('Conclusion Replay');
  await act(async () => slowHistory.resolve(response([initial])));
  expect(screen.getByRole('button', { name: /^Workflow Replay/ })).toBeVisible();
  expect(screen.getByText('Conclusion Replay')).toBeVisible();
});
