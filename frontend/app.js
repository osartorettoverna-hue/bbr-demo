'use strict';

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
const CHANNEL_PRESETS = {
  fibra:     { delay_ms: 1,   loss_pct: 0,   bandwidth_mbps: 1000, label: 'Fibra ottica' },
  wifi:      { delay_ms: 10,  loss_pct: 0.5, bandwidth_mbps: 100,  label: 'WiFi' },
  adsl:      { delay_ms: 30,  loss_pct: 0.1, bandwidth_mbps: 20,   label: 'ADSL' },
  lte:       { delay_ms: 40,  loss_pct: 1.0, bandwidth_mbps: 50,   label: '4G/LTE' },
  satellite: { delay_ms: 600, loss_pct: 2.0, bandwidth_mbps: 5,    label: 'Satellite' },
};

const state = {
  scenario: { delay_ms: 50, loss_pct: 1.0, bandwidth_mbps: 1000, applied: false },
  testRunning: false,
  ws: null,
  activeAlgo: null,           // 'cubic' | 'bbr'
  liveData: { cubic: [], bbr: [] },
  results: { cubic: null, bbr: null },   // current-scenario results
  allResults: [],
  chart: null,
  statusInterval: null,
  dropEvents: [],             // [{t, algo}] — CUBIC window-cut events
};

const COLORS = { cubic: '#E85D04', bbr: '#0077B6' };
const BASE = 'http://localhost:8000';
const WS   = 'ws://localhost:8000/ws/test';

// ═══════════════════════════════════════════════
// DOM REFS
// ═══════════════════════════════════════════════
const $ = id => document.getElementById(id);

const dom = {
  delaySlider:  $('delay-slider'),
  delayVal:     $('delay-val'),
  lossSlider:   $('loss-slider'),
  lossVal:      $('loss-val'),
  bwSlider:     $('bw-slider'),
  bwVal:        $('bw-val'),
  channelBtns:  $('channel-btns'),
  applyBtn:     $('apply-btn'),
  scenarioDot:  $('scenario-dot'),
  scenarioText: $('scenario-text'),
  // cubic
  cubicCard:    $('cubic-card'),
  cubicBtn:     $('cubic-btn'),
  cubicIdle:    $('cubic-idle'),
  cubicRunning: $('cubic-running'),
  cubicDone:    $('cubic-done'),
  cubicFill:    $('cubic-fill'),
  cubicLabel:   $('cubic-progress-label'),
  cubicLive:    $('cubic-live'),
  cubicAvg:     $('cubic-avg'),
  cubicMax:     $('cubic-max'),
  cubicTag:     $('cubic-tag'),
  cubicRerun:   $('cubic-rerun-btn'),
  // bbr
  bbrCard:      $('bbr-card'),
  bbrBtn:       $('bbr-btn'),
  bbrIdle:      $('bbr-idle'),
  bbrRunning:   $('bbr-running'),
  bbrDone:      $('bbr-done'),
  bbrFill:      $('bbr-fill'),
  bbrLabel:     $('bbr-progress-label'),
  bbrLive:      $('bbr-live'),
  bbrAvg:       $('bbr-avg'),
  bbrMax:       $('bbr-max'),
  bbrTag:       $('bbr-tag'),
  bbrRerun:     $('bbr-rerun-btn'),
  // other
  dockerDot:    $('docker-dot'),
  dockerText:   $('docker-text'),
  resetBtn:     $('reset-btn'),
  helpBtn:      $('help-btn'),
  helpModal:    $('help-modal'),
  modalClose:   $('modal-close'),
  exportAll:    $('export-all-btn'),
  exportCur:    $('export-current-btn'),
  resultsTbody: $('results-tbody'),
  emptyRow:     $('empty-row'),
  toast:        $('toast'),
};

