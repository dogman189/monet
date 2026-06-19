/**
 * ultraexchange — renderer.js  (engine v3 - AI Terminal)
 */

const BASE = (window.APP_CONFIG && window.APP_CONFIG.backendUrl) || 'http://127.0.0.1:5678';

const $ = id => document.getElementById(id);
const E = {
  boot:           $('boot'),
  statusPill:     $('status-pill'),
  statusText:     $('status-text'),
  priceVal:       $('price-val'),
  symLabel:       $('sym-label'),
  liveDot:        $('live-dot'),
  liveTxt:        $('live-txt'),
  smaMain:        $('sma-main'),
  upperLbl:       $('upper-lbl'),
  lowerLbl:       $('lower-lbl'),
  bandZone:       $('band-zone'),
  bandNeedle:     $('band-needle'),
  rsiVal:         $('rsi-val'),
  rsiFill:        $('rsi-fill'),
  bwBadge:        $('bw-badge'),
  
  // Portfolio ROI elements
  netWorthVal:    $('net-worth-val'),
  totalPnlWrap:   $('total-pnl-wrap'),
  totalPnlPct:    $('total-pnl-pct'),
  totalPnlUsd:    $('total-pnl-usd'),
  usdVal:         $('usd-val'),
  cryptoVal:      $('crypto-val'),
  cryptoSym:      $('crypto-sym'),
  avgEntryVal:    $('avg-entry-val'),
  
  // Performance counters
  statTrades:     $('stat-trades'),
  statBuys:       $('stat-buys'),
  statSells:      $('stat-sells'),
  statStops:      $('stat-stops'),
  
  // AI Brain UI elements
  aiVerdict:      $('ai-verdict'),
  aiAccuracy:     $('ai-accuracy'),
  aiPrediction:   $('ai-prediction'),
  nnTrainLoss:    $('nn-train-loss'),
  nnArchLbl:      $('nn-arch-lbl'),
  nnCanvas:       $('nn-canvas'),
  nnLayerNorms:   $('nn-layer-norms'),

  // Logs and inputs
  logOutput:      $('log-output'),
  logCount:       $('log-count'),
  btnStart:       $('btn-start'),
  btnStop:        $('btn-stop'),
  inApiKey:       $('in-api-key'),
  inSymbol:       $('in-symbol'),
  inInterval:     $('in-interval'),
  inTrade:        $('in-trade'),
  inWallet:       $('in-wallet'),
  
  // New config inputs
  inPosMode:      $('in-pos-mode'),
  inRiskPct:      $('in-risk-pct'),
  inStopLoss:     $('in-stop-loss'),
  inTakeProfit:   $('in-take-profit'),
  inLr:           $('in-lr'),
  inBbWindow:     $('in-bb-window'),
  inBbStdDev:     $('in-bb-stddev'),
  inRsiPeriod:    $('in-rsi-period'),
  inRsiOversold:  $('in-rsi-oversold'),
  inRsiOverbought:$('in-rsi-overbought'),
  toggleBb:       $('toggle-bb'),
  toggleSma:      $('toggle-sma'),
};

let logCount     = 0;
let lastPrice    = 0;
let evtSource    = null;
let chartHistory = [];

const colors = {
  dark: {
    bg: '#080c14',
    cyan: '#38d9f5',
    green: '#34d399',
    rose: '#fb7185',
    violet: '#a78bfa',
    amber: '#fbbf24',
    ink3: 'rgba(240,244,248,0.25)',
    ink2: 'rgba(240,244,248,0.5)',
    grid: 'rgba(255,255,255,0.04)',
    bbChannel: 'rgba(167, 139, 250, 0.04)',
    bbLines: 'rgba(167, 139, 250, 0.12)',
    sma: 'rgba(56, 217, 245, 0.35)',
    priceShadow: 'rgba(56, 217, 245, 0.25)'
  },
  light: {
    bg: '#f0ece4',
    cyan: '#0e7fa8',
    green: '#0f7d57',
    rose: '#c73756',
    violet: '#6d44d4',
    amber: '#b57a0a',
    ink3: 'rgba(26,22,18,0.38)',
    ink2: 'rgba(26,22,18,0.62)',
    grid: 'rgba(0,0,0,0.03)',
    bbChannel: 'rgba(109,68,212,0.04)',
    bbLines: 'rgba(109,68,212,0.1)',
    sma: 'rgba(14,127,168,0.25)',
    priceShadow: 'rgba(14, 127, 168, 0.15)'
  }
};

