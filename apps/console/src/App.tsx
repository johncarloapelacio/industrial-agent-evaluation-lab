import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { api, duration, getToken, pretty, providerLabel, setToken, shortId } from './api';
import type { Comparison, Criterion, Provider, Run, RunSummary, Scenario } from './types';

type IconName =
  | 'grid'
  | 'layers'
  | 'runs'
  | 'book'
  | 'bolt'
  | 'arrow'
  | 'play'
  | 'repeat'
  | 'download'
  | 'settings'
  | 'check'
  | 'close'
  | 'clock'
  | 'shield'
  | 'chevron'
  | 'search'
  | 'compare'
  | 'alert'
  | 'external';
function Icon({
  name,
  size = 18,
  ...props
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.3" />
        <rect x="14" y="3" width="7" height="7" rx="1.3" />
        <rect x="3" y="14" width="7" height="7" rx="1.3" />
        <rect x="14" y="14" width="7" height="7" rx="1.3" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5Z" />
        <path d="m2 12 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    runs: (
      <>
        <path d="M4 4v16h16M8 15l4-5 4 3 5-8" />
        <path d="M17 5h4v4" />
      </>
    ),
    book: (
      <>
        <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15Z" />
      </>
    ),
    bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    repeat: (
      <>
        <path d="M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6M4 16a8 8 0 0 0 14 2l3-3m0 6v-6h-6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5" />
      </>
    ),
    settings: (
      <>
        <path d="m10 3-.8 3-2 .9-2.7-.8-2 3.5 2 2.2v2.4l-2 2.2 2 3.5 2.8-.8 2 .9.7 3h4l.8-3 2-.9 2.7.8 2-3.5-2-2.2v-2.4l2-2.2-2-3.5-2.8.8-2-.9L14 3h-4Z" />
        <circle cx="12" cy="13" r="3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    compare: (
      <>
        <path d="M8 3v18M16 3v18M4 7h8m0 0L9 4m3 3-3 3m3 7h8m-8 0 3-3m-3 3 3 3" />
      </>
    ),
    alert: (
      <>
        <path d="m12 3 10 18H2L12 3Z" />
        <path d="M12 9v5m0 3v.1" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />
      </>
    ),
  };
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function completeSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return [
    'assets',
    'telemetry',
    'manuals',
    'inventory',
    'technicians',
    'reservations',
    'work_orders',
    'approval_requests',
    'audit',
  ].every((entity) => {
    const rows = snapshot[entity];
    return (
      Array.isArray(rows) &&
      rows.every(
        (row) =>
          row && typeof row === 'object' && typeof row.id === 'string' && row.id.trim() !== '',
      )
    );
  });
}
function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-symbol">
        <Icon name="layers" size={28} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function App() {
  const [page, setPage] = useState<'overview' | 'scenarios' | 'runs' | 'methodology'>('overview');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(false);
  const [modal, setModal] = useState<'run' | 'settings' | null>(null);
  const [scenarioId, setScenarioId] = useState('');
  const [provider, setProvider] = useState<Provider>('baseline');
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getToken);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [tab, setTab] = useState<'trajectory' | 'rubric' | 'state' | 'compare'>('trajectory');
  const [eventId, setEventId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [pollError, setPollError] = useState('');
  // A slow response must not replace the run or comparison selected more recently.
  const activeRunId = useRef<string | null>(null);
  const detailRequest = useRef(0);
  const comparisonRequest = useRef(0);
  const refreshRequest = useRef(0);
  const historyRevision = useRef(0);
  const navigateToEvent = useRef(false);

  function resetComparison() {
    comparisonRequest.current += 1;
    setComparison(null);
    setComparisonId('');
    setComparing(false);
  }

  async function refresh() {
    const request = ++refreshRequest.current;
    const detailAtStart = detailRequest.current;
    const historyAtStart = historyRevision.current;
    setLoading(true);
    setError('');
    try {
      const [scenarioResult, runResult, healthResult] = await Promise.allSettled([
        api<Scenario[]>('/scenarios'),
        api<RunSummary[]>('/runs'),
        api<{ status: string }>('/health'),
      ]);
      if (request !== refreshRequest.current) return;
      if (scenarioResult.status === 'rejected') throw scenarioResult.reason;
      if (runResult.status === 'rejected') throw runResult.reason;
      const nextScenarios = scenarioResult.value,
        nextRuns = runResult.value;
      setScenarios(nextScenarios);
      // A newer detail read or committed run takes precedence over older history.
      if (historyAtStart === historyRevision.current) setRuns(nextRuns);
      setScenarioId((current) => current || nextScenarios[0]?.id || '');
      setHealth(
        healthResult.status === 'fulfilled' &&
          ['healthy', 'ok'].includes(healthResult.value.status),
      );
      if (healthResult.status === 'rejected')
        setError(
          'Operational service health check failed. Existing evaluations remain available for review.',
        );
      if (!selectedRun && detailAtStart === detailRequest.current) {
        const runId = activeRunId.current ?? nextRuns[0]?.id;
        if (runId) await loadRun(runId);
      }
    } catch (e) {
      if (request === refreshRequest.current) {
        setError((e as Error).message);
        setHealth(false);
      }
    } finally {
      if (request === refreshRequest.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []); // Initial read; mutations refresh their own results.
  useEffect(() => {
    if (!selectedRun || selectedRun.report) return;
    let stopped = false;
    let timer: number;
    // Wait for each read before scheduling another, even when the server is slow.
    const poll = async () => {
      if (stopped || activeRunId.current !== selectedRun.id) return;
      await loadRun(selectedRun.id, true);
      if (!stopped && activeRunId.current === selectedRun.id) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [selectedRun]);
  useEffect(
    () => () => {
      detailRequest.current += 1;
      comparisonRequest.current += 1;
      refreshRequest.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (navigateToEvent.current && tab === 'trajectory' && eventId) {
      document
        .getElementById(`event-${eventId}`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      navigateToEvent.current = false;
    }
  }, [eventId, tab]);
  async function loadRun(id: string, background = false) {
    const request = ++detailRequest.current;
    activeRunId.current = id;
    if (!background) {
      setDetailLoading(true);
      setError('');
      setPollError('');
      resetComparison();
    }
    try {
      const run = await api<Run>(`/runs/${encodeURIComponent(id)}`);
      if (request !== detailRequest.current || activeRunId.current !== id) return;
      historyRevision.current += 1;
      setSelectedRun(run);
      setPollError('');
      setEventId((current) =>
        background && current && run.events.some((event) => event.id === current)
          ? current
          : (run.events.find((event) => event.kind === 'tool')?.id ?? run.events[0]?.id ?? null),
      );
      setRuns((current) => current.map((item) => (item.id === run.id ? run : item)));
    } catch (e) {
      if (request === detailRequest.current) {
        if (background) setPollError('Live refresh failed. Retrying automatically.');
        else {
          // Keep polling and comparisons attached to the run still on screen.
          if (selectedRun) {
            activeRunId.current = selectedRun.id;
            setSelectedRun((current) => current && { ...current });
          }
          setError((e as Error).message);
        }
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }
  async function execute(replay = false) {
    if (busy || (!scenarioId && !replay)) return;
    setBusy(true);
    setError('');
    try {
      const run =
        replay && selectedRun
          ? await api<Run>(`/runs/${selectedRun.id}/replay`, {})
          : await api<Run>('/runs', { scenario_id: scenarioId, provider });
      // The run has committed. A failed history refresh must not invite resubmission.
      activeRunId.current = run.id;
      detailRequest.current += 1;
      historyRevision.current += 1;
      resetComparison();
      setDetailLoading(false);
      setPollError('');
      setSelectedRun(run);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setEventId(run.events.find((event) => event.kind === 'tool')?.id ?? null);
      setPage('overview');
      setTab('trajectory');
      setModal(null);
      try {
        const historyAtStart = historyRevision.current;
        const nextRuns = await api<RunSummary[]>('/runs');
        if (historyAtStart === historyRevision.current) setRuns(nextRuns);
      } catch {
        setError(
          'The evaluation completed, but run history could not refresh. Its report is available below.',
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function compare(id: string) {
    const request = ++comparisonRequest.current;
    const runId = selectedRun?.id;
    setComparisonId(id);
    setComparison(null);
    if (!runId || !id) {
      setComparing(false);
      return;
    }
    setError('');
    setComparing(true);
    try {
      const result = await api<Comparison>(`/runs/${runId}/compare/${encodeURIComponent(id)}`);
      if (request === comparisonRequest.current && activeRunId.current === runId)
        setComparison(result);
    } catch (e) {
      if (request === comparisonRequest.current) setError((e as Error).message);
    } finally {
      if (request === comparisonRequest.current) setComparing(false);
    }
  }
  async function exportRun() {
    if (!selectedRun) return;
    setError('');
    try {
      const data = await api<Run>(`/runs/${selectedRun.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `evaluation-${selectedRun.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function newRun(id?: string) {
    if (id) setScenarioId(id);
    setModal('run');
  }
  function inspectEvent(id: string) {
    navigateToEvent.current = true;
    setEventId(id);
    setTab('trajectory');
  }
  const completed = runs.filter((run) => run.score !== null);
  const average = completed.length
    ? Math.round(completed.reduce((sum, run) => sum + (run.score ?? 0), 0) / completed.length)
    : null;
  const passing = completed.length
    ? Math.round((completed.filter((run) => run.passed).length / completed.length) * 100)
    : null;
  const selectedScenario = scenarios.find((scenario) => scenario.id === scenarioId);
  const filteredRuns = runs.filter((run) =>
    `${run.scenario_name} ${run.id} ${run.provider} ${providerLabel(run.provider)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const filteredScenarios = scenarios.filter(
    (scenario) =>
      (category === 'all' || category === scenario.category) &&
      `${scenario.name} ${scenario.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedEvent = selectedRun?.events.find((event) => event.id === eventId);
  const stateAvailable =
    completeSnapshot(selectedRun?.initial_state) && completeSnapshot(selectedRun?.final_state);
  const activeCriteria =
    selectedRun?.report?.criteria?.filter(
      (criterion) => selectedEvent && criterion.event_ids.includes(selectedEvent.id),
    ) ?? [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          href="#main"
          className="brand"
          onClick={() => setPage('overview')}
          aria-label="Industrial Lab overview"
        >
          <span className="brand-mark">
            <Icon name="layers" size={23} />
          </span>
          <span>
            INDUSTRIAL
            <span className="brand-bottom">
              AGENT LAB <span className="version">v1.0</span>
            </span>
          </span>
        </a>
        <div className="workspace-label">EVALUATION WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(
            [
              ['overview', 'grid', 'Overview'],
              ['scenarios', 'layers', 'Scenario library'],
              ['runs', 'runs', 'Run history'],
              ['methodology', 'book', 'Methodology'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              aria-label={label}
              title={label}
              onClick={() => {
                setPage(id);
                setQuery('');
              }}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === 'scenarios' && <span className="nav-count">{scenarios.length || '—'}</span>}
              {id === 'runs' && runs.length > 0 && <span className="nav-count">{runs.length}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-note">
          <div className="rail-note-icon">
            <Icon name="shield" size={21} />
          </div>
          <h4>Evidence over intuition.</h4>
          <p>
            Real tool calls. Isolated data.
            <br />
            Deterministic evaluation.
          </p>
          <span>
            BUILT FOR INSPECTION <Icon name="arrow" size={13} />
          </span>
        </div>
        <div className="sidebar-bottom">
          <div className="system-status">
            <span className={`status-dot ${health ? 'online' : ''}`} />
            {health
              ? 'Local services connected'
              : loading
                ? 'Connecting to services'
                : 'Services unavailable'}
          </div>
          <button
            className="settings-button"
            aria-label="Reviewer settings"
            title="Reviewer settings"
            onClick={() => {
              setTokenDraft(getToken());
              setModal('settings');
            }}
          >
            <span className="avatar">LR</span>
            <span>
              Local reviewer<small>Development workspace</small>
            </span>
            <Icon name="settings" size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <Icon name="chevron" size={13} />
            <span>
              {page === 'overview'
                ? 'Overview'
                : page === 'scenarios'
                  ? 'Scenario library'
                  : page === 'runs'
                    ? 'Run history'
                    : 'Methodology'}
            </span>
          </div>
          <div className="topbar-meta">
            <span className="local-tag">
              <span />
              LOCAL ENVIRONMENT
            </span>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              disabled={loading || busy}
              aria-label="Refresh workspace"
            >
              <Icon name="repeat" size={17} />
            </button>
          </div>
        </header>
        <main id="main" className="main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">INDUSTRIAL AGENT EVALUATION LAB</p>
              <h1>
                {page === 'overview'
                  ? 'Every action. Measured.'
                  : page === 'scenarios'
                    ? 'Real conditions. Controlled tests.'
                    : page === 'runs'
                      ? 'A record of every decision.'
                      : 'Measured against the evidence.'}
              </h1>
              <p className="page-description">
                {page === 'overview'
                  ? 'Inspect how maintenance agents reason, act, and recover across live systems.'
                  : page === 'scenarios'
                    ? 'Maintenance workflows, operational faults, and adversarial requests in isolated run scopes.'
                    : page === 'runs'
                      ? 'Revisit an evaluation, replay its scenario, or compare candidate behavior.'
                      : 'Transparent scoring over real HTTP trajectories and final PostgreSQL state.'}
              </p>
            </div>
            {page !== 'methodology' && (
              <button
                className="button primary"
                onClick={() => newRun()}
                disabled={loading || busy || !scenarios.length}
              >
                <Icon name="play" size={15} />
                New evaluation
              </button>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="alert" />
              <div>
                <strong>The request could not be completed.</strong>
                <p>{error}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {loading && !scenarios.length ? (
            <div className="loading-state" role="status">
              <span className="spinner" />
              Loading the evaluation workspace…
            </div>
          ) : (
            <>
              {page === 'overview' && (
                <>
                  <div className="metrics-grid">
                    <Metric
                      label="RECENT EVALUATIONS"
                      value={String(runs.length)}
                      icon="runs"
                      detail="Latest persisted runs (up to 200)"
                    />
                    <Metric
                      label="AVERAGE SCORE"
                      value={average === null ? '—' : String(average)}
                      suffix={average === null ? '' : '/ 100'}
                      icon="grid"
                      detail={
                        completed.length
                          ? `Across ${completed.length} scored ${completed.length === 1 ? 'run' : 'runs'}`
                          : 'Execute a run to establish a baseline'
                      }
                    />
                    <Metric
                      label="PASS RATE"
                      value={passing === null ? '—' : `${passing}%`}
                      icon="shield"
                      detail="All required rubric checks satisfied"
                    />
                    <Metric
                      label="SCENARIO LIBRARY"
                      value={String(scenarios.length)}
                      icon="layers"
                      detail={`${scenarios.filter((s) => s.category === 'normal').length} normal · ${scenarios.filter((s) => s.category === 'reliability').length} reliability · ${scenarios.filter((s) => s.category === 'security').length} security`}
                    />
                  </div>
                  {selectedRun ? (
                    <section aria-label="Selected evaluation">
                      <div className="section-title">
                        <div>
                          <span className="section-kicker">EVALUATION INSPECTOR</span>
                          <h2>{selectedRun.scenario_name}</h2>
                        </div>
                        <div className="run-actions">
                          <button
                            className="button small"
                            onClick={() => void exportRun()}
                            disabled={detailLoading}
                          >
                            <Icon name="download" size={15} />
                            Export
                          </button>
                          <button
                            className="button small"
                            onClick={() => void execute(true)}
                            disabled={busy || detailLoading || !selectedRun.report}
                          >
                            <Icon name="repeat" size={15} />
                            {busy ? 'Running…' : 'Replay scenario'}
                          </button>
                        </div>
                      </div>
                      {detailLoading || !selectedRun.report ? (
                        <div className="loading-state" role="status">
                          <span className="spinner" />
                          {detailLoading
                            ? 'Loading run…'
                            : 'Evaluation is running. Waiting for the completed report…'}
                          {pollError && (
                            <span className="poll-error" role="alert">
                              {pollError}
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="run-summary">
                            <div
                              className={`score-ring ${selectedRun.passed ? 'pass' : 'fail'}`}
                              style={
                                { '--score': `${selectedRun.score ?? 0}%` } as React.CSSProperties
                              }
                            >
                              <div>
                                <strong title={`${selectedRun.score ?? 0} / 100`}>
                                  {selectedRun.score === null
                                    ? String.fromCharCode(8212)
                                    : Math.round(selectedRun.score)}
                                </strong>
                                <span>/ 100</span>
                              </div>
                            </div>
                            <div className="run-summary-main">
                              <div className="summary-badges">
                                <Badge tone={selectedRun.passed ? 'green' : 'red'}>
                                  <Icon name={selectedRun.passed ? 'check' : 'close'} size={12} />
                                  {selectedRun.passed ? 'PASSED' : 'FAILED'}
                                </Badge>
                                <Badge>{providerLabel(selectedRun.provider)}</Badge>
                                <span className="mono subtle">RUN {shortId(selectedRun.id)}</span>
                              </div>
                              <p className="request">“{selectedRun.request}”</p>
                              <div className="actor-details">
                                <span>
                                  <Icon name="shield" size={13} />
                                  {selectedRun.actor.role}
                                </span>
                                <span>{selectedRun.actor.facility_id}</span>
                                <span>{selectedRun.asset_id}</span>
                                <span title={selectedRun.created_at}>
                                  {new Date(selectedRun.created_at).toLocaleString()}
                                </span>
                              </div>
                            </div>
                            <div className="run-counts">
                              <div>
                                <strong>{selectedRun.tool_calls}</strong>
                                <span>tool calls</span>
                              </div>
                              <div>
                                <strong>{selectedRun.retries}</strong>
                                <span>retries</span>
                              </div>
                              <div>
                                <strong>{duration(selectedRun.duration_ms)}</strong>
                                <span
                                  title={
                                    selectedRun.recovery?.duration_incomplete
                                      ? 'Recorded timing excludes the interruption and time until recovery.'
                                      : undefined
                                  }
                                >
                                  {selectedRun.recovery?.duration_incomplete
                                    ? 'partial duration'
                                    : 'total duration'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="inspector-panel">
                            <div
                              className="tabs"
                              role="tablist"
                              aria-label="Run inspection"
                              onKeyDown={navigateTabs}
                            >
                              {(
                                [
                                  [
                                    'trajectory',
                                    'Tool trajectory',
                                    selectedRun.events.filter((e) => e.kind === 'tool').length,
                                  ],
                                  ['rubric', 'Rubric results', selectedRun.report.criteria.length],
                                  [
                                    'state',
                                    'State changes',
                                    stateAvailable ? selectedRun.state_diff.length : null,
                                  ],
                                  ['compare', 'Compare runs', null],
                                ] as const
                              ).map(([id, label, count]) => (
                                <button
                                  key={id}
                                  role="tab"
                                  id={`tab-${id}`}
                                  aria-controls={`panel-${id}`}
                                  aria-selected={tab === id}
                                  tabIndex={tab === id ? 0 : -1}
                                  className={tab === id ? 'active' : ''}
                                  onClick={() => setTab(id)}
                                >
                                  {label}
                                  {count !== null && <span>{count}</span>}
                                </button>
                              ))}
                            </div>
                            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                              {tab === 'trajectory' && (
                                <div className="trace-layout">
                                  <div className="timeline">
                                    <div className="timeline-heading">
                                      <span>EXECUTION TRACE</span>
                                      <span>
                                        {selectedRun.completion_reason?.replaceAll('_', ' ')}
                                      </span>
                                    </div>
                                    {selectedRun.events.length ? (
                                      selectedRun.events.map((event) => (
                                        <button
                                          key={event.id}
                                          id={`event-${event.id}`}
                                          className={`trace-event ${event.id === eventId ? 'selected' : ''} ${event.status && event.status >= 400 ? 'event-error' : ''}`}
                                          onClick={() => setEventId(event.id)}
                                          aria-pressed={event.id === eventId}
                                        >
                                          <span className={`event-node ${event.kind}`}>
                                            <Icon
                                              name={
                                                event.status && event.status >= 400
                                                  ? 'alert'
                                                  : event.kind === 'tool'
                                                    ? 'bolt'
                                                    : event.kind === 'completion'
                                                      ? 'check'
                                                      : 'grid'
                                              }
                                              size={13}
                                            />
                                          </span>
                                          <span className="event-description">
                                            <span className="event-step">
                                              STEP {String(event.step).padStart(2, '0')}{' '}
                                              <span>{event.kind}</span>
                                            </span>
                                            <strong>
                                              {event.tool ?? event.state.replaceAll('_', ' ')}
                                            </strong>
                                            <span className="event-footer">
                                              {event.kind === 'tool' && (
                                                <>
                                                  <span
                                                    className={
                                                      event.status && event.status < 400
                                                        ? 'http-success'
                                                        : 'http-error'
                                                    }
                                                  >
                                                    {event.status ?? 'ERR'}
                                                  </span>
                                                  <span>{duration(event.latency_ms)}</span>
                                                </>
                                              )}
                                              {event.attempt > 1 && (
                                                <span className="retry-label">
                                                  retry {event.attempt - 1}
                                                </span>
                                              )}
                                            </span>
                                          </span>
                                          <Icon name="chevron" size={14} />
                                        </button>
                                      ))
                                    ) : (
                                      <Empty title="No recorded events">
                                        This run has no trajectory events.
                                      </Empty>
                                    )}
                                  </div>
                                  <div className="event-inspector">
                                    {selectedEvent ? (
                                      <>
                                        <div className="inspector-heading">
                                          <div>
                                            <span className="section-kicker">EVENT DETAIL</span>
                                            <h3>
                                              {selectedEvent.tool ??
                                                selectedEvent.state.replaceAll('_', ' ')}
                                            </h3>
                                          </div>
                                          <Badge
                                            tone={
                                              selectedEvent.status && selectedEvent.status >= 400
                                                ? 'red'
                                                : 'green'
                                            }
                                          >
                                            {selectedEvent.status ?? selectedEvent.kind}
                                          </Badge>
                                        </div>
                                        <div className="event-meta">
                                          <span>
                                            Event <code>{shortId(selectedEvent.id)}</code>
                                          </span>
                                          <span>
                                            Attempt <code>{selectedEvent.attempt}</code>
                                          </span>
                                          <span>
                                            Latency{' '}
                                            <code>{duration(selectedEvent.latency_ms)}</code>
                                          </span>
                                        </div>
                                        {selectedEvent.error && (
                                          <div className="inline-warning">
                                            {selectedEvent.error}
                                          </div>
                                        )}
                                        <JsonBlock
                                          label="REQUEST ARGUMENTS"
                                          value={selectedEvent.arguments}
                                        />
                                        <JsonBlock
                                          label="RESPONSE / EVIDENCE"
                                          value={selectedEvent.result}
                                        />
                                        {selectedEvent.state_changes?.length > 0 && (
                                          <JsonBlock
                                            label="RECORDED STATE CHANGES"
                                            value={selectedEvent.state_changes}
                                          />
                                        )}
                                        <div className="linked-criteria">
                                          <span className="section-kicker">
                                            LINKED RUBRIC CRITERIA
                                          </span>
                                          {activeCriteria.length ? (
                                            activeCriteria.map((criterion) => (
                                              <button
                                                key={criterion.id}
                                                onClick={() => setTab('rubric')}
                                              >
                                                <Icon
                                                  name={criterion.passed ? 'check' : 'close'}
                                                  size={14}
                                                />
                                                {criterion.label}
                                                <span>
                                                  {criterion.earned}/{criterion.weight}
                                                </span>
                                              </button>
                                            ))
                                          ) : (
                                            <p className="muted small-text">
                                              No criterion links to this event.
                                            </p>
                                          )}
                                        </div>
                                        <details className="correlation">
                                          <summary>Correlation & parent identifiers</summary>
                                          <p>
                                            Correlation: <code>{selectedEvent.correlation_id}</code>
                                          </p>
                                          <p>
                                            Parent:{' '}
                                            <code>
                                              {selectedEvent.parent_event_id ?? 'Root event'}
                                            </code>
                                          </p>
                                          <p>Recorded: {selectedEvent.started_at}</p>
                                        </details>
                                      </>
                                    ) : (
                                      <Empty title="Choose a trace event">
                                        Inspect its arguments, response, and linked rubric evidence.
                                      </Empty>
                                    )}
                                  </div>
                                </div>
                              )}
                              {tab === 'rubric' && (
                                <div className="rubric-content">
                                  <div className="rubric-intro">
                                    <div>
                                      <h3>Deterministic rubric</h3>
                                      <p>
                                        Assertions inspect recorded behavior and final database
                                        state. Alternative valid tool orderings can pass.
                                      </p>
                                    </div>
                                    <span className="rubric-total">
                                      {selectedRun.report.score}
                                      <small>/ 100 points</small>
                                    </span>
                                  </div>
                                  {selectedRun.report.criteria.map((criterion) => (
                                    <CriterionRow
                                      key={criterion.id}
                                      criterion={criterion}
                                      onEvent={inspectEvent}
                                    />
                                  ))}
                                  <div className="security-panel">
                                    <h3>
                                      <Icon name="shield" />
                                      Security & policy findings{' '}
                                      <Badge
                                        tone={
                                          selectedRun.report.violations.length ? 'red' : 'green'
                                        }
                                      >
                                        {selectedRun.report.violations.length}
                                      </Badge>
                                    </h3>
                                    {selectedRun.report.violations.length ? (
                                      selectedRun.report.violations.map((violation, index) => (
                                        <div
                                          className="violation"
                                          key={`${violation.rule}-${index}`}
                                        >
                                          <strong>{violation.rule.replaceAll('_', ' ')}</strong>
                                          <p>Attempted: {pretty(violation.attempted_action)}</p>
                                          <p>Observed: {pretty(violation.observed)}</p>
                                          <p>Expected: {pretty(violation.expected)}</p>
                                          {violation.event_id && (
                                            <button
                                              className="text-button"
                                              onClick={() => inspectEvent(violation.event_id)}
                                            >
                                              Inspect event {shortId(violation.event_id)}{' '}
                                              <Icon name="arrow" size={13} />
                                            </button>
                                          )}
                                        </div>
                                      ))
                                    ) : (
                                      <p className="muted">
                                        No policy violations recorded for this trajectory.
                                      </p>
                                    )}
                                  </div>
                                </div>
                              )}
                              {tab === 'state' && (
                                <div className="state-content">
                                  <div className="rubric-intro">
                                    <div>
                                      <h3>Database state changes</h3>
                                      <p>
                                        {stateAvailable
                                          ? 'Recorded differences between the initial seed and the final isolated run scope.'
                                          : 'A state comparison requires complete initial and final observations.'}
                                      </p>
                                    </div>
                                    {stateAvailable ? (
                                      <Badge>{selectedRun.state_diff.length} changes</Badge>
                                    ) : (
                                      <Badge tone="amber">Unavailable</Badge>
                                    )}
                                  </div>
                                  {!stateAvailable ? (
                                    <Empty title="State comparison unavailable">
                                      The initial or final snapshot is missing or incomplete. The
                                      recorded evidence cannot establish which database changes
                                      occurred.
                                    </Empty>
                                  ) : selectedRun.state_diff.length ? (
                                    selectedRun.state_diff.map((diff, index) => (
                                      <div
                                        className="diff-card"
                                        key={`${diff.entity}-${diff.id}-${index}`}
                                      >
                                        <div className="diff-label">
                                          <Icon name="layers" size={15} />
                                          <strong>{diff.entity}</strong>
                                          <code>{diff.id}</code>
                                          <Badge
                                            tone={
                                              diff.before == null
                                                ? 'green'
                                                : diff.after == null
                                                  ? 'red'
                                                  : 'amber'
                                            }
                                          >
                                            {diff.before == null
                                              ? 'Added'
                                              : diff.after == null
                                                ? 'Removed'
                                                : 'Modified'}
                                          </Badge>
                                        </div>
                                        <div className="diff-columns">
                                          <JsonBlock label="BEFORE" value={diff.before} />
                                          <JsonBlock label="AFTER" value={diff.after} />
                                        </div>
                                      </div>
                                    ))
                                  ) : (
                                    <Empty title="No persistent changes">
                                      The database state remained the same as the initial seed.
                                    </Empty>
                                  )}
                                  <details className="full-snapshot">
                                    <summary>Inspect initial and final snapshots</summary>
                                    <div className="diff-columns">
                                      <JsonBlock
                                        label="INITIAL STATE"
                                        value={selectedRun.initial_state}
                                      />
                                      <JsonBlock
                                        label="FINAL STATE"
                                        value={selectedRun.final_state}
                                      />
                                    </div>
                                  </details>
                                </div>
                              )}
                              {tab === 'compare' && (
                                <div className="comparison-content">
                                  <div className="rubric-intro">
                                    <div>
                                      <h3>Compare execution outcomes</h3>
                                      <p>
                                        Delta values represent the comparison run relative to the
                                        selected run.
                                      </p>
                                    </div>
                                  </div>
                                  <label className="field-label" htmlFor="comparison-run">
                                    Comparison run
                                  </label>
                                  <select
                                    id="comparison-run"
                                    value={comparisonId}
                                    onChange={(event) => void compare(event.target.value)}
                                  >
                                    <option value="">Select another run…</option>
                                    {runs
                                      .filter(
                                        (run) =>
                                          run.id !== selectedRun.id &&
                                          run.score !== null &&
                                          run.status !== 'running',
                                      )
                                      .map((run) => (
                                        <option key={run.id} value={run.id}>
                                          {run.scenario_name} · {providerLabel(run.provider)} ·{' '}
                                          {run.score ?? '—'}/100 · {shortId(run.id)}
                                        </option>
                                      ))}
                                  </select>
                                  {comparing && <p role="status">Loading comparison…</p>}
                                  {comparison && (
                                    <div className="comparison-result">
                                      <div className="comparison-metrics">
                                        <Metric
                                          label="SCORE DELTA"
                                          value={`${comparison.score_delta > 0 ? '+' : ''}${comparison.score_delta}`}
                                          detail="Comparison minus selected run"
                                          icon="compare"
                                        />
                                        <Metric
                                          label="TOOL CALL DELTA"
                                          value={`${comparison.tool_call_delta > 0 ? '+' : ''}${comparison.tool_call_delta}`}
                                          detail="Comparison minus selected run"
                                          icon="bolt"
                                        />
                                      </div>
                                      <table>
                                        <thead>
                                          <tr>
                                            <th>Criterion</th>
                                            <th>Selected run</th>
                                            <th>Comparison run</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {comparison.criteria.map((criterion) => (
                                            <tr key={criterion.id}>
                                              <td>{criterion.id.replaceAll('_', ' ')}</td>
                                              <td>
                                                <Badge
                                                  tone={criterion.left_passed ? 'green' : 'red'}
                                                >
                                                  {criterion.left_passed ? 'Pass' : 'Fail'}
                                                </Badge>
                                              </td>
                                              <td>
                                                <Badge
                                                  tone={criterion.right_passed ? 'green' : 'red'}
                                                >
                                                  {criterion.right_passed ? 'Pass' : 'Fail'}
                                                </Badge>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      {(comparison.comparable === false ||
                                        comparison.left.scenario_id !==
                                          comparison.right.scenario_id) && (
                                        <p className="inline-warning">
                                          {comparison.note ??
                                            'These runs use different scenario snapshots. Their assertions and difficulty may differ.'}
                                        </p>
                                      )}
                                    </div>
                                  )}
                                  <div className="golden-panel">
                                    <h3>Reference path comparison</h3>
                                    <p className="muted">
                                      A diagnostic reference. The rubric evaluates policy and state
                                      invariants rather than exact sequence matching.
                                    </p>
                                    <div className="golden-path">
                                      {selectedRun.report.golden_comparison.expected.map(
                                        (tool, index) => (
                                          <span key={`${tool}-${index}`}>
                                            <code>{tool}</code>
                                            {index <
                                              selectedRun.report.golden_comparison.expected.length -
                                                1 && <Icon name="arrow" size={13} />}
                                          </span>
                                        ),
                                      )}
                                    </div>
                                    <div className="golden-differences">
                                      <div>
                                        <strong>Missing reference tools</strong>
                                        <p>
                                          {selectedRun.report.golden_comparison.missing.join(
                                            ', ',
                                          ) || 'None'}
                                        </p>
                                      </div>
                                      <div>
                                        <strong>Additional tools</strong>
                                        <p>
                                          {selectedRun.report.golden_comparison.extra.join(', ') ||
                                            'None'}
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                          <div
                            className={`final-response ${selectedRun.passed ? '' : 'unverified'}`}
                          >
                            <div className="response-icon">
                              <Icon name={selectedRun.passed ? 'check' : 'book'} size={20} />
                            </div>
                            <div>
                              <div className="response-title">
                                <h3>Agent conclusion</h3>
                                <Badge>
                                  {selectedRun.final_response.decision.replaceAll('_', ' ')}
                                </Badge>
                              </div>
                              <p>{selectedRun.final_response.summary}</p>
                              <p className="recommended-action">
                                {selectedRun.final_response.recommended_action}
                              </p>
                              <div className="evidence-list">
                                <span>EVIDENCE</span>
                                {selectedRun.final_response.evidence_ids.length ? (
                                  selectedRun.final_response.evidence_ids.map((id) => (
                                    <code key={id}>{id}</code>
                                  ))
                                ) : (
                                  <span className="muted">No references cited</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </section>
                  ) : (
                    <div className="welcome-panel">
                      <div className="welcome-visual">
                        <span className="welcome-orbit" />
                        <Icon name="bolt" size={42} />
                        <span className="visual-caption">PLAN → ACT → VERIFY → EVALUATE</span>
                      </div>
                      <div>
                        <span className="section-kicker">YOUR FIRST EVALUATION</span>
                        <h2>Put an agent on the plant floor.</h2>
                        <p>
                          Choose a maintenance scenario and watch a bounded agent investigate
                          equipment, retrieve evidence, and perform authorized actions through real
                          APIs.
                        </p>
                        <button
                          className="button primary"
                          onClick={() => newRun()}
                          disabled={!scenarios.length}
                        >
                          <Icon name="play" size={15} />
                          Run your first evaluation
                        </button>
                        <small>No model key required. The baseline is deterministic.</small>
                      </div>
                    </div>
                  )}
                  {runs.length > 0 && (
                    <section className="recent-section">
                      <div className="section-title">
                        <div>
                          <span className="section-kicker">RUN LEDGER</span>
                          <h2>Recent evaluations</h2>
                        </div>
                        <button className="text-button" onClick={() => setPage('runs')}>
                          View all runs <Icon name="arrow" size={15} />
                        </button>
                      </div>
                      <RunTable
                        runs={runs.slice(0, 5)}
                        selectedId={selectedRun?.id}
                        onSelect={(id) => {
                          void loadRun(id);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      />
                    </section>
                  )}
                </>
              )}
              {page === 'scenarios' && (
                <>
                  <div className="list-toolbar">
                    <div className="filter-tabs" role="group" aria-label="Scenario category">
                      {['all', 'normal', 'reliability', 'security'].map((value) => (
                        <button
                          key={value}
                          className={category === value ? 'active' : ''}
                          aria-pressed={category === value}
                          onClick={() => setCategory(value)}
                        >
                          {value === 'all' ? 'All scenarios' : value}
                          <span>
                            {value === 'all'
                              ? scenarios.length
                              : scenarios.filter((s) => s.category === value).length}
                          </span>
                        </button>
                      ))}
                    </div>
                    <Search value={query} onChange={setQuery} placeholder="Search scenarios…" />
                  </div>
                  <div className="scenario-grid">
                    {filteredScenarios.map((scenario, index) => (
                      <article className="scenario-card" key={scenario.id}>
                        <div className="scenario-card-top">
                          <span className={`scenario-icon ${scenario.category}`}>
                            <Icon
                              name={
                                scenario.category === 'security'
                                  ? 'shield'
                                  : scenario.category === 'reliability'
                                    ? 'repeat'
                                    : 'bolt'
                              }
                              size={22}
                            />
                          </span>
                          <Badge
                            tone={
                              scenario.category === 'security'
                                ? 'purple'
                                : scenario.category === 'reliability'
                                  ? 'amber'
                                  : 'green'
                            }
                          >
                            {scenario.category}
                          </Badge>
                        </div>
                        <span className="scenario-number">
                          SCENARIO {String(index + 1).padStart(2, '0')} · {scenario.asset_id}
                        </span>
                        <h3>{scenario.name}</h3>
                        <p>{scenario.description}</p>
                        <div className="scenario-card-bottom">
                          <span>
                            <Icon name="shield" size={13} />
                            {scenario.actor.role}
                          </span>
                          <button className="text-button" onClick={() => newRun(scenario.id)}>
                            Evaluate <Icon name="arrow" size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  {!filteredScenarios.length && (
                    <Empty title="No matching scenarios">Try another search or category.</Empty>
                  )}
                </>
              )}
              {page === 'runs' && (
                <>
                  <div className="list-toolbar">
                    <span className="muted">{runs.length} evaluations · most recent first</span>
                    <Search value={query} onChange={setQuery} placeholder="Search runs…" />
                  </div>
                  {filteredRuns.length ? (
                    <RunTable
                      runs={filteredRuns}
                      selectedId={selectedRun?.id}
                      onSelect={(id) => {
                        void loadRun(id);
                        setPage('overview');
                      }}
                    />
                  ) : (
                    <Empty title={runs.length ? 'No matching evaluations' : 'No evaluations yet'}>
                      {runs.length
                        ? 'Try a different scenario, provider, or run identifier.'
                        : 'Create an evaluation to populate the run ledger.'}
                    </Empty>
                  )}
                </>
              )}
              {page === 'methodology' && <Methodology />}
            </>
          )}
          <footer>
            <span>INDUSTRIAL AGENT LAB</span>
            <span>Replayable by design. Verifiable by evidence.</span>
            <span>
              LOCAL REVIEW CONSOLE <span className="footer-dot" />
            </span>
          </footer>
        </main>
      </div>
      {modal === 'run' && (
        <Modal title="New evaluation" onClose={() => !busy && setModal(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute();
            }}
          >
            <p className="modal-description">
              Execute an agent against live services in a fresh PostgreSQL data scope.
            </p>
            <label className="field-label" htmlFor="scenario">
              Scenario
            </label>
            <select
              id="scenario"
              value={scenarioId}
              onChange={(event) => setScenarioId(event.target.value)}
              disabled={busy}
            >
              {scenarios.map((scenario) => (
                <option value={scenario.id} key={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
            {selectedScenario && (
              <div className="scenario-preview">
                <Badge
                  tone={
                    selectedScenario.category === 'security'
                      ? 'purple'
                      : selectedScenario.category === 'reliability'
                        ? 'amber'
                        : 'green'
                  }
                >
                  {selectedScenario.category}
                </Badge>
                <p>{selectedScenario.request}</p>
                <small>
                  {selectedScenario.actor.role} · {selectedScenario.actor.facility_id} ·{' '}
                  {selectedScenario.asset_id}
                </small>
              </div>
            )}
            <label className="field-label" htmlFor="provider">
              Agent provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as Provider)}
              disabled={busy}
            >
              <option value="baseline">Deterministic baseline · no model key</option>
              <option value="careless">Flawed candidate · intentional evaluation failures</option>
              <option value="openai-compatible">
                Live model · requires server provider configuration
              </option>
            </select>
            <p className="provider-explanation">
              {provider === 'baseline'
                ? 'An evidence-driven scripted policy. Uses real HTTP tools and persistent database mutations; no external model call.'
                : provider === 'careless'
                  ? 'A deliberately flawed policy for testing the evaluator. Expect policy or evidence failures in the recorded trajectory.'
                  : 'Configure the endpoint and model on the server. Supply credentials if the provider requires them.'}
            </p>
            {error && (
              <p className="inline-warning" role="alert">
                {error}
              </p>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={busy || !scenarioId}>
                {busy ? (
                  <>
                    <span className="spinner" />
                    Executing real tools…
                  </>
                ) : (
                  <>
                    <Icon name="play" size={15} />
                    Start evaluation
                  </>
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'settings' && (
        <Modal title="Reviewer settings" onClose={() => setModal(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setToken(tokenDraft);
              setModal(null);
            }}
          >
            <p className="modal-description">
              The reviewer key authorizes starting and replaying runs. Read access uses the local
              review endpoints.
            </p>
            <label className="field-label" htmlFor="review-token">
              Reviewer API key
            </label>
            <input
              id="review-token"
              type="password"
              autoComplete="off"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
            <p className="provider-explanation">
              Stored only in this browser tab’s session storage. The local development default is{' '}
              <code>local-review-key</code>.
            </p>
            <div className="modal-footer">
              <button type="button" className="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button type="submit" className="button primary">
                Save settings
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  detail,
  icon,
}: {
  label: string;
  value: string;
  suffix?: string;
  detail: string;
  icon: IconName;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Icon name={icon} size={17} />
      </div>
      <div className="metric-value">
        {value}
        {suffix && <span>{suffix}</span>}
      </div>
      <p>{detail}</p>
    </div>
  );
}
function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <Icon name="search" size={16} />
      <input
        aria-label={placeholder.replace('…', '')}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="json-block">
      <span>{label}</span>
      <pre>{pretty(value)}</pre>
    </div>
  );
}
function CriterionRow({
  criterion,
  onEvent,
}: {
  criterion: Criterion;
  onEvent: (id: string) => void;
}) {
  return (
    <details
      className={`criterion ${criterion.passed ? 'passed' : 'failed'}`}
      open={!criterion.passed}
    >
      <summary>
        <span className="criterion-status">
          <Icon name={criterion.passed ? 'check' : 'close'} size={15} />
        </span>
        <span className="criterion-name">
          <strong>{criterion.label}</strong>
          <small>{criterion.explanation}</small>
        </span>
        <span className="criterion-score">
          {criterion.earned}
          <span> / {criterion.weight}</span>
        </span>
        <Icon name="chevron" size={15} />
      </summary>
      <div className="criterion-detail">
        <div className="diff-columns">
          <JsonBlock label="EXPECTED" value={criterion.expected} />
          <JsonBlock label="OBSERVED" value={criterion.observed} />
        </div>
        <div className="criterion-evidence">
          <span>TRACE EVIDENCE</span>
          {criterion.event_ids.length ? (
            criterion.event_ids.map((id) => (
              <button key={id} onClick={() => onEvent(id)}>
                {shortId(id)} <Icon name="external" size={12} />
              </button>
            ))
          ) : (
            <span className="muted">Evaluated against state or final response</span>
          )}
        </div>
      </div>
    </details>
  );
}
function RunTable({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="table-container">
      <table className="run-table">
        <thead>
          <tr>
            <th>Scenario / run</th>
            <th>Agent</th>
            <th>Result</th>
            <th>Score</th>
            <th>Tool calls</th>
            <th>Created</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className={run.id === selectedId ? 'current' : ''}>
              <td>
                <button className="run-link" onClick={() => onSelect(run.id)}>
                  {run.scenario_name}
                  <small>
                    {shortId(run.id)} <span>· {run.category}</span>
                  </small>
                </button>
              </td>
              <td>
                <span className="provider-cell">
                  <span className={`provider-dot ${run.provider}`} />
                  {providerLabel(run.provider)}
                </span>
              </td>
              <td>
                <Badge tone={run.passed === null ? 'amber' : run.passed ? 'green' : 'red'}>
                  {run.passed === null ? run.status : run.passed ? 'Passed' : 'Failed'}
                </Badge>
              </td>
              <td>
                <strong className="table-score">{run.score ?? '—'}</strong>
                <span className="subtle"> / 100</span>
              </td>
              <td className="mono">{run.tool_calls}</td>
              <td className="date-cell">
                {new Date(run.created_at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Open ${run.scenario_name} ${shortId(run.id)}`}
                  onClick={() => onSelect(run.id)}
                >
                  <Icon name="arrow" size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Methodology() {
  return (
    <div className="methodology">
      <article className="methodology-lead">
        <span className="section-kicker">THE EVALUATION CONTRACT</span>
        <h2>Judge what the agent actually did.</h2>
        <p>
          Each evaluation creates an isolated scenario scope, executes a bounded agent through real
          HTTP tools, records the trajectory, and grades the observed state. Tool servers enforce
          permissions independently of the agent’s instructions.
        </p>
      </article>
      <div className="methodology-grid">
        {[
          {
            weight: '30%',
            title: 'Correct final state',
            text: 'Assert work-order counts, reservations, assignments, priorities, and operational decisions against the scenario’s expected outcome.',
          },
          {
            weight: '25%',
            title: 'Authorization & safety',
            text: 'Check scoped access, role restrictions, unauthorized action attempts, and forbidden equipment transitions.',
          },
          {
            weight: '20%',
            title: 'Appropriate tool use',
            text: 'Require the tools necessary to support the workflow while inspecting actual events rather than trusting the agent’s narrative.',
          },
          {
            weight: '15%',
            title: 'Evidence & freshness',
            text: 'Verify references to applicable approved procedures and current usable telemetry, including unit interpretation.',
          },
          {
            weight: '10%',
            title: 'Recovery & efficiency',
            text: 'Inspect bounded calls, retry behavior, safe recovery, and idempotent mutations after ambiguous failures.',
          },
        ].map((item) => (
          <article key={item.title} className="method-card">
            <strong>{item.weight}</strong>
            <h3>{item.title}</h3>
            <p>{item.text}</p>
          </article>
        ))}
      </div>
      <div className="methodology-bottom">
        <article>
          <Icon name="repeat" size={23} />
          <h3>Replay means fresh execution</h3>
          <p>
            A replay creates a new isolated scope from the same scenario and runs the same provider
            again. Deterministic policies have reproducible behavior; IDs and measured wall-clock
            latency may vary. External live models may produce different trajectories.
          </p>
        </article>
        <article>
          <Icon name="shield" size={23} />
          <h3>Server enforcement is the boundary</h3>
          <p>
            Agent credentials are run scoped. The tool API checks actor permissions, tenant and
            facility scope, evidence relationships, and mutation transitions. Audit and trace
            outputs are sanitized before they reach the reviewer.
          </p>
        </article>
        <article>
          <Icon name="compare" size={23} />
          <h3>A reference, not an exact script</h3>
          <p>
            The golden path explains missing or additional tool use. Correctness comes from state
            invariants, evidence, and policy assertions. Equivalent valid action orderings are
            allowed.
          </p>
        </article>
      </div>
      <p className="methodology-footnote">
        The deterministic baseline and deliberately flawed candidate exercise live REST services and
        PostgreSQL without external model calls. Optional live-provider runs are explicitly labeled.
        Exact scenario assertions are available in the repository’s trusted scenario specifications.
      </p>
    </div>
  );
}

export default App;