// ═══════════════════════════════════════════════
// DROP ANNOTATION PLUGIN
// ═══════════════════════════════════════════════
const dropPlugin = {
  id: 'drops',
  afterDraw(chart) {
    if (!state.dropEvents.length) return;
    const { ctx, scales: { x, y } } = chart;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const ev of state.dropEvents) {
      const px = x.getPixelForValue(ev.t);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = COLORS[ev.algo] + 'BB';
      ctx.beginPath();
      ctx.moveTo(px, y.top);
      ctx.lineTo(px, y.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS[ev.algo] + 'CC';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('↓cwnd', px, y.top + 11);
    }
    ctx.restore();
  },
};

// ═══════════════════════════════════════════════
// CHART INIT
// ═══════════════════════════════════════════════
function initChart() {
  const ctx = $('throughput-chart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'CUBIC',
          data: [],
          borderColor: COLORS.cubic,
          backgroundColor: COLORS.cubic + '18',
          borderWidth: 2.5,
          pointRadius: 2,
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'BBR',
          data: [],
          borderColor: COLORS.bbr,
          backgroundColor: COLORS.bbr + '18',
          borderWidth: 2.5,
          pointRadius: 2,
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'RTT CUBIC',
          data: [],
          borderColor: COLORS.cubic + '70',
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          yAxisID: 'y2',
        },
        {
          label: 'RTT BBR',
          data: [],
          borderColor: COLORS.bbr + '70',
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Tempo (s)', font: { size: 13, weight: '600' } },
          min: 0,
          ticks: { stepSize: 5 },
          grid: { color: '#E2E8F0' },
        },
        y: {
          title: { display: true, text: 'Throughput (Mbps)', font: { size: 13, weight: '600' } },
          min: 0,
          position: 'left',
          grid: { color: '#E2E8F0' },
        },
        y2: {
          title: { display: true, text: 'RTT (ms)', font: { size: 11, weight: '500' }, color: '#94A3B8' },
          min: 0,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#94A3B8', font: { size: 10 } },
        },
      },
      plugins: {
        legend: { display: false },  // custom legend in HTML
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex <= 1) {
                return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} Mbps`;
              }
              return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} ms`;
            },
          },
        },
      },
    },
    plugins: [dropPlugin],
  });
}

function chartReset() {
  for (let i = 0; i < 4; i++) state.chart.data.datasets[i].data = [];
  state.dropEvents = [];
  state.chart.update('none');
}

function chartPush(algo, t, mbps, rttMs) {
  const tpIdx  = algo === 'cubic' ? 0 : 1;
  const rttIdx = algo === 'cubic' ? 2 : 3;

  const tpData = state.chart.data.datasets[tpIdx].data;
  tpData.push({ x: t, y: mbps });

  if (rttMs != null) {
    state.chart.data.datasets[rttIdx].data.push({ x: t, y: rttMs });
  }

  // Detect CUBIC window cut: drop > 28% vs previous second
  if (algo === 'cubic' && tpData.length >= 2) {
    const prev = tpData[tpData.length - 2].y;
    if (prev > 1 && mbps < prev * 0.72) {
      state.dropEvents.push({ t, algo });
    }
  }

  state.chart.update('none');
}

// chartLoadResult not needed — live chartPush already uses correct timestamps

// ═══════════════════════════════════════════════
// SLIDERS
// ═══════════════════════════════════════════════
function bwLabel(mbps) {
  return mbps >= 1000 ? '1 Gbps' : `${mbps} Mbps`;
}

function setChannelActive(key) {
  dom.channelBtns.querySelectorAll('.btn-channel').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.channel === key);
  });
}

function applyPreset(key) {
  const p = CHANNEL_PRESETS[key];
  if (!p) return;
  dom.delaySlider.value = p.delay_ms;
  dom.delayVal.textContent = `${p.delay_ms} ms`;
  state.scenario.delay_ms = p.delay_ms;
  dom.lossSlider.value = p.loss_pct;
  dom.lossVal.textContent = `${p.loss_pct.toFixed(1)} %`;
  state.scenario.loss_pct = p.loss_pct;
  dom.bwSlider.value = p.bandwidth_mbps;
  dom.bwVal.textContent = bwLabel(p.bandwidth_mbps);
  state.scenario.bandwidth_mbps = p.bandwidth_mbps;
  setChannelActive(key);
}