function initChartToggles() {
  if (E.toggleBb) E.toggleBb.addEventListener('change', () => drawChart(chartHistory));
  if (E.toggleSma) E.toggleSma.addEventListener('change', () => drawChart(chartHistory));
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

async function boot() {
  initPosModeToggle();
  initChartInteraction();
  initChartToggles();
  await waitForBackend();
  await loadConfig();
  syncStatus();
  startLogStream();
  setInterval(syncStatus, 2200);
  E.boot.classList.add('hidden');
}

async function waitForBackend(retries = 50, delay = 400) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(900) });
      if (r.ok) return;
    } catch (_) {}
    await sleep(delay);
  }
}

async function loadConfig() {
  try {
    const d = await (await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(2000) })).json();
    if (d.api_key) E.inApiKey.value = d.api_key;
  } catch (_) {}
}

function initPosModeToggle() {
  E.inPosMode.addEventListener('change', () => {
    const mode = E.inPosMode.value;
    const pctField = document.querySelector('.pct-field');
    const usdHint = $('trade-hint');
    if (mode === 'percent') {
      pctField.style.display = 'block';
      E.inTrade.disabled = true;
      E.inTrade.style.opacity = '0.35';
      usdHint.textContent = 'engine uses Risk % of wallet / trade';
    } else {
      pctField.style.display = 'none';
      E.inTrade.disabled = false;
      E.inTrade.style.opacity = '1';
      usdHint.textContent = 'engine uses Fixed USD amount / trade';
    }
  });
  // Trigger on init
  E.inPosMode.dispatchEvent(new Event('change'));
}

// ─── STATUS SYNC ──────────────────────────────────────────────────────────────

async function syncStatus() {
  try {
    const d = await (await fetch(`${BASE}/api/status`)).json();
    render(d);
  } catch (_) {}
}

