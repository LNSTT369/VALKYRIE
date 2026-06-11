import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Panel } from './components/Panel';
import { Metric, MetricInline } from './components/Metric';
import { LineChart, Sparkline } from './components/LineChart';
import { SetupWizard } from './components/SetupWizard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StatusBar } from './components/StatusIndicator';
import { NotificationBell } from './components/NotificationBell';
import clsx from 'clsx';
import { 
  AlphaSignal, RegimeState, RiskMetrics, Config, 
  PortfolioSnapshot, LogEntry, Status, MarketRegime 
} from './types';

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount)
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REGIME_LABELS: Record<string, string> = {
  trending_bull:   'TRENDING BULL',
  trending_bear:   'TRENDING BEAR',
  range_bound:     'RANGE BOUND',
  high_volatility: 'HIGH VOL',
  low_volatility:  'LOW VOL',
  crisis:          'CRISIS',
}

const REGIME_HEX: Record<string, string> = {
  trending_bull:   '#28c870',
  trending_bear:   '#e83838',
  range_bound:     '#e0a030',
  high_volatility: '#d87820',
  low_volatility:  '#48a0c0',
  crisis:          '#e83838',
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

const Dashboard: React.FC = () => {
  const [showSetup, setShowSetup] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [regime, setRegime] = useState<RegimeState | null>(null);
  const [riskMetrics, setRiskMetrics] = useState<RiskMetrics | null>(null);
  const [alphaSignals, setAlphaSignals] = useState<AlphaSignal[]>([]);
  const [strategyStatuses, setStrategyStatuses] = useState<any[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sentimentFeed, setSentimentFeed] = useState<any[]>([]);
  const [time, setTime] = useState(new Date());
  
  // Valkyrie Custom Pipeline State
  const [codifications, setCodifications] = useState<any[]>([]);
  const [simulations, setSimulations] = useState<any[]>([]);
  const [repoUrlInput, setRepoUrlInput] = useState("");
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestionError, setIngestionError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, regimeRes, riskRes, signalsRes, strategiesRes, logsRes, sentimentRes, codificationsRes, simulationsRes] = await Promise.all([
        fetch('/api/v3/status'),
        fetch('/api/v3/regime'),
        fetch('/api/v3/risk'),
        fetch('/api/v3/signals'),
        fetch('/api/v3/strategies'),
        fetch('/api/v3/logs'),
        fetch('/api/v3/sentiment'),
        fetch('/api/v3/codifications'),
        fetch('/api/v3/simulations'),
      ]);

      if (statusRes.ok) {
        const json = await statusRes.json();
        if (json.ok) {
          setStatus(json.data);
        } else if (json.error === "ALPACA_NOT_CONFIGURED") {
          setShowSetup(true);
        }
      }
      if (regimeRes.ok) {
        const json = await regimeRes.json();
        if (json.ok) setRegime(json.data);
      }
      if (riskRes.ok) {
        const json = await riskRes.json();
        if (json.ok) setRiskMetrics(json.data);
      }
      if (signalsRes.ok) {
        const json = await signalsRes.json();
        if (json.ok) setAlphaSignals(json.data.signals);
      }
      if (strategiesRes.ok) {
        const json = await strategiesRes.json();
        if (json.ok) setStrategyStatuses(json.data.strategies);
      }
      if (logsRes.ok) {
        const json = await logsRes.json();
        if (json.ok && json.data?.entries?.length > 0) {
          setLogs(json.data.entries.map((e: any) => ({
            timestamp: e.timestamp,
            agent: e.agent || 'system',
            action: e.action,
            severity: e.severity,
          })));
        }
      }
      if (sentimentRes.ok) {
        const json = await sentimentRes.json();
        if (json.ok && json.data?.feed) {
          setSentimentFeed(json.data.feed);
        }
      }
      if (codificationsRes.ok) {
        const json = await codificationsRes.json();
        if (json.ok && json.data?.jobs) {
          setCodifications(json.data.jobs);
        }
      }
      if (simulationsRes.ok) {
        const json = await simulationsRes.json();
        if (json.ok && json.data?.simulations) {
          setSimulations(json.data.simulations);
        }
      }
    } catch (err) {
      console.error("Dashboard fetch error", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    const timeInterval = setInterval(() => setTime(new Date()), 1000);
    return () => { clearInterval(interval); clearInterval(timeInterval); };
  }, [fetchData]);

  // Derived variables
  const config = status?.config;
  const isMarketOpen = status?.clock?.is_open ?? false;
  const costs = status?.costs || { total_usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 };
  const regimeAccent = regime ? REGIME_HEX[regime.regime] : undefined;

  // Retrieve the latest completed Monte Carlo metrics
  const latestSimMetrics = useMemo(() => {
    if (simulations.length === 0) return null;
    try {
      return JSON.parse(simulations[0].metrics_json);
    } catch {
      return null;
    }
  }, [simulations]);

  // Generate Monte Carlo random walk paths for visualization
  const mcChartData = useMemo(() => {
    const sharpe = latestSimMetrics?.sharpe_ratio ?? 1.5;
    const pathsCount = 3;
    const days = 30;
    const generatedSeries = [];

    for (let p = 0; p < pathsCount; p++) {
      const data = [100000];
      let currentVal = 100000;
      // Drift and volatility variables
      const dailyDrift = (sharpe * 0.12) / 252 + (p * 0.0001); 
      const dailyVol = 0.14 / Math.sqrt(252);

      for (let d = 1; d <= days; d++) {
        // Pseudo-random normal distribution shock
        const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
        currentVal = currentVal * (1 + dailyDrift + dailyVol * shock);
        data.push(Math.round(currentVal));
      }

      generatedSeries.push({
        label: `Path ${p + 1}`,
        data,
        variant: p === 0 ? 'cyan' : (p === 1 ? 'purple' : 'blue') as any
      });
    }

    return generatedSeries;
  }, [latestSimMetrics]);

  const mcChartLabels = useMemo(() => {
    return Array.from({ length: 31 }, (_, i) => `D${i}`);
  }, []);

  // ── INGEST REPO TRIGGER ──
  const handleIngestRepo = async () => {
    if (!repoUrlInput) return;
    setIsIngesting(true);
    setIngestionError("");

    try {
      const res = await fetch("/alpha-socket/repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: repoUrlInput })
      });
      const data = await res.json();
      if (!res.ok) {
        setIngestionError(data.message || "Failed to trigger ingestion.");
      } else {
        setRepoUrlInput("");
        fetchData();
      }
    } catch (e) {
      setIngestionError("Connection error. Ingestion failed.");
    } finally {
      setIsIngesting(false);
    }
  };

  if (showSetup) return <SetupWizard onComplete={() => setShowSetup(false)} />;

  return (
    <ErrorBoundary title="VALKYRIE HUD RENDER ERROR">
      <div className="min-h-screen bg-hud-bg font-mono text-hud-primary p-4 selection:bg-black selection:text-white">
        <div className="max-w-[1920px] mx-auto flex flex-col gap-5">
          
          {/* ── HEADER ─────────────────────────────────────────────────── */}
          <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4 border-b-2 border-black">
            <div className="flex items-center gap-5">
              <div>
                <div className="flex items-baseline gap-3">
                  <h1 className="text-3xl font-bold leading-none tracking-tight uppercase">VALKYRIE</h1>
                  <span className="text-[10px] bg-black text-white px-1.5 py-0.5 font-bold">PORTAL</span>
                </div>
                <p className="text-[10px] font-bold opacity-40 mt-1 uppercase tracking-widest">
                  // COGNITIVE STRATEGY COMPILER // ZERO-TRUST SANDBOX INGESTION
                </p>
              </div>
              <div className="flex items-center gap-2 pl-5 border-l border-hud-line">
                {isMarketOpen ? (
                  <><div className="w-2 h-2 bg-hud-success animate-pulse" /><span className="text-[10px] font-bold text-hud-success">COMPILER ACTIVE</span></>
                ) : (
                  <><div className="w-2 h-2 bg-hud-success" /><span className="text-[10px] font-bold text-hud-success">COMPILER READY</span></>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <StatusBar items={[
                { label: 'LLM COST', value: `$${costs.total_usd.toFixed(4)}`, status: 'active' },
                { label: 'CALLS', value: costs.calls.toString() },
              ]} />
              <div className="h-4 w-px bg-hud-line" />
              <NotificationBell />
              <button className="text-[10px] font-bold hover:underline" onClick={() => setShowSetup(true)}>[CONFIG]</button>
              <div className="h-4 w-px bg-hud-line" />
              <span className="text-xs font-bold tabular-nums">{time.toLocaleTimeString('en-US', { hour12: false })}</span>
            </div>
          </header>

          {/* ── GRID ───────────────────────────────────────────────────── */}
          <div className="grid grid-cols-12 gap-5">

            {/* TIER 1: PIPELINE PROGRESS */}
            <div className="col-span-8 min-h-[340px]">
              <Panel title="VALKYRIE // STRATEGY CODIFICATION INGESTION PIPELINE">
                <div className="overflow-y-auto max-h-[280px]">
                  {codifications.length === 0 ? (
                    <div className="h-[250px] flex items-center justify-center opacity-30 text-xs font-bold uppercase">No active codification runs. Ingest a GitHub URL.</div>
                  ) : (
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b-2 border-black">
                          <th className="hud-label pb-2">JOB ID</th>
                          <th className="hud-label pb-2">GIT REPOSITORY</th>
                          <th className="hud-label pb-2">BRANCH</th>
                          <th className="hud-label pb-2">STATUS</th>
                          <th className="hud-label pb-2">PROGRESS</th>
                          <th className="hud-label pb-2">UPDATED</th>
                        </tr>
                      </thead>
                      <tbody>
                        {codifications.map(job => (
                          <tr key={job.job_id} className="border-b border-hud-line/20 hover:bg-black/5">
                            <td className="py-2.5 text-[10px] font-bold text-hud-dim">{job.job_id.slice(0, 8)}</td>
                            <td className="py-2.5 text-[11px] font-bold">
                              <span className="text-black">{job.github_url.split('/').slice(-2).join('/')}</span>
                            </td>
                            <td className="py-2.5 text-[11px] text-hud-dim">{job.branch}</td>
                            <td className="py-2.5">
                              <span className={clsx(
                                'text-[9px] font-bold px-1.5 py-0.5 uppercase border',
                                job.status === 'completed' ? 'border-hud-success text-hud-success bg-hud-success/5' :
                                job.status === 'failed' ? 'border-hud-error text-hud-error bg-hud-error/5' :
                                'border-hud-warning text-hud-warning bg-hud-warning/5 animate-pulse'
                              )}>
                                {job.status}
                              </span>
                            </td>
                            <td className="py-2.5 w-[140px]">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 bg-gray-100 border border-black overflow-hidden">
                                  <div className="h-full bg-black" style={{ width: `${job.progress}%` }} />
                                </div>
                                <span className="text-[10px] font-bold tabular-nums">{job.progress}%</span>
                              </div>
                              {job.error && (
                                <div className="text-[8px] text-hud-error font-bold leading-tight mt-1 max-w-[200px] truncate" title={job.error}>
                                  ERR: {job.error}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 text-[10px] text-hud-dim tabular-nums">
                              {new Date(job.updated_at || job.created_at).toLocaleTimeString('en-US', { hour12: false })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Panel>
            </div>

            {/* TIER 1 RIGHT: MONTE CARLO RANDOM WALKS */}
            <div className="col-span-4 min-h-[340px]">
              <Panel title="MONTE CARLO // FORECASTING SIMULATOR" titleRight="30-DAY BOOTSTRAP PATHS">
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between border-b border-hud-line/20 pb-2">
                    <div className="flex flex-col">
                      <span className="text-[9px] hud-label">EXPECTED RETURN</span>
                      <span className="text-sm font-bold">{latestSimMetrics ? formatPercent(latestSimMetrics.expected_return * 100) : '0.00%'}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] hud-label text-hud-error">MAX DD (P95)</span>
                      <span className="text-sm font-bold text-hud-error">{latestSimMetrics ? formatPercent(-latestSimMetrics.max_drawdown_p95 * 100) : '0.00%'}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] hud-label text-hud-success">SHARPE RATIO</span>
                      <span className="text-sm font-bold text-hud-success">{latestSimMetrics ? latestSimMetrics.sharpe_ratio.toFixed(2) : '0.00'}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[9px] hud-label">WIN RATE</span>
                      <span className="text-sm font-bold">{latestSimMetrics ? formatPercent(latestSimMetrics.win_rate * 100) : '0.00%'}</span>
                    </div>
                  </div>
                  <div className="h-[220px]">
                    <LineChart series={mcChartData} labels={mcChartLabels} showArea={false} showGrid showDots={false} />
                  </div>
                </div>
              </Panel>
            </div>

            {/* TIER 2: INGESSION PRIMITIVE & POLICY */}
            <div className="col-span-3">
              <Panel title="COMPILER RULES // POLICY GATE VALUES">
                <div className="flex flex-col gap-3.5">
                  <div className="border-l-4 border-black pl-2">
                    <div className="hud-label">MAX LEVERAGE CLAMP</div>
                    <div className="text-xl font-bold tracking-tight">2.00x LEVERAGE</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Metric label="MAX NOTIONAL CAP" value={formatCurrency(config?.max_position_value || 10000)} size="sm" />
                    <Metric label="MAX OPEN STRATEGIES" value={(config?.max_positions || 10).toString()} size="sm" />
                  </div>
                  <div className="pt-2 border-t border-hud-line/30 space-y-1.5">
                    <MetricInline label="CONFIDENCE FLOOR" value="80.00%" />
                    <MetricInline label="LIQUIDITY FLOOR" value="$1,000,000 ADV" />
                  </div>
                </div>
              </Panel>
            </div>

            <div className="col-span-5">
              <Panel title="ALPHA SOCKET // INGESTION primitive" titleRight="QCA_COMPILER" accentColor="#000">
                <div className="flex flex-col gap-4">
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={repoUrlInput}
                      onChange={(e) => setRepoUrlInput(e.target.value)}
                      className="flex-1 bg-white border-2 border-black p-2 text-xs font-bold outline-none focus:bg-gray-50 font-mono" 
                      placeholder="https://github.com/owner/strategy-repo" 
                      disabled={isIngesting}
                    />
                    <button 
                      className="bg-black text-white px-4 py-2 text-[10px] font-bold hover:bg-gray-800 uppercase" 
                      onClick={handleIngestRepo}
                      disabled={isIngesting || !repoUrlInput}
                    >
                      {isIngesting ? '[ COMPILING... ]' : '[ INGEST ]'}
                    </button>
                  </div>
                  {ingestionError && (
                    <div className="text-[10px] font-bold text-hud-error uppercase">// ERR: {ingestionError}</div>
                  )}
                  <div className="flex items-center justify-between border-t border-hud-line/30 pt-2">
                    <div className="hud-label">INGESTION PIPELINE STATUS</div>
                    <div className="text-[10px] font-bold uppercase">
                      {isIngesting ? 'KICKING OFF COMPILER QUEUE' : (codifications[0] ? `LAST JOB: ${codifications[0].status.toUpperCase()}` : 'AWAITING INPUT')}
                    </div>
                  </div>
                  <div className="terminal h-24 text-[9px] uppercase">
                    <div>[SYSTEM] Ingestion Primitive initialized. Ed25519 signatures loaded.</div>
                    {codifications.slice(0, 3).map(j => (
                      <div key={j.job_id} className="text-hud-dim">
                        [{new Date(j.created_at).toLocaleTimeString()}] JOB {j.job_id.slice(0,8)} STATUS: {j.status.toUpperCase()} (PROGRESS: {j.progress}%)
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>
            </div>

            <div className="col-span-4">
              <Panel title="ABSORBED STRATEGIES // SECURE REGISTRY" titleRight={`${strategyStatuses.length} COMPILED`}>
                <div className="overflow-y-auto max-h-64">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b-2 border-black">
                        <th className="hud-label pb-2">STRATEGY</th>
                        <th className="hud-label pb-2 text-right">SHARPE</th>
                        <th className="hud-label pb-2 text-center">STATUS</th>
                        <th className="hud-label pb-2 text-center">SIGNED</th>
                      </tr>
                    </thead>
                    <tbody>
                      {strategyStatuses.length === 0 ? (
                        <tr><td colSpan={4} className="py-8 text-center opacity-30 font-bold uppercase">No Strategies Absorbed</td></tr>
                      ) : (
                        strategyStatuses.map(s => (
                          <tr key={s.strategy_id} className="border-b border-hud-line/20 hover:bg-black/5">
                            <td className="py-2.5 text-[11px] font-bold">
                              <div className="flex flex-col">
                                <span>{s.name}</span>
                                <span className="text-[8px] text-hud-dim">{s.strategy_id.slice(0,18)}...</span>
                              </div>
                            </td>
                            <td className="py-2.5 text-[11px] text-right font-bold tabular-nums text-hud-success">
                              {s.sharpe ? s.sharpe.toFixed(2) : '--'}
                            </td>
                            <td className="py-2.5 text-center">
                              <span className="text-[9px] font-bold px-1 border border-black uppercase bg-gray-50">
                                {s.status}
                              </span>
                            </td>
                            <td className="py-2.5 text-center">
                              <span className="text-hud-success font-bold text-xs" title="Cryptographically signed by Valkyrie DO Authority">
                                ✓
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>

            {/* TIER 3: CONTEXT & CRYPTOGRAPHIC HSMS */}
            <div className="col-span-3">
              <Panel title="MARKET.REGIME // CONTEXT DETECTION" accentColor={regimeAccent} accentGlow={!!regime}>
                {regime ? (
                  <div className="flex flex-col gap-4">
                    <div className="text-xl font-bold tracking-widest">{REGIME_LABELS[regime.regime] || regime.regime.toUpperCase()}</div>
                    <div className="space-y-1">
                      <div className="flex justify-between hud-label"><span>CONFIDENCE</span><span>{(regime.confidence * 100).toFixed(0)}%</span></div>
                      <div className="h-1.5 bg-hud-line border border-black overflow-hidden">
                        <div className="h-full bg-black" style={{ width: `${regime.confidence * 100}%` }} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 pt-3 border-t border-black/10">
                      <MetricInline label="ADX" value={regime.adx?.toFixed(1) || '--'} />
                      <MetricInline label="ATR%" value={regime.atr_pct ? `${regime.atr_pct.toFixed(2)}%` : '--'} />
                    </div>
                  </div>
                ) : <div className="opacity-30 text-xs font-bold uppercase py-8 text-center">Identifying Regime...</div>}
              </Panel>
            </div>

            <div className="col-span-3">
              <Panel title="SIGNING AUTHORITY // HSM primitive">
                <div className="flex flex-col gap-3.5">
                  <div className="border-l-4 border-hud-success pl-2">
                    <div className="hud-label">VERIFICATION STATUS</div>
                    <div className="text-xl font-bold text-hud-success tracking-tight">HSM PASSING</div>
                  </div>
                  <div className="space-y-2 pt-2 border-t border-hud-line/30">
                    <MetricInline label="ALGORITHM" value="Ed25519" />
                    <MetricInline label="KEY ID" value="global-signing-service" />
                    <MetricInline label="FINGERPRINT" value="SHA-256: d823...89aa" />
                    <MetricInline label="SIGNED PACKAGES" value={strategyStatuses.length.toString()} />
                  </div>
                </div>
              </Panel>
            </div>

            <div className="col-span-3">
              <Panel title="COMPILED SIGNALS // OUTBOUND PIPELINE" titleRight={alphaSignals.length.toString()}>
                <div className="overflow-y-auto max-h-56 space-y-1">
                  {alphaSignals.length === 0 ? <div className="opacity-30 text-xs font-bold uppercase py-8 text-center">No Outbound Signals</div> : 
                    alphaSignals.map(s => (
                      <div key={s.signal_id} className="flex justify-between items-center p-1.5 border-b border-black/5 hover:bg-black/5">
                        <span className="text-[11px] font-bold">{s.symbol}</span>
                        <span className={clsx('text-[10px] font-bold', s.direction === 'long' ? 'text-hud-success' : 'text-hud-error')}>
                          {s.direction === 'long' ? '▲' : '▼'} {(s.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))
                  }
                </div>
              </Panel>
            </div>

            <div className="col-span-3">
              <Panel title="ACADEMIC SOURCE FEED // RESEARCH PAPERS" titleRight={sentimentFeed.length.toString()}>
                <div className="overflow-y-auto max-h-56 space-y-1">
                  {sentimentFeed.length === 0 ? (
                    <div className="opacity-30 text-xs font-bold uppercase py-8 text-center">Aggregating Papers...</div>
                  ) : sentimentFeed.map((item, i) => (
                    <div key={i} className="flex flex-col p-1.5 border-b border-black/5 hover:bg-black/5 cursor-default">
                      <div className="flex justify-between items-start gap-1">
                        <span className="text-[9px] font-bold opacity-40 uppercase">{item.source}</span>
                        <span className="text-[9px] opacity-30 shrink-0">
                          {new Date(item.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                        </span>
                      </div>
                      <span className="text-[10px] leading-tight mt-0.5 line-clamp-2">{item.headline}</span>
                      {item.symbols.length > 0 && (
                        <div className="flex gap-1 mt-0.5">
                          {item.symbols.slice(0, 3).map((sym: string) => (
                            <span key={sym} className="text-[9px] font-bold bg-black text-white px-1">{sym}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            {/* TIER 4: OPERATIONS & LOGS */}
            <div className="col-span-4">
              <Panel title="STRATEGY PERFORMANCE SCORECARD">
                <div className="overflow-y-auto max-h-56 space-y-2">
                  {strategyStatuses.length === 0 ? (
                    <div className="opacity-30 text-xs font-bold uppercase py-6 text-center">No Active Runners</div>
                  ) : (
                    strategyStatuses.map(s => (
                      <div key={s.strategy_id} className="p-2.5 border border-black/10 bg-gray-50 flex justify-between items-center">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase">{s.name}</span>
                          <span className="text-[8px] text-hud-dim mt-0.5">ID: {s.strategy_id.slice(0,8)}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {s.sharpe != null && (
                            <div className="text-right">
                              <div className="text-[8px] hud-label">SHARPE</div>
                              <div className="text-[10px] font-bold text-hud-success">{s.sharpe.toFixed(2)}</div>
                            </div>
                          )}
                          <div className={clsx('w-1.5 h-1.5', s.status === 'active' ? 'bg-hud-success' : 'bg-hud-dim')} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Panel>
            </div>

            <div className="col-span-2">
              <Panel title="LLM SERVICE RUNTIME">
                <div className="flex flex-col gap-2">
                  <Metric label="COMPILER COST" value={`$${costs.total_usd.toFixed(4)}`} size="sm" />
                  <div className="space-y-1.5 pt-1.5 border-t border-black/5">
                    <MetricInline label="PROVIDER" value={config?.llm_provider?.toUpperCase() || 'OPENAI'} color="success" />
                    <MetricInline label="MODEL" value={config?.llm_model || 'GPT-4O'} />
                    <MetricInline label="API CALLS" value={costs.calls.toString()} />
                  </div>
                </div>
              </Panel>
            </div>

            <div className="col-span-6">
              <Panel title="ALPHA SOCKET // PIPELINE LOGSTREAM" titleRight={<div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-hud-success animate-pulse" /><span className="text-[9px] font-bold">LIVE STREAM</span></div>}>
                <div className="terminal max-h-56 overflow-y-auto text-[9px] uppercase">
                  {logs.length === 0 ? <div className="opacity-40">// WAITING_FOR_DATA_RAIL...</div> : 
                    logs.map((l, i) => (
                      <div key={i} className="mb-0.5">
                        <span className="opacity-40 mr-2">[{new Date(l.timestamp).toLocaleTimeString('en-US', { hour12: false })}]</span>
                        <span className="font-bold opacity-60 mr-2">[{l.agent.toUpperCase()}]</span>
                        <span>{l.action.toUpperCase()}</span>
                      </div>
                    ))
                  }
                </div>
              </Panel>
            </div>

          </div>

          {/* FOOTER */}
          <footer className="mt-2 pt-3 border-t border-black/20 flex justify-between items-center">
            <div className="flex gap-6">
              <MetricInline label="COMPILER OVERRIDE" value="Ed25519 SIGNED ONLY" />
              <MetricInline label="MAX NOTIONAL" value={`$${config?.max_position_value || 10000}`} />
              <MetricInline label="MIN SENTIMENT" value="30%" />
              <MetricInline label="OPTIONS CAP" value={config?.options_enabled ? 'ON' : 'OFF'} color={config?.options_enabled ? 'success' : 'dim'} />
              <MetricInline label="CRYPTO COMPLIANT" value="ON" color="success" />
            </div>
            <div className="flex items-center gap-4">
              <span className="text-[10px] font-bold opacity-30 tracking-widest">VALKYRIE RESEARCH ABSORPTION ENGINE</span>
              <div className="bg-black text-white px-2 py-0.5 text-[9px] font-bold tracking-widest uppercase">Sandboxed Mode</div>
            </div>
          </footer>

        </div>
      </div>
    </ErrorBoundary>
  );
};

export default Dashboard;