function initSliders() {
  dom.delaySlider.addEventListener('input', () => {
    const v = parseInt(dom.delaySlider.value);
    dom.delayVal.textContent = `${v} ms`;
    state.scenario.delay_ms = v;
    setChannelActive('custom');
  });
  dom.lossSlider.addEventListener('input', () => {
    const v = parseFloat(dom.lossSlider.value);
    dom.lossVal.textContent = `${v.toFixed(1)} %`;
    state.scenario.loss_pct = v;
    setChannelActive('custom');
  });
  dom.bwSlider.addEventListener('input', () => {
    const v = parseInt(dom.bwSlider.value);
    dom.bwVal.textContent = bwLabel(v);
    state.scenario.bandwidth_mbps = v;
    setChannelActive('custom');
  });
  dom.channelBtns.querySelectorAll('.btn-channel').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.channel;
      if (key === 'custom') { setChannelActive('custom'); return; }
      applyPreset(key);
    });
  });
}

// ═══════════════════════════════════════════════
// SCENARIO
// ═══════════════════════════════════════════════
dom.applyBtn.addEventListener('click', async () => {
  dom.applyBtn.disabled = true;
  dom.applyBtn.textContent = '⏳ Applicazione...';
  try {
    const res = await fetch(`${BASE}/api/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delay_ms: state.scenario.delay_ms,
        loss_pct: state.scenario.loss_pct,
        bandwidth_mbps: state.scenario.bandwidth_mbps,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Errore');

    state.scenario.applied = true;
    setScenarioBadge(true);
    updateDiagram(true, state.scenario.delay_ms, state.scenario.loss_pct);
    // Reset chart and results for the new scenario
    chartReset();
    state.liveData = { cubic: [], bbr: [] };
    state.results  = { cubic: null, bbr: null };
    resetCardToIdle('cubic');
    resetCardToIdle('bbr');
    document.getElementById('insight-section').style.display = 'none';
    showToast(`Scenario applicato: ${state.scenario.delay_ms} ms RTT, ${state.scenario.loss_pct.toFixed(1)}% loss, ${bwLabel(state.scenario.bandwidth_mbps)}`);
  } catch (err) {
    showToast(`❌ ${err.message}`, true);
  } finally {
    dom.applyBtn.disabled = false;
    dom.applyBtn.innerHTML = '<span class="btn-icon">⚡</span> Applica scenario';
  }
});

function setScenarioBadge(applied) {
  if (applied) {
    dom.scenarioDot.className = 'status-dot dot-active';
    dom.scenarioText.textContent =
      `Scenario attivo: ${state.scenario.delay_ms} ms RTT · ${state.scenario.loss_pct.toFixed(1)}% loss · ${bwLabel(state.scenario.bandwidth_mbps)}`;
  } else {
    dom.scenarioDot.className = 'status-dot dot-inactive';
    dom.scenarioText.textContent = 'Scenario non applicato';
  }
}

// ═══════════════════════════════════════════════
// CARD STATE MANAGEMENT
// ═══════════════════════════════════════════════
function cardShow(algo, phase) {
  // phase: 'idle' | 'running' | 'done'
  const prefix = algo;
  dom[`${prefix}Idle`].style.display    = phase === 'idle'    ? '' : 'none';
  dom[`${prefix}Running`].style.display = phase === 'running' ? '' : 'none';
  dom[`${prefix}Done`].style.display    = phase === 'done'    ? '' : 'none';

  const card = dom[`${prefix}Card`];
  card.classList.toggle('card-active', phase === 'running');
}

function resetCardToIdle(algo) {
  cardShow(algo, 'idle');
  dom[`${algo}Btn`].disabled = false;
}

function setCardRunning(algo, elapsed, total, mbps) {
  cardShow(algo, 'running');
  const pct = Math.min((elapsed / total) * 100, 100);
  dom[`${algo}Fill`].style.width = `${pct}%`;
  dom[`${algo}Label`].textContent = `${elapsed} / ${total} s`;
  dom[`${algo}Live`].textContent = mbps !== null ? mbps.toFixed(1) : '—';
}

function setCardDone(algo, result) {
  cardShow(algo, 'done');
  const scen = result.scenario;
  dom[`${algo}Avg`].textContent  = result.avg_mbps.toFixed(1);
  dom[`${algo}Max`].textContent  = `${result.max_mbps.toFixed(1)} Mbps`;
  dom[`${algo}Tag`].textContent  = `${scen.delay_ms} ms / ${scen.loss_pct.toFixed(1)}%`;
  dom[`${algo}Rerun`].onclick    = () => startTest(algo);
}

// ═══════════════════════════════════════════════
// WEBSOCKET TEST
// ═══════════════════════════════════════════════
window.startTest = function(algo) {
  if (state.testRunning) { showToast('Un test è già in corso', true); return; }
  if (!state.scenario.applied) { showToast('Applica prima uno scenario di rete', true); return; }

  state.testRunning = true;
  state.activeAlgo  = algo;
  state.liveData[algo] = [];

  // disable both test buttons
  dom.cubicBtn.disabled = true;
  dom.bbrBtn.disabled   = true;
  cardShow(algo, 'running');
  setCardRunning(algo, 0, 30, null);
  setDiagramAlgo(algo);
  startPackets(algo);

  const ws = new WebSocket(WS);
  state.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ algorithm: algo, duration: 30 }));
  };

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'error') {
      showToast(`❌ ${msg.message}`, true);
      testCleanup(algo, false);
      return;
    }

    if (msg.type === 'interval') {
      state.liveData[algo].push(msg.mbps);
      setCardRunning(algo, msg.elapsed, msg.total, msg.mbps);
      chartPush(algo, msg.t, msg.mbps, msg.rtt_ms ?? null);
    }

    if (msg.type === 'done') {
      const result = msg.result;
      state.results[algo] = result;
      state.allResults.push(result);
      setCardDone(algo, result);
      updateTable();
      testCleanup(algo, true);
      buildInsight();
      showToast(`✅ ${algo.toUpperCase()} completato: ${result.avg_mbps.toFixed(1)} Mbps medi`);
    }
  };

  ws.onerror = () => {
    showToast('❌ Connessione WebSocket persa', true);
    testCleanup(algo, false);
  };

  ws.onclose = () => {
    if (state.testRunning && state.activeAlgo === algo) {
      testCleanup(algo, false);
    }
  };
};

function testCleanup(algo, success) {
  state.testRunning = false;
  state.activeAlgo  = null;
  if (state.ws) { state.ws.close(); state.ws = null; }

  stopPackets();
  setDiagramAlgo(null);
  if (state.scenario.applied) startIdlePackets(state.scenario.loss_pct);

  if (!success) resetCardToIdle(algo);

  // re-enable buttons
  dom.cubicBtn.disabled = false;
  dom.bbrBtn.disabled   = false;
}

// ═══════════════════════════════════════════════
// RESULTS TABLE
// ═══════════════════════════════════════════════
function updateTable() {
  // Group results by scenario key
  const groups = {};
  for (const r of state.allResults) {
    const bw = r.scenario.bandwidth_mbps ?? 1000;
    const key = `${r.scenario.delay_ms}_${r.scenario.loss_pct}_${bw}`;
    if (!groups[key]) {
      groups[key] = {
        delay_ms: r.scenario.delay_ms,
        loss_pct: r.scenario.loss_pct,
        bandwidth_mbps: bw,
        cubic: null, bbr: null,
        ts: r.timestamp,
      };
    }
    groups[key][r.algorithm] = r.avg_mbps;
    groups[key].ts = r.timestamp;
  }

  const rows = Object.values(groups).sort((a, b) => b.ts.localeCompare(a.ts));

  if (rows.length === 0) {
    dom.emptyRow.style.display = '';
    return;
  }
  dom.emptyRow.style.display = 'none';
  dom.resultsTbody.innerHTML = '';

  for (const g of rows) {
    const tr  = document.createElement('tr');
    const ratio = (g.cubic && g.bbr) ? (g.bbr / g.cubic) : null;
    const ratioClass = ratio === null ? 'ratio-low'
                     : ratio >= 2    ? 'ratio-good'
                     : ratio >= 1.2  ? 'ratio-ok'
                     : 'ratio-low';
    const ratioText = ratio !== null ? `${ratio.toFixed(2)}×` : '—';

    tr.innerHTML = `
      <td><strong>${g.delay_ms} ms</strong> / ${g.loss_pct.toFixed(1)}% / ${bwLabel(g.bandwidth_mbps)}</td>
      <td class="col-cubic">${g.cubic !== null ? g.cubic.toFixed(1) : '—'}</td>
      <td class="col-bbr">${g.bbr   !== null ? g.bbr.toFixed(1)   : '—'}</td>
      <td class="${ratioClass}">${ratioText}</td>
      <td style="font-size:.8rem;color:var(--text-muted)">${formatTs(g.ts)}</td>
    `;
    dom.resultsTbody.appendChild(tr);
  }
}

function formatTs(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ═══════════════════════════════════════════════
// NETWORK DIAGRAM
// ═══════════════════════════════════════════════
let packetTimer = null;
let idlePacketTimer = null;

function updateDiagram(applied, delay, loss) {
  const info = document.getElementById('net-link-info');
  if (applied) {
    info.textContent = `${delay} ms RTT · ${loss.toFixed(1)}% loss · ${bwLabel(state.scenario.bandwidth_mbps)}`;
    info.classList.add('active');
    startIdlePackets(loss);
  } else {
    info.textContent = 'Scenario non applicato';
    info.classList.remove('active');
    stopIdlePackets();
  }
}

function setDiagramAlgo(algo) {
  const client = document.getElementById('net-box-client');
  const server = document.getElementById('net-box-server');
  client.className = `net-box net-box--client${algo ? ` active-${algo}` : ''}`;
  server.className = `net-box net-box--server${algo ? ` active-${algo}` : ''}`;
}

function spawnPkt(track, color, loss, fast) {
  const pkt = document.createElement('span');
  pkt.className = 'pkt';
  pkt.style.background = color;
  const willDrop = Math.random() < Math.min(loss / 100 * 4, 0.55);
  const dur   = fast ? (600 + Math.random() * 400) : (1400 + Math.random() * 600);
  const delay = Math.random() * (fast ? 200 : 500);
  pkt.style.animation = `${willDrop ? 'pkt-drop' : 'pkt-travel'} ${dur}ms ${delay}ms linear forwards`;
  track.appendChild(pkt);
  setTimeout(() => pkt.remove(), dur + delay + 100);
}

function startIdlePackets(loss) {
  stopIdlePackets();
  const track = document.getElementById('net-link-track');
  idlePacketTimer = setInterval(() => spawnPkt(track, '#94A3B8', loss, false), 700);
}

function stopIdlePackets() {
  if (idlePacketTimer) { clearInterval(idlePacketTimer); idlePacketTimer = null; }
}

function startPackets(algo) {
  stopIdlePackets();
  stopPackets();
  const track = document.getElementById('net-link-track');
  const color  = COLORS[algo];
  const loss   = state.scenario.loss_pct;
  packetTimer = setInterval(() => spawnPkt(track, color, loss, true), 140);
}

function stopPackets() {
  if (packetTimer) { clearInterval(packetTimer); packetTimer = null; }
  document.querySelectorAll('.pkt').forEach(p => p.remove());
}

// ═══════════════════════════════════════════════
// INSIGHT PANEL
// ═══════════════════════════════════════════════
function buildInsight() {
  const cRes = state.results.cubic;
  const bRes = state.results.bbr;
  if (!cRes && !bRes) return;

  const delay = state.scenario.delay_ms;
  const loss  = state.scenario.loss_pct;

  function colStats(res) {
    if (!res) return null;
    const tps = res.throughputs;
    const avg = res.avg_mbps;
    const drops = tps.filter((v, i) => i > 0 && v < tps[i - 1] * 0.72).length;
    const variance = Math.sqrt(tps.reduce((s, v) => s + (v - avg) ** 2, 0) / tps.length);
    const bdp = ((delay / 1000) * avg * 1e6 / 8 / 1024).toFixed(1); // KB
    return { avg, max: res.max_mbps, drops, variance: variance.toFixed(1), bdp };
  }

  const cs = colStats(cRes);
  const bs = colStats(bRes);

  function cubicCol() {
    if (!cs) return '<div class="insight-col insight-col--cubic"><p style="color:var(--text-muted);font-size:.85rem">Test CUBIC non eseguito</p></div>';
    return `
      <div class="insight-col insight-col--cubic">
        <div class="insight-col-title">
          TCP CUBIC <span class="insight-badge">Loss-based</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">Throughput medio</span>
          <span class="insight-stat-val">${cs.avg.toFixed(1)} Mbps</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">Cali bruschi rilevati</span>
          <span class="insight-stat-val">${cs.drops} eventi</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">Varianza throughput</span>
          <span class="insight-stat-val">±${cs.variance} Mbps</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">BDP stimato</span>
          <span class="insight-stat-val">${cs.bdp} KB</span>
        </div>
        <p class="insight-note">
          Con <strong>${loss.toFixed(1)}% di perdita</strong>, CUBIC interpreta ogni pacchetto perso come
          <strong>segnale di congestione</strong> e riduce <em>cwnd</em> del 30%.
          Questo causa i cali visibili nel grafico, seguiti da lenta risalita cubica.
          ${loss === 0 ? 'Con loss=0% il comportamento è ottimale.' : ''}
        </p>
      </div>`;
  }

  function bbrCol() {
    if (!bs) return '<div class="insight-col insight-col--bbr"><p style="color:var(--text-muted);font-size:.85rem">Test BBR non eseguito</p></div>';
    const rtprop = delay; // netem delay ≈ RTprop
    return `
      <div class="insight-col insight-col--bbr">
        <div class="insight-col-title">
          TCP BBR <span class="insight-badge">Model-based</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">Throughput medio</span>
          <span class="insight-stat-val">${bs.avg.toFixed(1)} Mbps</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">RTprop stimato</span>
          <span class="insight-stat-val">≈ ${rtprop} ms</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">BtlBw stimato</span>
          <span class="insight-stat-val">≈ ${bs.max.toFixed(1)} Mbps</span>
        </div>
        <div class="insight-stat">
          <span class="insight-stat-key">Varianza throughput</span>
          <span class="insight-stat-val">±${bs.variance} Mbps</span>
        </div>
        <p class="insight-note">
          BBR <strong>ignora le perdite casuali</strong>: non abbassa <em>cwnd</em> in risposta ai drop.
          Stima il <strong>BDP = BtlBw × RTprop</strong> e mantiene la finestra costante.
          Il grafico è molto più stabile rispetto a CUBIC${loss > 0 ? ', specialmente con perdite.' : '.'}
        </p>
      </div>`;
  }

  function verdict() {
    if (!cs || !bs) return '';
    const ratio = bs.avg / cs.avg;
    const winner = ratio > 1 ? 'BBR' : 'CUBIC';
    const ratioText = ratio > 1 ? ratio.toFixed(2) : (1 / ratio).toFixed(2);
    const context = loss >= 2
      ? `Con ${loss.toFixed(1)}% di perdita, BBR è tipicamente 2–10× superiore perché non reagisce ai drop casuali.`
      : loss > 0
        ? `Con ${loss.toFixed(1)}% di perdita il vantaggio BBR è già visibile; aumenta con la percentuale di loss.`
        : 'Con loss=0% le performance sono simili: la rete è ideale e CUBIC non soffre penalizzazioni.';
    return `
      <div class="insight-verdict">
        <strong>${winner} vince per ${ratioText}× in questo scenario.</strong>
        ${context}
        ${delay >= 100 ? ` Con RTT alto (${delay} ms) il BDP è grande: BBR lo sfrutta meglio.` : ''}
      </div>`;
  }

  document.getElementById('insight-tag').textContent =
    `${delay} ms RTT · ${loss.toFixed(1)}% loss`;
  document.getElementById('insight-body').innerHTML =
    cubicCol() + bbrCol() + verdict();
  document.getElementById('insight-section').style.display = '';
}

// ═══════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════
dom.exportAll.addEventListener('click', exportAllChart);
dom.exportCur.addEventListener('click', exportCurrentCanvas);

function exportCurrentCanvas() {
  if (!state.results.cubic && !state.results.bbr) {
    showToast('❌ Nessun dato da esportare', true);
    return;
  }
  const canvas = document.getElementById('throughput-chart');
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const delay = state.scenario.delay_ms;
    const loss  = state.scenario.loss_pct.toFixed(1);
    a.href = url;
    a.download = `bbr_vs_cubic_${delay}ms_${loss}pct.png`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('⬇ Grafico scaricato');
  }, 'image/png');
}

async function exportAllChart() {
  if (state.allResults.length === 0) {
    showToast('❌ Nessun risultato disponibile', true);
    return;
  }
  try {
    const url = `${BASE}/api/export-chart?mode=all`;
    const res = await fetch(url);
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.detail || 'Errore export');
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    window.open(objUrl, '_blank');
    showToast('📊 Confronto scenari aperto in nuova tab');
  } catch (err) {
    showToast(`❌ ${err.message}`, true);
  }
}

// ═══════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════
dom.resetBtn.addEventListener('click', async () => {
  if (!confirm('Reset tutto: rimuove le regole netem e riavvia iperf3. Continuare?')) return;
  try {
    const res = await fetch(`${BASE}/api/reset`, { method: 'POST' });
    if (!res.ok) throw new Error('Errore reset');
    state.scenario.applied = false;
    state.results = { cubic: null, bbr: null };
    state.liveData = { cubic: [], bbr: [] };
    state.allResults = [];
    state.testRunning = false;
    setScenarioBadge(false);
    updateDiagram(false, 0, 0);
    stopPackets();
    stopIdlePackets();
    setDiagramAlgo(null);
    chartReset();
    resetCardToIdle('cubic');
    resetCardToIdle('bbr');
    document.getElementById('insight-section').style.display = 'none';
    dom.resultsTbody.innerHTML = '';
    dom.emptyRow.style.display = '';
    showToast('🔄 Reset completato');
  } catch (err) {
    showToast(`❌ ${err.message}`, true);
  }
});

// ═══════════════════════════════════════════════
// DOCKER STATUS POLL
// ═══════════════════════════════════════════════
async function pollStatus() {
  try {
    const res  = await fetch(`${BASE}/api/status`);
    const data = await res.json();
    const ok   = data.docker === 'ok' && data.server && data.client;
    dom.dockerDot.className  = `status-dot ${ok ? 'dot-active' : 'dot-error'}`;
    dom.dockerText.textContent = ok
      ? 'Docker OK — server + client attivi'
      : `Docker: ${data.error || 'container non pronti'}`;
  } catch {
    dom.dockerDot.className  = 'status-dot dot-error';
    dom.dockerText.textContent = 'Backend non raggiungibile';
  }
}

// ═══════════════════════════════════════════════
// HELP MODAL
// ═══════════════════════════════════════════════
dom.helpBtn.addEventListener('click', () => {
  dom.helpModal.style.display = 'flex';
});
dom.modalClose.addEventListener('click', () => {
  dom.helpModal.style.display = 'none';
});
dom.helpModal.addEventListener('click', e => {
  if (e.target === dom.helpModal) dom.helpModal.style.display = 'none';
});

// ═══════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════
let toastTimer = null;
function showToast(msg, isError = false) {
  dom.toast.textContent = msg;
  dom.toast.style.background = isError ? '#DC2626' : '#1E293B';
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 3500);
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  initSliders();

  // Wire up test buttons
  dom.cubicBtn.addEventListener('click', () => startTest('cubic'));
  dom.bbrBtn.addEventListener('click',   () => startTest('bbr'));

  // Initial status check + periodic poll
  pollStatus();
  state.statusInterval = setInterval(pollStatus, 5000);
});