function render(d) {
  const {
    price, sma, upper, lower,
    rsi, bandwidth, avg_buy_price,
    is_running, symbol,
    usd, holdings, net_worth, pnl_usd, pnl_pct,
    interval,
    total_trades, total_buys, total_sells, stop_losses_hit,
    ai_prediction, ai_accuracy, history,
    nn_architecture, nn_layer_norms, nn_train_loss, nn_activations, nn_feature_names
  } = d;

  const sym = symbol || 'BTC';
  chartHistory = history || [];

  // Symbol labels
  const curCode = (typeof getCurrency === 'function') ? getCurrency().code : 'USD';
  E.symLabel.textContent     = `${sym} / ${curCode}`;
  E.cryptoSym.textContent    = sym;

  // Price
  if (price) {
    E.priceVal.textContent = fmt$(price);
    if (price > lastPrice && lastPrice > 0)      flash(E.priceVal, 'up');
    else if (price < lastPrice && lastPrice > 0) flash(E.priceVal, 'down');
    lastPrice = price;
  }

  // Draw prices chart
  drawChart(chartHistory);

  // Bollinger Sliders
  const f = v => v != null ? fmt$(v) : '—';
  E.smaMain.textContent  = sma ? `SMA ${fmt$(sma)}` : 'SMA —';
  E.upperLbl.textContent = upper ? fmt$(upper) : '$—';
  E.lowerLbl.textContent = lower ? fmt$(lower) : '$—';

  if (upper != null && lower != null && price != null) {
    const range = upper - lower;
    const pct   = range > 0 ? Math.max(0, Math.min(1, (price - lower) / range)) : 0.5;
    E.bandNeedle.style.left = `${(pct * 100).toFixed(1)}%`;
  }

  // RSI
  if (rsi != null) {
    const rsiNum = parseFloat(rsi);
    E.rsiVal.textContent = rsiNum.toFixed(1);
    E.rsiVal.classList.remove('oversold', 'overbought');
    
    const oversoldBound = parseInt(E.inRsiOversold.value) || 35;
    const overboughtBound = parseInt(E.inRsiOverbought.value) || 65;
    if (rsiNum < oversoldBound)      E.rsiVal.classList.add('oversold');
    else if (rsiNum > overboughtBound) E.rsiVal.classList.add('overbought');

    const fillPct  = Math.max(0, Math.min(100, rsiNum));
    let fillColor  = 'var(--cyan)';
    if (rsiNum < oversoldBound)      fillColor = 'var(--green)';
    else if (rsiNum > overboughtBound) fillColor = 'var(--rose)';
    E.rsiFill.style.width      = `${fillPct}%`;
    E.rsiFill.style.background = fillColor;
  } else {
    E.rsiVal.textContent = '—';
    E.rsiVal.classList.remove('oversold', 'overbought');
    E.rsiFill.style.width      = '50%';
    E.rsiFill.style.background = 'var(--cyan)';
  }

  // Bandwidth squeeze indicator
  if (bandwidth != null) {
    const bwNum = parseFloat(bandwidth);
    E.bwBadge.textContent = `BW ${bwNum.toFixed(4)}`;
    if (bwNum < 0.0002) E.bwBadge.classList.add('squeeze');
    else                E.bwBadge.classList.remove('squeeze');
  } else {
    E.bwBadge.textContent = 'BW —';
    E.bwBadge.classList.remove('squeeze');
  }

  // Portfolio Summary (Net Valuation + ROI)
  E.netWorthVal.textContent = fmt$(net_worth || (usd + (holdings || 0) * (price || 0)));
  E.usdVal.textContent      = fmt$(usd);
  E.cryptoVal.textContent   = (holdings || 0).toFixed(6);

  if (pnl_usd !== undefined && pnl_pct !== undefined) {
    E.totalPnlWrap.style.display = 'inline-flex';
    E.totalPnlPct.textContent = `${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(2)}%`;
    E.totalPnlUsd.textContent = `(${pnl_usd >= 0 ? '+' : ''}${fmt$(pnl_usd)})`;
    
    if (pnl_usd >= 0) {
      E.totalPnlWrap.className = 'total-pnl-badge positive';
    } else {
      E.totalPnlWrap.className = 'total-pnl-badge negative';
    }
  } else {
    E.totalPnlWrap.style.display = 'none';
  }

  if (avg_buy_price != null && holdings > 0) {
    E.avgEntryVal.textContent  = fmt$(avg_buy_price);
    E.avgEntryVal.style.color  = 'var(--amber)';
  } else {
    E.avgEntryVal.textContent  = '—';
    E.avgEntryVal.style.color  = 'var(--ink3)';
  }

  // Performance Counters
  E.statTrades.textContent = total_trades    ?? 0;
  E.statBuys.textContent   = total_buys      ?? 0;
  E.statSells.textContent  = total_sells     ?? 0;
  E.statStops.textContent  = stop_losses_hit ?? 0;

  // AI Forecasting Updates
  if (ai_prediction !== undefined) {
    const aiPredNum = parseFloat(ai_prediction);
    E.aiPrediction.textContent = `${aiPredNum >= 0 ? '+' : ''}${aiPredNum.toFixed(4)}`;
    
    if (Math.abs(aiPredNum) < 0.01) {
      E.aiVerdict.textContent = 'Neutral';
      E.aiVerdict.className = 'ai-forecast-val neutral';
    } else if (aiPredNum > 0) {
      E.aiVerdict.textContent = 'Bullish';
      E.aiVerdict.className = 'ai-forecast-val bullish';
    } else {
      E.aiVerdict.textContent = 'Bearish';
      E.aiVerdict.className = 'ai-forecast-val bearish';
    }
  }
  
  if (ai_accuracy !== undefined) {
    E.aiAccuracy.textContent = `${parseFloat(ai_accuracy).toFixed(1)}%`;
  }

  // Neural Network updates
  if (nn_train_loss !== undefined) {
    E.nnTrainLoss.textContent = parseFloat(nn_train_loss).toFixed(4);
  }
  if (nn_architecture) {
    E.nnArchLbl.textContent = `[${nn_architecture.join('→')}]`;
  }
  drawNeuralNet(nn_architecture, nn_activations, nn_feature_names);
  updateLayerNorms(nn_layer_norms, nn_architecture);

  // Start/Stop status synchronization
  if (is_running) {
    E.statusPill.classList.add('running');
    E.statusText.textContent = 'Synchronizing';
    E.liveDot.classList.add('on');
    E.liveTxt.textContent = 'live';
    E.btnStart.disabled = true;
    E.btnStop.disabled  = false;
    lockInputs(true);
  } else {
    E.statusPill.classList.remove('running');
    E.statusText.textContent = 'Suspended';
    E.liveDot.classList.remove('on');
    E.liveTxt.textContent = 'offline';
    E.btnStart.disabled = false;
    E.btnStop.disabled  = true;
    lockInputs(false);
  }
}

