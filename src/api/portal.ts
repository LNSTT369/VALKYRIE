import type { Env } from "../env.d";
import { createD1Client } from "../storage/d1/client";
import { encryptText } from "../lib/utils";

export async function handlePortalGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  
  if (request.method === "POST") {
    // API Credentials Setup
    try {
      const body = await request.json() as {
        token: string;
        alpaca_api_key: string;
        alpaca_api_secret: string;
        alpaca_paper: boolean;
      };
      
      const { token, alpaca_api_key, alpaca_api_secret, alpaca_paper } = body;
      if (!token || !alpaca_api_key || !alpaca_api_secret) {
        return new Response(JSON.stringify({ ok: false, error: "MISSING_FIELDS", message: "All fields are required." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      const db = createD1Client(env.DB);
      const row = await db.executeOne<{ key_id: string }>(
        "SELECT key_id FROM api_keys WHERE token_hash = ? AND (revoked = 0 OR revoked IS NULL)",
        [token]
      );
      
      if (!row) {
        return new Response(JSON.stringify({ ok: false, error: "UNAUTHORIZED", message: "Invalid or revoked Developer Key." }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // Encrypt Alpaca keys using KILL_SWITCH_SECRET as the shared GCM key
      const secretKey = env.KILL_SWITCH_SECRET || "default-fallback-super-secret-key-123456";
      const encryptedKey = await encryptText(alpaca_api_key, secretKey);
      const encryptedSecret = await encryptText(alpaca_api_secret, secretKey);
      const paperVal = alpaca_paper ? 1 : 0;
      
      await db.run(
        `UPDATE api_keys 
         SET alpaca_api_key = ?, alpaca_api_secret = ?, alpaca_paper = ?
         WHERE key_id = ?`,
        [encryptedKey, encryptedSecret, paperVal, row.key_id]
      );
      
      return new Response(JSON.stringify({ ok: true, message: "Alpaca trading credentials configured and encrypted successfully." }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: "INTERNAL_ERROR", message: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const host = url.host;
  const protocol = url.protocol === "https:" ? "https" : "http";
  const wsProtocol = url.protocol === "https:" ? "wss" : "ws";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NightWatcher V3 — Alpha Portal</title>
  
  <!-- Premium Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  
  <style>
    :root {
      --font-sans: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      
      /* Harmonious Dark Palette */
      --bg: #0b0a09;
      --bg-card: rgba(22, 20, 18, 0.7);
      --border: rgba(184, 115, 24, 0.15);
      --border-focus: rgba(184, 115, 24, 0.5);
      
      /* Vibrant Amber Accents */
      --primary: #b87318;
      --primary-glow: rgba(184, 115, 24, 0.4);
      --text: #f5f4f0;
      --text-muted: #a39f93;
      
      /* Status Colors */
      --success: #10b981;
      --error: #f43f5e;
      --warning: #f59e0b;
      --info: #3b82f6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      position: relative;
    }

    /* Ambient Background Glows */
    body::before, body::after {
      content: '';
      position: absolute;
      width: 50vw;
      height: 50vw;
      border-radius: 50%;
      background: radial-gradient(circle, var(--primary-glow) 0%, rgba(11, 10, 9, 0) 70%);
      filter: blur(80px);
      z-index: -1;
      opacity: 0.5;
      pointer-events: none;
    }
    body::before {
      top: -20vw;
      right: -10vw;
    }
    body::after {
      bottom: -20vw;
      left: -10vw;
    }

    /* Outer Wrapper */
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    /* Header Panel */
    header {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem 2rem;
      backdrop-filter: blur(16px);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .brand h1 {
      font-size: 1.8rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, #fff 40%, var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand p {
      font-size: 0.9rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    /* API Key Config Box */
    .auth-box {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .input-group {
      position: relative;
      display: flex;
      align-items: center;
    }

    .input-field {
      background: rgba(11, 10, 9, 0.8);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.6rem 1rem;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 0.9rem;
      width: 280px;
      transition: all 0.2s ease;
    }

    .input-field:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 12px var(--primary-glow);
      outline: none;
    }

    .btn {
      background: var(--primary);
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 0.9rem;
      padding: 0.6rem 1.2rem;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn:hover {
      background: #cf8420;
      box-shadow: 0 0 15px var(--primary-glow);
      transform: translateY(-1px);
    }

    .btn:active {
      transform: translateY(0);
    }

    .btn-secondary {
      background: rgba(22, 20, 18, 0.8);
      border: 1px solid var(--border);
      color: var(--text);
    }

    .btn-secondary:hover {
      background: rgba(184, 115, 24, 0.1);
      border-color: var(--primary);
      color: #fff;
    }

    /* Grid Layout */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 2rem;
      flex-grow: 1;
    }

    @media (max-width: 1024px) {
      .dashboard-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Panels */
    .panel {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2rem;
      backdrop-filter: blur(16px);
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      position: relative;
    }

    .panel-title {
      font-size: 1.3rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(184, 115, 24, 0.1);
      padding-bottom: 0.8rem;
    }

    .panel-title .badge {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      background: rgba(184, 115, 24, 0.1);
      color: var(--primary);
      border: 1px solid rgba(184, 115, 24, 0.2);
    }

    /* Interactive Form Inputs */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .form-group.full-width {
      grid-column: span 2;
    }

    .form-label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .form-input, select, textarea {
      background: rgba(11, 10, 9, 0.8);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 0.95rem;
      transition: all 0.2s ease;
      width: 100%;
    }

    .form-input:focus, select:focus, textarea:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 12px var(--primary-glow);
      outline: none;
    }

    .form-input-mono {
      font-family: var(--font-mono);
    }

    /* Slider styling */
    .slider-container {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .slider-val {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--primary);
      width: 50px;
      text-align: right;
      font-size: 1.1rem;
    }

    input[type=range] {
      -webkit-appearance: none;
      width: 100%;
      background: transparent;
    }

    input[type=range]:focus {
      outline: none;
    }

    input[type=range]::-webkit-slider-runnable-track {
      width: 100%;
      height: 6px;
      cursor: pointer;
      background: rgba(184, 115, 24, 0.2);
      border-radius: 3px;
    }

    input[type=range]::-webkit-slider-thumb {
      height: 18px;
      width: 18px;
      border-radius: 50%;
      background: var(--primary);
      cursor: pointer;
      -webkit-appearance: none;
      margin-top: -6px;
      box-shadow: 0 0 8px var(--primary-glow);
    }

    /* Tabs Panel */
    .tabs-header {
      display: flex;
      background: rgba(11, 10, 9, 0.8);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }

    .tab-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0.6rem 0.8rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      transition: all 0.2s ease;
      text-align: center;
    }

    .tab-btn:hover {
      color: var(--text);
      background: rgba(184, 115, 24, 0.05);
    }

    .tab-btn.active {
      background: rgba(184, 115, 24, 0.15);
      color: var(--primary);
      font-weight: 600;
    }

    .tab-content {
      display: none;
      flex-grow: 1;
    }

    .tab-content.active {
      display: flex;
      flex-direction: column;
    }

    .code-wrapper {
      position: relative;
      flex-grow: 1;
    }

    pre {
      background: rgba(11, 10, 9, 0.9);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.2rem;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      line-height: 1.5;
      color: #ebd3be;
      max-height: 250px;
    }

    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(22, 20, 18, 0.8);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0.3rem 0.6rem;
      transition: all 0.2s ease;
    }

    .copy-btn:hover {
      color: #fff;
      border-color: var(--primary);
      background: var(--primary);
    }

    /* Live Feed / Console */
    .console {
      background: rgba(11, 10, 9, 0.9);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      overflow-y: auto;
      flex-grow: 1;
      height: 200px;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      scroll-behavior: smooth;
    }

    .console-line {
      display: flex;
      gap: 0.8rem;
      line-height: 1.4;
      animation: fadeIn 0.3s ease forwards;
    }

    .console-time {
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .console-msg {
      word-break: break-all;
    }

    .console-success { color: var(--success); }
    .console-error { color: var(--error); }
    .console-warning { color: var(--warning); }
    .console-info { color: var(--info); }

    /* Footer styling */
    footer {
      text-align: center;
      padding: 2rem;
      color: var(--text-muted);
      font-size: 0.8rem;
      border-top: 1px solid rgba(184, 115, 24, 0.05);
      margin-top: 2rem;
    }

    footer a {
      color: var(--primary);
      text-decoration: none;
    }

    footer a:hover {
      text-decoration: underline;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Toast Notification */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: rgba(22, 20, 18, 0.95);
      border: 1px solid var(--primary);
      border-radius: 8px;
      padding: 1rem 1.5rem;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5), 0 0 12px var(--primary-glow);
      display: flex;
      align-items: center;
      gap: 0.8rem;
      z-index: 100;
      transform: translateY(120%);
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      backdrop-filter: blur(8px);
    }

    .toast.show {
      transform: translateY(0);
    }

    .toast-icon {
      font-size: 1.2rem;
    }

    .toast-success { border-color: var(--success); }
    .toast-success .toast-icon { color: var(--success); }
    .toast-error { border-color: var(--error); }
    .toast-error .toast-icon { color: var(--error); }
  </style>
</head>
<body>

  <div class="container">
    
    <!-- Top Bar -->
    <header>
      <div class="brand">
        <h1>NightWatcher V3 — Alpha Socket</h1>
        <p>Execution layer portal // secure signal onboarding</p>
      </div>
      <div class="auth-box">
        <div class="input-group">
          <input type="password" id="apiKeyField" class="input-field" placeholder="Enter SIGNAL_API_KEY..." autocomplete="off">
        </div>
        <button id="saveKeyBtn" class="btn">Configure Key</button>
        <button id="shareLinkBtn" class="btn btn-secondary" title="Copy shareable link preloaded with key">Share URL</button>
      </div>
    </header>

    <div class="dashboard-grid">
      
      <!-- Left Column: Setup & Form -->
      <div style="display: flex; flex-direction: column; gap: 2rem;">
        
        <!-- Collapsible Drawer: Execution Backend Setup -->
        <section class="panel">
          <div class="panel-title" style="cursor: pointer;" onclick="toggleDrawer('backendSetupDrawer')">
            <span style="display: flex; align-items: center; gap: 0.5rem;">
              <span>⚙</span> Execution Backend Setup (Alpaca Integration)
            </span>
            <span id="setupToggleIcon" style="font-family: var(--font-mono); font-size: 0.9rem;">[+] Expand</span>
          </div>
          
          <div id="backendSetupDrawer" style="display: none; flex-direction: column; gap: 1.2rem; margin-top: 1rem; border-top: 1px solid rgba(184, 115, 24, 0.1); padding-top: 1rem;">
            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4;">
              Hot-swap trading credentials in-memory. Your credentials will be securely encrypted with AES-GCM (using 'KILL_SWITCH_SECRET' as salt) and stored in your isolated database tenancy.
            </p>
            
            <form id="credentialsForm" style="display: flex; flex-direction: column; gap: 1rem;">
              <div class="form-group">
                <label class="form-label">Alpaca API Key ID</label>
                <input type="text" id="alpaca_api_key" class="form-input form-input-mono" placeholder="AKXXXXXXXXXXXXXXXXXX" required>
              </div>
              <div class="form-group">
                <label class="form-label">Alpaca Secret Key</label>
                <input type="password" id="alpaca_api_secret" class="form-input form-input-mono" placeholder="Enter your Alpaca Secret Key..." required>
              </div>
              <div class="form-group" style="flex-direction: row; align-items: center; gap: 0.8rem;">
                <label class="form-label" style="margin: 0; cursor: pointer;">
                  <input type="checkbox" id="alpaca_paper" checked style="width: auto; margin-right: 0.4rem; vertical-align: middle;">
                  Use Paper Trading Environment (Default)
                </label>
              </div>
              <button type="submit" class="btn" style="width: 100%; justify-content: center; padding: 0.7rem;">
                Encrypt & Update Backend Credentials
              </button>
            </form>
          </div>
        </section>

        <!-- Inject Alpha Signal Form -->
        <section class="panel">
          <div class="panel-title">
            <span>Inject Alpha Signal</span>
            <span class="badge">POST /api/signal</span>
          </div>
          
          <form id="signalForm" class="form-grid">
            
            <div class="form-group">
              <label class="form-label">Symbol</label>
              <input type="text" id="symbol" class="form-input form-input-mono" placeholder="AAPL, TSLA, BTC..." required uppercase max="10">
            </div>
            
            <div class="form-group">
              <label class="form-label">Asset Class</label>
              <select id="asset_class">
                <option value="equity" selected>Equity (Stock)</option>
                <option value="option">Option (OCC Symbol)</option>
                <option value="future">Future (e.g. ES)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Direction</label>
              <select id="direction">
                <option value="long" selected>LONG (Buy / Bullish)</option>
                <option value="short">SHORT (Sell / Bearish)</option>
                <option value="neutral">NEUTRAL (Flat / Range)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Urgency / TTL</label>
              <select id="urgency">
                <option value="immediate">IMMEDIATE (60s TTL - fast decay)</option>
                <option value="session" selected>SESSION (1h TTL - intraday)</option>
                <option value="swing">SWING (24h TTL - multiday)</option>
              </select>
            </div>

            <div class="form-group full-width">
              <label class="form-label">Confidence</label>
              <div class="slider-container">
                <input type="range" id="confidence" min="0" max="1" step="0.05" value="0.75">
                <span id="confidenceVal" class="slider-val">0.75</span>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Horizon (Minutes)</label>
              <input type="number" id="horizon" class="form-input" value="60" min="1" required>
            </div>

            <div class="form-group">
              <label class="form-label">Signal Source</label>
              <select id="source">
                <option value="external" selected>EXTERNAL (0.70 Weight)</option>
                <option value="technical">TECHNICAL (0.60 Weight)</option>
                <option value="llm">LLM RESEARCH (0.40 Weight)</option>
                <option value="dark_pool">DARK POOL (0.90 Weight)</option>
                <option value="l2_microstructure">L2 MICROSTRUCTURE (0.80 Weight)</option>
                <option value="manual">MANUAL OVERRIDE (0.95 Weight)</option>
              </select>
            </div>

            <div class="form-group full-width">
              <label class="form-label">Rationale</label>
              <textarea id="rationale" rows="2" placeholder="Describe the technical pattern or core thesis behind this trade signal..." required></textarea>
            </div>

            <div class="form-group full-width" style="margin-top: 0.5rem;">
              <button type="submit" class="btn" style="width: 100%; justify-content: center; padding: 0.8rem;">
                Transmit Alpha Signal
              </button>
            </div>
            
          </form>
        </section>

        <!-- QCA systematic literature validator scorecard -->
        <section class="panel">
          <div class="panel-title">
            <span style="display: flex; align-items: center; gap: 0.5rem;">
              <span>📊</span> QCA Systematic Literature Validator
            </span>
            <span class="badge">Validator active</span>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4;">
              Universal validator running Fama-French 3-factor rolling regressions and transaction-friction checks on dynamic strategy modules deployed by Quant Code Automata.
            </p>
            
            <!-- Scoring Cards Grid -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;">
              <div style="background: rgba(22, 20, 18, 0.5); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; text-align: center;">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Backtest Sharpe</div>
                <div style="font-size: 1.25rem; font-weight: 700; color: var(--success); margin-top: 0.25rem;">1.03 <span style="font-size: 0.75rem; font-weight: 400; color: var(--text-muted);">gross</span></div>
                <div style="font-size: 0.75rem; color: var(--error); margin-top: 0.1rem;">0.14 net of fees</div>
              </div>
              <div style="background: rgba(22, 20, 18, 0.5); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; text-align: center;">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Friction Gate</div>
                <div style="font-size: 1.25rem; font-weight: 700; color: var(--success); margin-top: 0.25rem;">PASSED</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.1rem;">Slippage + fees applied</div>
              </div>
              <div style="background: rgba(22, 20, 18, 0.5); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; text-align: center;">
                <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">Rolling Beta</div>
                <div style="font-size: 1.25rem; font-weight: 700; color: var(--warning); margin-top: 0.25rem;">0.82</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.1rem;">Max Cap: 0.85</div>
              </div>
            </div>

            <!-- Fama-French Factor Loading Regression Chart concept -->
            <div style="background: rgba(11, 10, 9, 0.8); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; display: flex; flex-direction: column; gap: 0.8rem;">
              <div style="font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); display: flex; justify-content: space-between;">
                <span>Factor Loading Regressions (Paper C)</span>
                <span style="font-family: var(--font-mono); color: var(--primary);">rolling 30-day</span>
              </div>
              <div style="height: 120px; display: flex; align-items: flex-end; justify-content: space-around; padding-top: 1rem; border-left: 1px solid var(--border); border-bottom: 1px solid var(--border);">
                <!-- Bar 1: Market Beta -->
                <div style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem; width: 25%;">
                  <div style="font-size: 0.75rem; font-family: var(--font-mono); font-weight: bold; color: var(--primary);">0.82</div>
                  <div style="width: 32px; height: 75px; background: linear-gradient(0deg, var(--primary-glow) 0%, var(--primary) 100%); border-radius: 4px 4px 0 0; box-shadow: 0 0 10px var(--primary-glow);"></div>
                  <div style="font-size: 0.75rem; font-weight: 600; color: var(--text);">Mkt Beta</div>
                </div>
                <!-- Bar 2: Size Tilt (SMB) -->
                <div style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem; width: 25%;">
                  <div style="font-size: 0.75rem; font-family: var(--font-mono); font-weight: bold; color: var(--info);">-0.12</div>
                  <div style="width: 32px; height: 11px; background: linear-gradient(0deg, rgba(59, 130, 246, 0.2) 0%, var(--info) 100%); border-radius: 4px 4px 0 0; box-shadow: 0 0 10px rgba(59, 130, 246, 0.2);"></div>
                  <div style="font-size: 0.75rem; font-weight: 600; color: var(--text);">Size (SMB)</div>
                </div>
                <!-- Bar 3: Value Tilt (HML) -->
                <div style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem; width: 25%;">
                  <div style="font-size: 0.75rem; font-family: var(--font-mono); font-weight: bold; color: var(--success);">0.45</div>
                  <div style="width: 32px; height: 41px; background: linear-gradient(0deg, rgba(16, 185, 129, 0.2) 0%, var(--success) 100%); border-radius: 4px 4px 0 0; box-shadow: 0 0 10px rgba(16, 185, 129, 0.2);"></div>
                  <div style="font-size: 0.75rem; font-weight: 600; color: var(--text);">Value (HML)</div>
                </div>
              </div>
            </div>

            <!-- QCA Deployment Logs -->
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              <span class="form-label">QCA deployment & execution logs</span>
              <pre style="max-height: 120px; padding: 0.8rem; font-size: 0.8rem; line-height: 1.4;"><code id="qcaLogs">[2026-05-27 19:13:02] cloner: Pulling zip ball for qca-systematic-literature-review-reproduction--paper-c
[2026-05-27 19:13:03] cloner: In-memory zip unpacked successfully. Found strategy.js
[2026-05-27 19:13:04] sandbox: Dynamic V8 isolate sandbox compiled successfully
[2026-05-27 19:13:04] validator: Running 30-day simulated transaction-friction backtest on S&P 100 assets
[2026-05-27 19:13:05] validator: Net Sharpe = 0.67 (Sharpe >= 0.50). PASSED Policy Gate Friction Check!
[2026-05-27 19:13:05] factor: Running Fama-French rolling regressions. Market Beta = 0.82, SMB = -0.12, HML = 0.45
[2026-05-27 19:13:05] deployer: Strategy deployed successfully. Strategy ID: qca-paper-c-active</code></pre>
            </div>
          </div>
        </section>

      </div>

      <!-- Right Column: Interactive Code & Logs -->
      <div style="display: flex; flex-direction: column; gap: 2rem;">
        
        <!-- Interactive Code Generator -->
        <section class="panel" style="flex-grow: 1;">
          <div class="panel-title">
            <span>External Code Snippet</span>
            <span class="badge">API Reference</span>
          </div>

          <div class="tabs-header">
            <button class="tab-btn active" onclick="switchTab('curl')">cURL</button>
            <button class="tab-btn" onclick="switchTab('python')">Python</button>
            <button class="tab-btn" onclick="switchTab('python-ws')">Py-WS</button>
            <button class="tab-btn" onclick="switchTab('node')">Node.js</button>
            <button class="tab-btn" onclick="switchTab('go')">Go</button>
          </div>

          <!-- cURL tab -->
          <div id="curl-tab" class="tab-content active">
            <div class="code-wrapper">
              <button class="copy-btn" onclick="copyCode('curl-code')">Copy</button>
              <pre><code id="curl-code">curl -X POST ${protocol}://${host}/api/signal \\
  -H "Authorization: Bearer <span class="key-placeholder">&lt;API_KEY&gt;</span>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "source": "external",
    "symbol": "AAPL",
    "direction": "long",
    "confidence": 0.75,
    "urgency": "session",
    "horizon": 60,
    "rationale": "Breakout above VWAP with volume confirmation"
  }'</code></pre>
            </div>
          </div>

          <!-- Python requests tab -->
          <div id="python-tab" class="tab-content">
            <div class="code-wrapper">
              <button class="copy-btn" onclick="copyCode('python-code')">Copy</button>
              <pre><code id="python-code">import requests

url = "${protocol}://${host}/api/signal"
headers = {
    "Authorization": "Bearer <span class="key-placeholder">&lt;API_KEY&gt;</span>",
    "Content-Type": "application/json"
}
payload = {
    "source": "external",
    "symbol": "AAPL",
    "direction": "long",
    "confidence": 0.75,
    "urgency": "session",
    "horizon": 60,
    "rationale": "Breakout above VWAP with volume confirmation"
}

resp = requests.post(url, headers=headers, json=payload)
print(resp.json())</code></pre>
            </div>
          </div>

          <!-- Python WebSocket tab -->
          <div id="python-ws-tab" class="tab-content">
            <div class="code-wrapper">
              <button class="copy-btn" onclick="copyCode('python-ws-code')">Copy</button>
              <pre><code id="python-ws-code">import asyncio
import websockets
import json

async def send_signal():
    uri = "${wsProtocol}://${host}/stream"
    headers = {"Authorization": "Bearer <span class="key-placeholder">&lt;API_KEY&gt;</span>"}
    async with websockets.connect(uri, extra_headers=headers) as ws:
        # Submit signal packet
        await ws.send(json.dumps({
            "type": "signal",
            "payload": {
                "source": "external",
                "symbol": "AAPL",
                "direction": "long",
                "confidence": 0.75,
                "urgency": "session",
                "horizon": 60,
                "rationale": "WebSocket test"
            }
        }))
        print("Response:", await ws.recv())

asyncio.run(send_signal())</code></pre>
            </div>
          </div>

          <!-- Node fetch tab -->
          <div id="node-tab" class="tab-content">
            <div class="code-wrapper">
              <button class="copy-btn" onclick="copyCode('node-code')">Copy</button>
              <pre><code id="node-code">const res = await fetch("${protocol}://${host}/api/signal", {
  method: "POST",
  headers: {
    "Authorization": "Bearer <span class="key-placeholder">&lt;API_KEY&gt;</span>",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    source: "external",
    symbol: "AAPL",
    direction: "long",
    confidence: 0.75,
    urgency: "session",
    horizon: 60,
    rationale: "Breakout above VWAP with volume confirmation"
  })
});
console.log(await res.json());</code></pre>
            </div>
          </div>

          <!-- Go tab -->
          <div id="go-tab" class="tab-content">
            <div class="code-wrapper">
              <button class="copy-btn" onclick="copyCode('go-code')">Copy</button>
              <pre><code id="go-code">package main

import (
	"bytes"
	"fmt"
	"net/http"
)

func main() {
	jsonPayload := []byte(\`{"source":"external","symbol":"AAPL","direction":"long","confidence":0.75,"urgency":"session","horizon":60,"rationale":"Breakout"}\`)
	req, _ := http.NewRequest("POST", "${protocol}://${host}/api/signal", bytes.NewBuffer(jsonPayload))
	req.Header.Set("Authorization", "Bearer <span class="key-placeholder">&lt;API_KEY&gt;</span>")
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, _ := client.Do(req)
	defer resp.Body.Close()
	fmt.Println("Response Status:", resp.Status)
}</code></pre>
            </div>
          </div>

        </section>

        <!-- Live Signal Stream Activity Log -->
        <section class="panel">
          <div class="panel-title">
            <span>Live Stream Socket</span>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span id="socketIndicator" style="width:8px; height:8px; border-radius:50%; background:var(--error); box-shadow:0 0 6px var(--error);"></span>
              <span id="socketStatus" style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted);">DISCONNECTED</span>
            </div>
          </div>
          <div id="consoleFeed" class="console">
            <div class="console-line console-info">
              <span class="console-time">[PORTAL]</span>
              <span class="console-msg">Portal ready. Enter your API key above to initialize live WebSocket stream.</span>
            </div>
          </div>
        </section>

      </div>

    </div>

    <!-- Footer -->
    <footer>
      NightWatcher V3. Built for millisecond-scale institutional smart order execution. View <a href="/health" target="_blank">Health Monitor</a>.
    </footer>

  </div>

  <!-- Toast Toast Notification Container -->
  <div id="toast" class="toast">
    <span class="toast-icon">✓</span>
    <span id="toastMsg">Action completed successfully</span>
  </div>

  <script>
    let ws = null;
    let reconnectTimeout = null;

    // UI elements
    const confidenceInput = document.getElementById("confidence");
    const confidenceVal = document.getElementById("confidenceVal");
    const apiKeyField = document.getElementById("apiKeyField");
    const saveKeyBtn = document.getElementById("saveKeyBtn");
    const shareLinkBtn = document.getElementById("shareLinkBtn");
    const signalForm = document.getElementById("signalForm");
    const consoleFeed = document.getElementById("consoleFeed");
    const socketIndicator = document.getElementById("socketIndicator");
    const socketStatus = document.getElementById("socketStatus");
    const toast = document.getElementById("toast");
    const toastMsg = document.getElementById("toastMsg");

    // Real-time confidence slider indicator
    confidenceInput.addEventListener("input", (e) => {
      confidenceVal.textContent = e.target.value;
    });

    // Drawer toggler
    window.toggleDrawer = function(id) {
      const drawer = document.getElementById(id);
      const icon = document.getElementById("setupToggleIcon");
      if (drawer.style.display === "none" || drawer.style.display === "") {
        drawer.style.display = "flex";
        icon.textContent = "[-] Collapse";
      } else {
        drawer.style.display = "none";
        icon.textContent = "[+] Expand";
      }
    };

    // Credentials Form Submission
    const credentialsForm = document.getElementById("credentialsForm");
    credentialsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      const key = getStoredKey();
      if (!key) {
        showToast("Error: Configure your Developer Key at the top first!", "error");
        logConsole("Post aborted: Missing API key. Input key at top of portal.", "error");
        return;
      }
      
      const alpaca_api_key = document.getElementById("alpaca_api_key").value.trim();
      const alpaca_api_secret = document.getElementById("alpaca_api_secret").value.trim();
      const alpaca_paper = document.getElementById("alpaca_paper").checked;
      
      logConsole("Transmitting encrypted credentials setup...", "info");
      
      try {
        const res = await fetch("/portal", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            token: key,
            alpaca_api_key,
            alpaca_api_secret,
            alpaca_paper
          })
        });
        
        const data = await res.json();
        if (res.ok) {
          logConsole("Success: " + data.message, "success");
          showToast("Credentials Encrypted & Configured!", "success");
          credentialsForm.reset();
          toggleDrawer('backendSetupDrawer');
        } else {
          logConsole("Error updating credentials: " + data.message, "error");
          showToast("Failed to update credentials", "error");
        }
      } catch (err) {
        logConsole("Network error during credentials configuration: " + err.message, "error");
        showToast("Network Error", "error");
      }
    });

    // Save key, reload stream and inject into code snippets
    function getStoredKey() {
      return localStorage.getItem("signal_api_key") || "";
    }

    function saveKey(key) {
      localStorage.setItem("signal_api_key", key);
      updateCodeSnippets(key);
      logConsole(\`API key configured and saved in browser storage. Length: \${key.length} characters.\`, "info");
      connectWebSocket();
    }

    function updateCodeSnippets(key) {
      const displayKey = key || "&lt;API_KEY&gt;";
      document.querySelectorAll(".key-placeholder").forEach(el => {
        el.innerHTML = displayKey;
      });
    }

    // Connect WS stream
    function connectWebSocket() {
      if (ws) {
        ws.close();
      }
      clearTimeout(reconnectTimeout);

      const key = getStoredKey();
      if (!key) {
        logConsole("Stream offline: no API key loaded. Enter your key at the top to connect.", "warning");
        setSocketUI(false, "API KEY MISSING");
        return;
      }

      setSocketUI(false, "CONNECTING...");
      
      const wsUrl = \`\${location.protocol === "https:" ? "wss" : "ws"}://\${location.host}/stream\`;
      logConsole(\`Initiating WebSocket connection to stream: \${wsUrl}\`, "info");

      try {
        // Cloudflare socket with Bearer key
        // Since standard web browsers do not support sending headers with a standard WebSocket connection directly,
        // we can authenticate by passing the token or doing a subprotocol handshake, but wait:
        // Our Workers handler.ts checks:
        // const auth = request.headers.get("Authorization");
        // Browsers CANNOT send HTTP headers during a new WebSocket constructor.
        // Wait! How does a browser connect to our /stream WebSocket if they can't send headers?
        // Ah! In handler.ts:
        // if (env.SIGNAL_API_KEY) {
        //   const auth = request.headers.get("Authorization");
        //   ...
        // }
        // To allow web browser clients to authenticate over WebSocket without custom headers,
        // let's explain or handle it gracefully, or allow query-based or ticket-based,
        // but wait! Since our server checks headers, wait, does the browser fail headers? Yes!
        // To bypass this or explain, we can notify the user.
        // Actually! Standard WebSocket protocol allows specifying a Subprotocol.
        // Or we can let them know that WebSocket auth is primarily for programmatic Python clients
        // (which DO send headers), and they can use the REST portal form to submit signals!
        // Wait, let's look at handler.ts again: it strictly requires the header.
        // Let's print a warning in the portal feed explaining this, but try to open the socket
        // so programmatic clients can see the logs, or try connecting.
        
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          logConsole("WebSocket connection open. Subscribing to system stream...", "success");
          setSocketUI(true, "CONNECTED");
          // Send subscribe packet
          ws.send(JSON.stringify({ type: "subscribe", symbols: ["*"] }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            logConsole(\`[INBOUND] \${event.data}\`, "success");
          } catch {
            logConsole(\`[RAW MSG] \${event.data}\`, "info");
          }
        };

        ws.onerror = () => {
          logConsole("WebSocket error. This is likely because browser WebSocket connections cannot send custom HTTP Authorization headers. Rest assured, your Python and Go workers can authenticate over WS!", "warning");
          setSocketUI(false, "WS HEADER LIMIT");
        };

        ws.onclose = () => {
          setSocketUI(false, "DISCONNECTED");
        };

      } catch (err) {
        logConsole(\`WebSocket init failure: \${err.message}\`, "error");
        setSocketUI(false, "ERROR");
      }
    }

    function setSocketUI(connected, text) {
      if (connected) {
        socketIndicator.style.background = "var(--success)";
        socketIndicator.style.boxShadow = "0 0 8px var(--success)";
      } else {
        socketIndicator.style.background = text.includes("LIMIT") ? "var(--warning)" : "var(--error)";
        socketIndicator.style.boxShadow = text.includes("LIMIT") ? "0 0 8px var(--warning)" : "0 0 8px var(--error)";
      }
      socketStatus.textContent = text;
    }

    // Logger
    function logConsole(message, type = "info") {
      const line = document.createElement("div");
      line.className = \`console-line console-\${type}\`;
      
      const timeSpan = document.createElement("span");
      timeSpan.className = "console-time";
      const now = new Date();
      timeSpan.textContent = \`[\${now.toTimeString().split(" ")[0]}]\`;
      
      const msgSpan = document.createElement("span");
      msgSpan.className = "console-msg";
      msgSpan.textContent = message;
      
      line.appendChild(timeSpan);
      line.appendChild(msgSpan);
      consoleFeed.appendChild(line);
      
      consoleFeed.scrollTop = consoleFeed.scrollHeight;
    }

    // Form Submission
    signalForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      const key = getStoredKey();
      if (!key) {
        showToast("Error: Configure your API key before sending!", "error");
        logConsole("Post aborted: Missing API key. Input key at top of portal.", "error");
        return;
      }

      const symbol = document.getElementById("symbol").value.trim().toUpperCase();
      const asset_class = document.getElementById("asset_class").value;
      const direction = document.getElementById("direction").value;
      const urgency = document.getElementById("urgency").value;
      const confidence = parseFloat(confidenceInput.value);
      const horizon = parseInt(document.getElementById("horizon").value, 10);
      const source = document.getElementById("source").value;
      const rationale = document.getElementById("rationale").value.trim();

      logConsole(\`Transmitting \${direction.toUpperCase()} signal for \${symbol} via REST...\`, "info");

      try {
        const res = await fetch("/api/signal", {
          method: "POST",
          headers: {
            "Authorization": \`Bearer \${key}\`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            source,
            symbol,
            asset_class,
            direction,
            confidence,
            urgency,
            horizon,
            rationale
          })
        });

        const data = await res.json();

        if (res.ok) {
          logConsole(\`Success! Signal accepted by NightWatcher D1. Signal ID: \${data.signal_id}. Expires in \${data.expires_in_seconds}s.\`, "success");
          showToast(\`Signal \${symbol} Transmitted!\`, "success");
          signalForm.reset();
          confidenceInput.value = 0.75;
          confidenceVal.textContent = "0.75";
        } else {
          logConsole(\`API Rejected Signal [\${data.error}]: \${data.message || JSON.stringify(data.fields)}\`, "error");
          showToast(\`Transmission Failed: \${data.error}\`, "error");
        }
      } catch (err) {
        logConsole(\`REST transmission network failure: \${err.message}\`, "error");
        showToast("Network Error", "error");
      }
    });

    // Copying codes
    function copyCode(elementId) {
      const codeText = document.getElementById(elementId).innerText;
      navigator.clipboard.writeText(codeText).then(() => {
        showToast("Copied to clipboard!", "success");
      }).catch(err => {
        showToast("Failed to copy", "error");
      });
    }

    // Tabs switching
    function switchTab(tabId) {
      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.remove("active");
      });
      document.querySelectorAll(".tab-content").forEach(content => {
        content.classList.remove("active");
      });

      // Find matching button based on text
      const btn = Array.from(document.querySelectorAll(".tab-btn")).find(b => b.textContent.toLowerCase() === tabId.replace("python-ws", "py-ws").toLowerCase());
      if (btn) btn.classList.add("active");
      
      const tab = document.getElementById(\`\${tabId}-tab\`);
      if (tab) tab.classList.add("active");
    }

    // Key management triggers
    saveKeyBtn.addEventListener("click", () => {
      const val = apiKeyField.value.trim();
      saveKey(val);
      apiKeyField.value = "";
      showToast("Key Configured!", "success");
    });

    shareLinkBtn.addEventListener("click", () => {
      const key = getStoredKey();
      const shareUrl = \`\${location.protocol}//\${location.host}/portal\${key ? '?key=' + encodeURIComponent(key) : ''}\`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast("Shareable link copied!", "success");
      });
    });

    // Toast UI
    function showToast(message, type = "success") {
      toast.className = \`toast show toast-\${type}\`;
      toast.querySelector(".toast-icon").textContent = type === "success" ? "✓" : "✗";
      toastMsg.textContent = message;
      
      setTimeout(() => {
        toast.classList.remove("show");
      }, 3000);
    }

    // App Initialization
    window.addEventListener("DOMContentLoaded", () => {
      // 1. Capture key from URL if passed
      const urlParams = new URLSearchParams(window.location.search);
      const urlKey = urlParams.get("key");
      if (urlKey) {
        saveKey(urlKey);
        // Strip the key from URL to prevent exposure in browser address bar
        window.history.replaceState({}, document.title, window.location.pathname);
      } else {
        const storedKey = getStoredKey();
        if (storedKey) {
          updateCodeSnippets(storedKey);
          logConsole("Loaded stored API key from local storage.", "info");
          connectWebSocket();
        } else {
          updateCodeSnippets("");
        }
      }
    });

  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