// ─── NEURAL NETWORK VISUALISER ─────────────────────────────────────────────

const NN_NODE_COLORS = [
  'rgba(0, 212, 255, __A__)',  // cyan  - input
  'rgba(168, 85, 247, __A__)', // violet - hidden1
  'rgba(236, 72, 153, __A__)', // pink   - hidden2
  'rgba(251, 191, 36, __A__)', // amber  - hidden3
  'rgba(52, 211, 153, __A__)', // green  - output
];

function drawNeuralNet(arch, activations, featureNames) {
  const canvas = E.nnCanvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w === 0 || h === 0) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const layers = arch || [8, 16, 8, 4, 1];
  const numLayers = layers.length;
  const padX = 30;
  const padY = 10;
  const usableW = w - padX * 2;
  const usableH = h - padY * 2;
  const layerSpacing = usableW / (numLayers - 1);

  // Compute node positions
  const nodePositions = []; // [layerIdx][nodeIdx] = {x, y}
  const maxNodes = Math.max(...layers);
  for (let l = 0; l < numLayers; l++) {
    const layerNodes = [];
    const count = layers[l];
    const nodeSpacing = Math.min(usableH / (count + 1), 14);
    const totalHeight = nodeSpacing * (count - 1);
    const startY = (h - totalHeight) / 2;
    const x = padX + l * layerSpacing;
    for (let n = 0; n < count; n++) {
      layerNodes.push({ x, y: startY + n * nodeSpacing });
    }
    nodePositions.push(layerNodes);
  }

  // Draw connections
  for (let l = 0; l < numLayers - 1; l++) {
    const fromNodes = nodePositions[l];
    const toNodes = nodePositions[l + 1];
    for (let f = 0; f < fromNodes.length; f++) {
      for (let t = 0; t < toNodes.length; t++) {
        // Get activation-based opacity
        let alpha = 0.04;
        if (activations && activations[l]) {
          const act = Math.abs(activations[l][f] || 0);
          alpha = Math.min(0.25, 0.03 + act * 0.15);
        }
        ctx.beginPath();
        ctx.moveTo(fromNodes[f].x, fromNodes[f].y);
        ctx.lineTo(toNodes[t].x, toNodes[t].y);
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }

  // Draw nodes
  for (let l = 0; l < numLayers; l++) {
    const nodes = nodePositions[l];
    const colorTpl = NN_NODE_COLORS[Math.min(l, NN_NODE_COLORS.length - 1)];
    for (let n = 0; n < nodes.length; n++) {
      let act = 0;
      if (activations && activations[l] && activations[l][n] !== undefined) {
        act = Math.abs(activations[l][n]);
      }
      const radius = 2.5 + Math.min(act * 2, 2);
      const alpha = 0.3 + Math.min(act * 0.7, 0.7);
      const fillColor = colorTpl.replace('__A__', alpha.toFixed(2));
      const glowColor = colorTpl.replace('__A__', (alpha * 0.5).toFixed(2));

      // Glow
      ctx.beginPath();
      ctx.arc(nodes[n].x, nodes[n].y, radius + 3, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.fill();
      // Node
      ctx.beginPath();
      ctx.arc(nodes[n].x, nodes[n].y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
    }

    // Layer label
    const firstNode = nodes[0];
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${layers[l]}`, firstNode.x, padY - 1);
  }

  // Input feature labels (if room)
  if (featureNames && featureNames.length > 0 && nodePositions[0]) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '5.5px monospace';
    ctx.textAlign = 'right';
    for (let n = 0; n < Math.min(featureNames.length, nodePositions[0].length); n++) {
      ctx.fillText(featureNames[n], nodePositions[0][n].x - 7, nodePositions[0][n].y + 2);
    }
  }

  // Output label
  if (nodePositions[numLayers - 1]) {
    const outNode = nodePositions[numLayers - 1][0];
    ctx.fillStyle = 'rgba(52, 211, 153, 0.5)';
    ctx.font = '6px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('out', outNode.x + 7, outNode.y + 2);
  }
}

function updateLayerNorms(norms, arch) {
  if (!E.nnLayerNorms) return;
  if (!norms || norms.length === 0) {
    E.nnLayerNorms.innerHTML = '';
    return;
  }
  const labels = [];
  const layers = arch || [];
  for (let i = 0; i < norms.length; i++) {
    const from = layers[i] || '?';
    const to = layers[i + 1] || '?';
    labels.push(`L${i + 1} (${from}→${to})`);
  }
  E.nnLayerNorms.innerHTML = norms.map((v, i) =>
    `<div class="nn-norm-chip"><span class="norm-lbl">${labels[i]}</span><span class="norm-val">${v.toFixed(3)}</span></div>`
  ).join('');
}

// ─── CANVAS PRICE & TECHNICAL CHART ──────────────────────────────────────────

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
}

function drawChart(history, guidelineIndex = -1) {
  const canvas = $('price-chart');
  if (!canvas) return;

  resizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.clearRect(0, 0, w, h);

  const isLight = document.documentElement.classList.contains('light');
  const c = isLight ? colors.light : colors.dark;

  if (!history || history.length === 0) {
    ctx.font = '10px "Syne Mono", monospace';
    ctx.fillStyle = c.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Awaiting market feed stream...', w / 2, h / 2);
    return;
  }

  // Extract variables for scaling
  let allVals = [];
  history.forEach(pt => {
    if (pt.price) allVals.push(pt.price);
    if (pt.sma) allVals.push(pt.sma);
    if (pt.upper) allVals.push(pt.upper);
    if (pt.lower) allVals.push(pt.lower);
  });

  if (allVals.length === 0) {
    ctx.font = '10px "Syne Mono", monospace';
    ctx.fillStyle = c.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Calibrating algorithm variables...', w / 2, h / 2);
    return;
  }

  let maxVal = Math.max(...allVals);
  let minVal = Math.min(...allVals);
  const valRange = maxVal - minVal;
  const padding = valRange > 0 ? valRange * 0.15 : 10.0;
  maxVal += padding;
  minVal -= padding;

  const getX = (i) => {
    if (history.length <= 1) return w / 2;
    return 35 + (i / (history.length - 1)) * (w - 70);
  };

  const getY = (val) => {
    if (maxVal === minVal) return h / 2;
    return 15 + (1 - (val - minVal) / (maxVal - minVal)) * (h - 30);
  };

  // 1. Draw horizontal grid gridlines
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const yVal = minVal + (i / steps) * (maxVal - minVal);
    const cy = getY(yVal);
    ctx.beginPath();
    ctx.moveTo(35, cy);
    ctx.lineTo(w - 35, cy);
    ctx.stroke();
    
    // Y-Axis labels (right aligned)
    ctx.font = '8px "Syne Mono", monospace';
    ctx.fillStyle = c.ink3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmt$(yVal), w - 5, cy);
  }

  // 2. Plot Bollinger Bands shaded corridor
  const showBB = E.toggleBb ? E.toggleBb.checked : true;
  const bbPoints = history.filter(pt => pt.upper != null && pt.lower != null);
  if (showBB && bbPoints.length > 0) {
    ctx.beginPath();
    // Trace upper bands
    history.forEach((pt, i) => {
      if (pt.upper != null) {
        if (i === 0) ctx.moveTo(getX(i), getY(pt.upper));
        else ctx.lineTo(getX(i), getY(pt.upper));
      }
    });
    // Trace lower bands backwards
    for (let i = history.length - 1; i >= 0; i--) {
      const pt = history[i];
      if (pt.lower != null) {
        ctx.lineTo(getX(i), getY(pt.lower));
      }
    }
    ctx.closePath();
    ctx.fillStyle = c.bbChannel;
    ctx.fill();

    // Border lines
    ctx.strokeStyle = c.bbLines;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);

    ctx.beginPath();
    history.forEach((pt, i) => {
      if (pt.upper != null) {
        if (i === 0) ctx.moveTo(getX(i), getY(pt.upper));
        else ctx.lineTo(getX(i), getY(pt.upper));
      }
    });
    ctx.stroke();

    ctx.beginPath();
    history.forEach((pt, i) => {
      if (pt.lower != null) {
        if (i === 0) ctx.moveTo(getX(i), getY(pt.lower));
        else ctx.lineTo(getX(i), getY(pt.lower));
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. Plot SMA line
  const showSMA = E.toggleSma ? E.toggleSma.checked : true;
  if (showSMA) {
    ctx.beginPath();
    let firstSma = true;
    history.forEach((pt, i) => {
      if (pt.sma != null) {
        if (firstSma) {
          ctx.moveTo(getX(i), getY(pt.sma));
          firstSma = false;
        } else {
          ctx.lineTo(getX(i), getY(pt.sma));
        }
      }
    });
    ctx.strokeStyle = c.sma;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 4. Plot Price line (glowing)
  ctx.beginPath();
  history.forEach((pt, i) => {
    if (i === 0) ctx.moveTo(getX(i), getY(pt.price));
    else ctx.lineTo(getX(i), getY(pt.price));
  });
  ctx.strokeStyle = c.cyan;
  ctx.lineWidth = 2.2;
  ctx.shadowColor = c.priceShadow;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0; // Reset shadow

  // 5. Guideline hover marker
  if (guidelineIndex >= 0 && guidelineIndex < history.length) {
    const pt = history[guidelineIndex];
    const cx = getX(guidelineIndex);
    const cy = getY(pt.price);

    ctx.beginPath();
    ctx.moveTo(cx, 15);
    ctx.lineTo(cx, h - 15);
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctx.fillStyle = c.cyan;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 6. Plot execution node markers
  history.forEach((pt, i) => {
    if (pt.trade) {
      const cx = getX(i);
      const cy = getY(pt.price);

      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
      
      let fillCol = c.amber;
      if (pt.trade === 'BUY') fillCol = c.green;
      else if (pt.trade === 'SELL') fillCol = c.rose;
      
      ctx.fillStyle = fillCol;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.25;
      ctx.stroke();

      ctx.fillStyle = (pt.trade === 'BUY' || pt.trade === 'STOP_LOSS') ? '#000000' : '#ffffff';
      ctx.font = 'bold 8px "Syne", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const char = pt.trade === 'BUY' ? 'B' : (pt.trade === 'SELL' ? 'S' : 'L');
      ctx.fillText(char, cx, cy);
    }
  });
}

function initChartInteraction() {
  const canvas = $('price-chart');
  const tooltip = $('chart-tooltip');
  if (!canvas || !tooltip) return;

  const showTooltip = (e) => {
    if (!chartHistory || chartHistory.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;

    const getX = (i) => {
      if (chartHistory.length <= 1) return w / 2;
      return 35 + (i / (chartHistory.length - 1)) * (w - 70);
    };

    let closestIndex = 0;
    let minDistance = Infinity;

    for (let i = 0; i < chartHistory.length; i++) {
      const cx = getX(i);
      const dist = Math.abs(x - cx);
      if (dist < minDistance) {
        minDistance = dist;
        closestIndex = i;
      }
    }

    const pt = chartHistory[closestIndex];
    if (!pt) return;

    // Draw guidelines
    drawChart(chartHistory, closestIndex);

    // Position and populate tooltip
    const tX = getX(closestIndex) + 12;
    tooltip.style.left = `${tX}px`;
    tooltip.style.top = `${Math.max(10, Math.min(rect.height - 90, y - 40))}px`;
    tooltip.style.opacity = '1';

    let tradeText = '';
    if (pt.trade) {
      const cls = pt.trade === 'BUY' ? 'buy-color' : (pt.trade === 'SELL' ? 'sell-color' : 'stop-color');
      const label = pt.trade === 'STOP_LOSS' ? 'STOP LOSS' : pt.trade;
      tradeText = `<div class="tooltip-row" style="margin-top:2px;"><span style="font-weight:bold" class="${cls}">EVENT: ${label}</span></div>`;
    }

    tooltip.innerHTML = `
      <div class="tooltip-time">${pt.timestamp}</div>
      <div class="tooltip-row">Price: <span class="tooltip-val">${fmt$(pt.price)}</span></div>
      ${pt.sma ? `<div class="tooltip-row">SMA: <span class="tooltip-val">${fmt$(pt.sma)}</span></div>` : ''}
      ${pt.rsi ? `<div class="tooltip-row">RSI: <span class="tooltip-val">${pt.rsi}</span></div>` : ''}
      ${tradeText}
    `;
  };

  canvas.addEventListener('mousemove', showTooltip);
  canvas.addEventListener('mouseleave', () => {
    tooltip.style.opacity = '0';
    drawChart(chartHistory);
  });
}

// ─── LOG STREAM ───────────────────────────────────────────────────────────────

function startLogStream() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`${BASE}/api/logs`);
  evtSource.onmessage = e => appendLog(JSON.parse(e.data));
}

function appendLog(line) {
  logCount++;
  E.logCount.textContent = `${logCount} event${logCount !== 1 ? 's' : ''}`;

  const m    = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$/);
  const time = m ? m[1] : '';
  const msg  = m ? m[2] : line;

  let cls = '';
  if      (/Filled BUY/i.test(msg))        cls = 'buy';
  else if (/Filled SELL/i.test(msg))       cls = 'sell';
  else if (/^Risk:/i.test(msg))            cls = 'risk';
  else if (/^Filter:/i.test(msg))          cls = 'filter';
  else if (/Error/i.test(msg))             cls = 'err';
  else if (/^System:/i.test(msg))          cls = 'sys';
  else if (/^Signal:/i.test(msg))          cls = 'sig';
  else if (/^Calibrating:/i.test(msg))     cls = 'sig';

  const row = document.createElement('div');
  row.className = `log-row ${cls}`;
  row.innerHTML = `<span class="log-ts">${time}</span><span class="log-body">${esc(msg)}</span>`;
  E.logOutput.appendChild(row);
  E.logOutput.scrollTop = E.logOutput.scrollHeight;

  while (E.logOutput.children.length > 500) E.logOutput.removeChild(E.logOutput.firstChild);
}

// ─── CONTROLS ────────────────────────────────────────────────────────────────

E.btnStart.addEventListener('click', async () => {
  const key = E.inApiKey.value.trim();
  if (!key) {
    E.inApiKey.style.borderColor = 'rgba(251,113,133,0.55)';
    E.inApiKey.focus();
    setTimeout(() => E.inApiKey.style.borderColor = '', 1600);
    return;
  }

  E.btnStart.disabled = true;
  E.btnStart.textContent = 'Starting…';

  try {
    const res = await fetch(`${BASE}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:          key,
        symbol:           (E.inSymbol.value.trim() || 'BTC').toUpperCase(),
        interval:         parseInt(E.inInterval.value)  || 300,
        trade_amt:        parseFloat(E.inTrade.value)   || 500,
        wallet:           parseFloat(E.inWallet.value)  || 10000,
        
        // Advanced configurable settings
        position_mode:    E.inPosMode.value,
        buy_risk_pct:     (parseFloat(E.inRiskPct.value) || 20) / 100,
        stop_loss_pct:    (parseFloat(E.inStopLoss.value) || 7) / 100,
        take_profit_pct:  (parseFloat(E.inTakeProfit.value) || 10) / 100,
        ai_learning_rate: parseFloat(E.inLr.value) || 0.01,
        bb_window:        parseInt(E.inBbWindow.value) || 20,
        bb_stddev:        parseFloat(E.inBbStdDev.value) || 2.0,
        rsi_period:       parseInt(E.inRsiPeriod.value) || 14,
        rsi_oversold:     parseInt(E.inRsiOversold.value) || 35,
        rsi_overbought:   parseInt(E.inRsiOverbought.value) || 65,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Start failed');
    syncStatus();
  } catch (e) {
    appendLog(`[--:--:--]  Error: ${e.message}`);
    E.btnStart.disabled = false;
  }

  E.btnStart.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Initialize Sync`;
});

E.btnStop.addEventListener('click', async () => {
  await fetch(`${BASE}/api/stop`, { method: 'POST' });
  syncStatus();
});

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function fmt$(n) {
  if (typeof formatCurrency === 'function') {
    return formatCurrency(n);
  }
  return '$' + (n || 0).toFixed(2);
}

function flash(el, cls) {
  el.classList.remove('up', 'down');
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1400);
}

function lockInputs(v) {
  const elements = [
    E.inApiKey, E.inSymbol, E.inInterval, E.inTrade, E.inWallet,
    E.inPosMode, E.inRiskPct, E.inStopLoss, E.inTakeProfit, E.inLr,
    E.inBbWindow, E.inBbStdDev, E.inRsiPeriod, E.inRsiOversold, E.inRsiOverbought
  ];
  elements.forEach(el => {
    if (el) {
      el.disabled = v;
      el.style.opacity = v ? '0.4' : '1';
    }
  });
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

boot();