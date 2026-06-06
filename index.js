/**
 * Token 统计监控 for SillyTavern  v3.0.0
 * ====================================================================
 *
 * 综合 CodeWhale + ST-Statistics + rskzayton 方案的中文 Token 监控面板：
 *   - 实时 token 用量（输入 / 输出 / 合计）
 *   - 缓存命中/未命中统计 + 命中率可视化（支持 DeepSeek / Anthropic / OpenAI）
 *   - 人民币成本估算（支持 DeepSeek V4/Claude/GPT 多模型定价）
 *   - 吞吐量追踪（tokens/秒）
 *   - 缓存效率评分（0-100，颜色编码）
 *   - 每个对话独立存储（localStorage，切换不丢失）
 *   - 迷你趋势图（最近 20 次请求的 token 变化）
 *   - STscript 命令：/token-stats, /token-reset
 *   - 可拖拽、可折叠浮动面板
 *
 * 安装：在 ST 扩展管理器中粘贴 GitHub 仓库 URL 即可。
 *   https://github.com/rskzayton/ST-TokenCacheMonitor
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

import {
    extension_settings as extensionSettings,
    getContext,
} from '../../../extensions.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const EXT_NAME = 'token-cache-monitor';
const MAX_HISTORY = 20;
let _currentChatId = '';

/** 每个对话独立的 localStorage key（基于角色名） */
function getChatKey() {
    if (!_currentChatId) {
        try { _currentChatId = getContext()?.name2 || 'default'; } catch { _currentChatId = 'default'; }
    }
    return `tcm_v3_${_currentChatId}`;
}

/** Pricing per 1M tokens (USD), updated 2026-06.
 *  DeepSeek cache pricing: https://api-docs.deepseek.com/quick_start/pricing */
const PRICING = {
    'deepseek-v4-pro':   { input: 3.13, cacheHit: 0.026, output: 6.26 },
    'deepseek-v4-flash': { input: 1.01, cacheHit: 0.020, output: 2.02 },
    'deepseek-v3':       { input: 1.0,  cacheHit: 0.1,   output: 2.0  },
    'deepseek-r1':       { input: 4.0,  cacheHit: 1.0,   output: 16.0 },
    'claude-sonnet-4':   { input: 10.9, cacheHit: 1.09,  output: 54.5 },
    'claude-haiku-4-5':  { input: 0.73, cacheHit: 0.073, output: 3.64 },
    'gpt-4o':            { input: 18.2, cacheHit: 1.82,  output: 72.7 },
    'gpt-4o-mini':       { input: 0.73, cacheHit: 0.073, output: 3.64 },
};

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const defaults = {
    panelCollapsed: false,
    panelPosition:  { x: null, y: null },
    showCacheInfo:  true,
    showSession:    true,
    showCost:       true,
    showThroughput: true,
    showTrend:      true,
    costModel:      'deepseek-v4-pro',
    customPricing:  { input: 0.55, cacheHit: 0.14, output: 2.19 },
};

let cfg = { ...defaults };

const stats = {
    // Last request
    lastPrompt:      0,
    lastCompletion:  0,
    lastCacheHit:    0,
    lastCacheMiss:   0,
    lastTime:        0,     // ms — when last request completed
    lastDuration:    0,     // ms — generation duration
    // Session totals
    totalPrompt:     0,
    totalCompletion: 0,
    totalCacheHit:   0,
    totalCacheMiss:  0,
    requests:        0,
    cost:            0,
    totalDuration:   0,     // total generation ms
    // Streaming
    streamingCount:  0,
    genStartTime:    0,
    // History ring buffer
    history:         [],
};

// ═══════════════════════════════════════════════════════════════════════════
// Persistent session state (localStorage)
// ═══════════════════════════════════════════════════════════════════════════

function saveSession() {
    try {
        const snap = {
            totalPrompt:     stats.totalPrompt,
            totalCompletion: stats.totalCompletion,
            totalCacheHit:   stats.totalCacheHit,
            totalCacheMiss:  stats.totalCacheMiss,
            requests:        stats.requests,
            cost:            stats.cost,
            totalDuration:   stats.totalDuration,
            history:         stats.history.slice(0, MAX_HISTORY),
            savedAt:         Date.now(),
        };
        localStorage.setItem(getChatKey(), JSON.stringify(snap));
    } catch { /* quota exceeded — non-critical */ }
}

function loadSession() {
    try {
        const raw = localStorage.getItem(getChatKey());
        if (!raw) return;
        const snap = JSON.parse(raw);
        if (snap.totalPrompt !== undefined)     stats.totalPrompt     = snap.totalPrompt;
        if (snap.totalCompletion !== undefined) stats.totalCompletion = snap.totalCompletion;
        if (snap.totalCacheHit !== undefined)   stats.totalCacheHit   = snap.totalCacheHit;
        if (snap.totalCacheMiss !== undefined)  stats.totalCacheMiss  = snap.totalCacheMiss;
        if (snap.requests !== undefined)        stats.requests        = snap.requests;
        if (snap.cost !== undefined)            stats.cost            = snap.cost;
        if (snap.totalDuration !== undefined)   stats.totalDuration   = snap.totalDuration;
        if (Array.isArray(snap.history))        stats.history         = snap.history.slice(0, MAX_HISTORY);
    } catch { /* ignore parse errors */ }
}

function clearSession() {
    try { localStorage.removeItem(getChatKey()); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

function loadCfg() {
    if (extensionSettings[EXT_NAME]) {
        cfg = { ...defaults, ...extensionSettings[EXT_NAME] };
    }
}

function saveCfg() {
    extensionSettings[EXT_NAME] = cfg;
    saveSettingsDebounced();
}

// ═══════════════════════════════════════════════════════════════════════════
// Pricing helpers
// ═══════════════════════════════════════════════════════════════════════════

function getPricing() {
    return cfg.costModel === 'custom'
        ? cfg.customPricing
        : (PRICING[cfg.costModel] || PRICING['deepseek-v4-pro']);
}

function currentModelName() {
    try { return getContext().onlineStatus !== 'no_connection' ? (getContext().chatMetadata?.model || cfg.costModel) : cfg.costModel; }
    catch { return cfg.costModel; }
}

/** Auto-detect if the current backend is DeepSeek */
function isDeepSeekBackend() {
    try {
        const ctx = getContext();
        // 通过已配置的 API URL 或模型名检测 DeepSeek
        const modelName = (ctx?.chatMetadata?.model || '').toLowerCase();
        if (modelName.includes('deepseek')) return true;
        // 备选：检查生成的文本特征（DeepSeek 有特定响应格式）
        return false;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Record a completed request
// ═══════════════════════════════════════════════════════════════════════════

function record(prompt, completion, cacheHit, cacheMiss, durationMs) {
    const now = Date.now();

    stats.lastPrompt     = prompt;
    stats.lastCompletion = completion;
    stats.lastCacheHit   = cacheHit;
    stats.lastCacheMiss  = cacheMiss;
    stats.lastTime       = now;
    stats.lastDuration   = durationMs || (now - (stats.genStartTime || now));

    stats.totalPrompt     += prompt;
    stats.totalCompletion += completion;
    stats.totalCacheHit   += cacheHit;
    stats.totalCacheMiss  += cacheMiss;
    stats.requests++;
    stats.totalDuration   += stats.lastDuration;
    stats.streamingCount   = 0;

    // Cost calculation: cache-hit tokens charged at cache rate, miss at input rate
    const p  = getPricing();
    const costThis = (cacheMiss  / 1_000_000) * p.input
                   + (cacheHit   / 1_000_000) * p.cacheHit
                   + (completion / 1_000_000) * p.output;
    stats.cost += costThis;

    // Throughput (tokens/sec)
    const tps = stats.lastDuration > 0
        ? Math.round(completion / (stats.lastDuration / 1000))
        : 0;

    // Cache efficiency score: 0-100
    const totalInput = cacheHit + cacheMiss;
    const effScore = totalInput > 0 ? Math.round((cacheHit / totalInput) * 100) : 0;

    stats.history.unshift({
        time: now,
        prompt, completion, cacheHit, cacheMiss,
        cost: costThis,
        tps,
        effScore,
        duration: stats.lastDuration,
    });
    if (stats.history.length > MAX_HISTORY) stats.history.pop();

    saveSession();
    refresh();
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ST Event hooks
// ═══════════════════════════════════════════════════════════════════════════

function hookEvents() {
    eventSource.on(event_types.GENERATION_STARTED, () => {
        stats.streamingCount = 0;
        stats.genStartTime = Date.now();
        refresh();
    });

    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
        stats.streamingCount++;
        // Throttle UI updates during fast streaming
        if (stats.streamingCount % 5 === 0) refresh();
    });

    // MESSAGE_RECEIVED: 最可靠的数据源，消息的 .usage 字段包含 API 完整返回
    // 注意: 此事件在用户消息和 AI 消息时都会触发
    let _msgReceivedCount = 0;
    eventSource.on(event_types.MESSAGE_RECEIVED, async (data) => {
        _msgReceivedCount++;
        console.log(`[Token监控] MESSAGE_RECEIVED #${_msgReceivedCount}`, {
            genStartTime: stats.genStartTime,
            hasGenStart: !!stats.genStartTime,
            streamingCount: stats.streamingCount,
            requests: stats.requests,
        });

        if (!stats.genStartTime) return;  // 没有正在进行的 generation，跳过

        let usage = null;

        // 数据源 1: generateRawData() — 返回完整原始 API 响应，保留 DeepSeek 缓存字段
        try {
            const ctx = getContext();
            if (typeof ctx.generateRawData === 'function') {
                const raw = await ctx.generateRawData();
                if (raw?.usage?.prompt_tokens !== undefined) {
                    usage = raw.usage;
                    // 诊断: 打印完整 usage 对象（仅前 3 次请求）
                    if (stats.requests < 3) {
                        console.log('[Token监控] generateRawData usage', JSON.parse(JSON.stringify(usage)));
                    }
                }
            }
        } catch { /* ignore */ }

        // 数据源 2: 消息对象自带的 usage（ST 标准化后可能丢失缓存字段，但 token 数准确）
        if (!usage) {
            try {
                const ctx = getContext();
                const lastMsg = ctx?.chat?.[ctx.chat.length - 1];
                if (lastMsg && !lastMsg.is_user && lastMsg?.usage?.prompt_tokens !== undefined) {
                    usage = lastMsg.usage;
                }
            } catch { /* ignore */ }
        }

        // 没找到 usage → 用户消息 → 跳过
        if (!usage) return;

        const duration = stats.genStartTime ? Date.now() - stats.genStartTime : 0;

        if (usage) {
            const pt = usage.prompt_tokens || usage.input_tokens || 0;
            const ct = usage.completion_tokens || usage.output_tokens || stats.streamingCount;

            // 支持 DeepSeek / Anthropic / OpenAI 三种缓存字段
            const ch = usage.prompt_cache_hit_tokens
                || usage.cache_read_input_tokens
                || (usage.prompt_tokens_details?.cached_tokens)
                || 0;
            const cm = usage.prompt_cache_miss_tokens !== undefined
                ? usage.prompt_cache_miss_tokens
                : Math.max(0, pt - ch);

            record(pt, ct, ch, cm, duration);
        }

        stats.streamingCount = 0;
        stats.genStartTime = 0;
        refresh();
    });

    // 切换对话时：保存当前对话数据 → 加载新对话数据
    eventSource.on(event_types.CHAT_CHANGED, () => {
        try {
            const ctx = getContext();
            const newChatId = ctx?.name2 || '';
            if (!newChatId || newChatId === _currentChatId) return;

            // 先保存当前对话的数据
            saveSession();

            // 切换到新对话
            _currentChatId = newChatId;

            // 加载新对话的历史数据
            resetStats();
            loadSession();

            refresh();
        } catch {
            // best-effort
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Analytics helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Overall cache efficiency score 0-100 */
function cacheEfficiencyScore() {
    const total = stats.totalCacheHit + stats.totalCacheMiss;
    return total > 0 ? Math.round((stats.totalCacheHit / total) * 100) : 0;
}

/** Average tokens per request */
function avgTokensPerRequest() {
    return stats.requests > 0
        ? Math.round((stats.totalPrompt + stats.totalCompletion) / stats.requests)
        : 0;
}

/** Average throughput (tokens/sec) from history */
function avgThroughput() {
    if (stats.history.length === 0) return 0;
    const valid = stats.history.filter(h => h.tps > 0);
    if (valid.length === 0) return 0;
    return Math.round(valid.reduce((s, h) => s + h.tps, 0) / valid.length);
}

/** Projected cost if we continue at current rate for N more messages */
function projectedCost(remainingMsgs = 50) {
    if (stats.requests === 0) return 0;
    const avgCostPerReq = stats.cost / stats.requests;
    return stats.cost + avgCostPerReq * remainingMsgs;
}

/** Cache efficiency label */
function effLabel(score) {
    if (score >= 80) return { text: '优秀', color: '#4caf50' };
    if (score >= 50) return { text: '良好', color: '#8bc34a' };
    if (score >= 30) return { text: '一般', color: '#ff9800' };
    return              { text: '较低', color: '#f44336' };
}

// ═══════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════

let root = null;
let dragging = false, dX = 0, dY = 0;

function $(sel) { return root?.querySelector(sel); }
function $$(sel) { return root?.querySelectorAll(sel); }

// 中文紧凑格式: 1.2万, 345.6万, 1.0亿
function fmt(n) {
    if (n === undefined || n === null || isNaN(n)) return '-';
    if (n >= 1_0000_0000) return (n / 1_0000_0000).toFixed(1) + '亿';
    if (n >= 1_0000)      return (n / 1_0000).toFixed(1) + '万';
    if (n >= 1000)        return n.toLocaleString();
    return String(Math.round(n));
}

// 人民币格式
function fmtCost(n) {
    if (n === undefined || n === null || isNaN(n)) return '¥0.0000';
    if (n >= 1)       return '¥' + n.toFixed(2);
    if (n >= 0.01)    return '¥' + n.toFixed(4);
    return '¥' + n.toFixed(6);
}

function render() {
    if (!root) return;
    const ctx = getContext();
    const generating = ctx?.generating ?? false;

    const lastTotal = stats.lastPrompt + stats.lastCompletion + stats.streamingCount;
    const sessionTotal = stats.totalPrompt + stats.totalCompletion + stats.streamingCount;
    const lastCacheRate = stats.lastPrompt > 0
        ? Math.round((stats.lastCacheHit / stats.lastPrompt) * 100)
        : null;
    const effScore = cacheEfficiencyScore();
    const eff = effLabel(effScore);
    const tps = avgThroughput();

    // Last request
    setText('tcm-prompt',      fmt(stats.lastPrompt));
    setText('tcm-completion',  fmt(stats.lastCompletion + stats.streamingCount));
    setText('tcm-total',       fmt(lastTotal));
    setText('tcm-tps',         stats.lastDuration > 0
        ? Math.round((stats.lastCompletion || stats.streamingCount) / (stats.lastDuration / 1000)) + ' tok/秒'
        : '-');

    // Cache
    setText('tcm-ch-hit',      fmt(stats.lastCacheHit));
    setText('tcm-ch-miss',     fmt(stats.lastCacheMiss));
    setText('tcm-ch-rate',     lastCacheRate !== null ? lastCacheRate + '%' : '-');
    setText('tcm-eff-score',   effScore);
    setText('tcm-eff-label',   eff.text);
    setEffColor(eff.color);

    // Session
    setText('tcm-ses-prompt',  fmt(stats.totalPrompt));
    setText('tcm-ses-compl',   fmt(stats.totalCompletion + stats.streamingCount));
    setText('tcm-ses-total',   fmt(sessionTotal));
    setText('tcm-ses-req',     stats.requests);
    setText('tcm-ses-avg',     fmt(avgTokensPerRequest()));
    setText('tcm-ses-tps',     tps > 0 ? tps + ' tok/秒' : '-');

    // Cost
    setText('tcm-cost',        fmtCost(stats.cost));
    setText('tcm-cost-proj',   fmtCost(projectedCost(50)));
    setText('tcm-model',       cfg.costModel);

    // Cache rate color
    const rateEl = $('#tcm-ch-rate');
    if (rateEl && lastCacheRate !== null) {
        rateEl.style.color = lastCacheRate >= 50 ? '#4caf50' : lastCacheRate >= 20 ? '#ff9800' : '#f44336';
    }

    // Efficiency bar
    const bar = $('#tcm-eff-bar-fill');
    if (bar) {
        bar.style.width = effScore + '%';
        bar.style.background = eff.color;
    }

    // Generating indicator
    const dot = $('#tcm-dot');
    if (dot) {
        dot.textContent = generating ? '🟢' : '⚪';
        dot.title = generating ? `生成中 (${stats.streamingCount} tokens, ${tps || '?'} tok/秒)...` : '空闲';
    }

    // Trend mini-chart
    drawTrend();
}

function setText(id, val) {
    const el = $(`#${id}`);
    if (el) el.textContent = val;
}

function setEffColor(color) {
    const scoreEl = $('#tcm-eff-score');
    const labelEl = $('#tcm-eff-label');
    if (scoreEl) scoreEl.style.color = color;
    if (labelEl) labelEl.style.color = color;
}

// ── Mini Trend Chart (CSS-based bar chart) ─────────────────────────────────

function drawTrend() {
    const container = $('#tcm-trend-bars');
    if (!container || !cfg.showTrend) return;

    const bars = container.querySelectorAll('.tcm-trend-bar');
    const hItems = stats.history.slice(0, bars.length).reverse();

    bars.forEach((bar, i) => {
        const item = hItems[i];
        if (item) {
            const max = Math.max(item.prompt, item.completion, 1);
            const pH = (item.prompt / max) * 100;
            const cH = (item.completion / max) * 100;
            bar.querySelector('.tcm-trend-p').style.height = pH + '%';
            bar.querySelector('.tcm-trend-c').style.height = cH + '%';
            bar.title = `Req #${stats.requests - hItems.length + i + 1}: P=${fmt(item.prompt)} C=${fmt(item.completion)} @ ${item.tps} tok/秒`;
            bar.style.opacity = '1';
        } else {
            bar.querySelector('.tcm-trend-p').style.height = '0%';
            bar.querySelector('.tcm-trend-c').style.height = '0%';
            bar.style.opacity = '0.4';
        }
    });
}

// ── Panel HTML ─────────────────────────────────────────────────────────────

const PANEL_HTML = /* html */ `
<div id="tcm-panel" class="tcm-panel${cfg.panelCollapsed ? ' tcm-collapsed' : ''}">
  <div class="tcm-head">
    <span class="tcm-head-left">
      <span id="tcm-dot" class="tcm-dot" title="空闲">⚪</span>
      <span class="tcm-title">🐋 Token 监控</span>
    </span>
    <span class="tcm-head-btns">
      <button class="tcm-btn" id="tcm-btn-toggle" title="折叠">${cfg.panelCollapsed ? '➕' : '➖'}</button>
      <button class="tcm-btn" id="tcm-btn-reset"  title="重置统计">↺</button>
      <button class="tcm-btn" id="tcm-btn-close"  title="关闭面板">✕</button>
    </span>
  </div>
  <div class="tcm-body"${cfg.panelCollapsed ? ' style="display:none"' : ''}>
    <!-- 本次请求 -->
    <div class="tcm-section">
      <div class="tcm-section-title">▼ 本次请求</div>
      <div class="tcm-row"><span>输入</span><span id="tcm-prompt">-</span></div>
      <div class="tcm-row"><span>输出</span><span id="tcm-completion">-</span></div>
      <div class="tcm-row"><span>合计</span><span id="tcm-total">-</span></div>
      <div class="tcm-row" id="tcm-tps-row"><span>速度</span><span id="tcm-tps">-</span></div>
    </div>

    <!-- 缓存信息 -->
    <div class="tcm-section" id="tcm-cache-section"${cfg.showCacheInfo ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ 缓存命中</div>
      <div class="tcm-row"><span>命中</span><span class="tcm-green" id="tcm-ch-hit">-</span></div>
      <div class="tcm-row"><span>未命中</span><span class="tcm-red" id="tcm-ch-miss">-</span></div>
      <div class="tcm-row"><span>命中率</span><span id="tcm-ch-rate">-</span></div>
      <div class="tcm-row" style="margin-top:4px">
        <span>效率评分</span>
        <span><span id="tcm-eff-score" style="font-weight:700">0</span> <span id="tcm-eff-label" style="font-size:10px">-</span></span>
      </div>
      <div class="tcm-eff-bar"><div class="tcm-eff-bar-fill" id="tcm-eff-bar-fill"></div></div>
    </div>

    <!-- 会话统计 -->
    <div class="tcm-section" id="tcm-session-section"${cfg.showSession ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ 会话统计</div>
      <div class="tcm-row"><span>输入</span><span id="tcm-ses-prompt">0</span></div>
      <div class="tcm-row"><span>输出</span><span id="tcm-ses-compl">0</span></div>
      <div class="tcm-row"><span>合计</span><span id="tcm-ses-total">0</span></div>
      <div class="tcm-row"><span>请求数</span><span id="tcm-ses-req">0</span></div>
      <div class="tcm-row"><span>平均/请求</span><span id="tcm-ses-avg">0</span></div>
      <div class="tcm-row"><span>平均速度</span><span id="tcm-ses-tps">-</span></div>
    </div>

    <!-- 费用 -->
    <div class="tcm-section" id="tcm-cost-section"${cfg.showCost ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ 费用 · <span id="tcm-model">-</span></div>
      <div class="tcm-row tcm-cost-row"><span>本次会话</span><span id="tcm-cost">¥0.0000</span></div>
      <div class="tcm-row tcm-cost-row"><span>预计 +50条</span><span id="tcm-cost-proj">¥0.0000</span></div>
    </div>

    <!-- 趋势图 -->
    <div class="tcm-section" id="tcm-trend-section"${cfg.showTrend ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ 趋势 (最近 ${MAX_HISTORY} 次)</div>
      <div class="tcm-trend-container">
        <div class="tcm-trend-bars" id="tcm-trend-bars">
          ${Array.from({length: MAX_HISTORY}, () => `
            <div class="tcm-trend-bar">
              <div class="tcm-trend-p" style="height:0%"></div>
              <div class="tcm-trend-c" style="height:0%"></div>
            </div>
          `).join('')}
        </div>
        <div class="tcm-trend-legend">
          <span><span class="tcm-legend-p"></span>输入</span>
          <span><span class="tcm-legend-c"></span>输出</span>
        </div>
      </div>
    </div>
  </div>
</div>`;

// ── Panel lifecycle ────────────────────────────────────────────────────────

function createUI() {
    if (root) root.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML;
    root = wrapper.firstElementChild;
    document.body.appendChild(root);
    position();
    bindUI();
    render();
}

function position() {
    if (!root) return;
    if (cfg.panelPosition.x !== null) {
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = cfg.panelPosition.x + 'px';
        root.style.top  = cfg.panelPosition.y + 'px';
    } else {
        root.style.left = 'auto';
        root.style.top  = 'auto';
        root.style.right = '12px';
        root.style.bottom = '90px';
    }
}

function bindUI() {
    $('#tcm-btn-toggle')?.addEventListener('click', toggle);
    $('#tcm-btn-reset')?.addEventListener('click', () => { resetStats(); clearSession(); refresh(); });
    $('#tcm-btn-close')?.addEventListener('click', () => {
        root.style.display = root.style.display === 'none' ? '' : 'none';
    });

    // Dragging
    const head = root.querySelector('.tcm-head');
    head?.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        const r = root.getBoundingClientRect();
        dX = e.clientX - r.left;
        dY = e.clientY - r.top;
        root.style.cursor = 'grabbing';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        cfg.panelPosition.x = e.clientX - dX;
        cfg.panelPosition.y = e.clientY - dY;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        root.style.left = cfg.panelPosition.x + 'px';
        root.style.top  = cfg.panelPosition.y + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        root.style.cursor = '';
        saveCfg();
    });

    // Double-click header to toggle
    head?.addEventListener('dblclick', toggle);
}

function toggle() {
    cfg.panelCollapsed = !cfg.panelCollapsed;
    saveCfg();
    const body = root.querySelector('.tcm-body');
    const btn  = $('#tcm-btn-toggle');
    if (cfg.panelCollapsed) {
        body.style.display = 'none';
        if (btn) btn.textContent = '➕';
        root.classList.add('tcm-collapsed');
    } else {
        body.style.display = '';
        if (btn) btn.textContent = '➖';
        root.classList.remove('tcm-collapsed');
    }
}

function resetStats() {
    stats.lastPrompt      = 0;
    stats.lastCompletion  = 0;
    stats.lastCacheHit    = 0;
    stats.lastCacheMiss   = 0;
    stats.lastTime        = 0;
    stats.lastDuration    = 0;
    stats.totalPrompt     = 0;
    stats.totalCompletion = 0;
    stats.totalCacheHit   = 0;
    stats.totalCacheMiss  = 0;
    stats.requests        = 0;
    stats.cost            = 0;
    stats.totalDuration   = 0;
    stats.streamingCount  = 0;
    stats.genStartTime    = 0;
    stats.history         = [];
}

function rebuild() {
    if (root) {
        const pos = cfg.panelPosition;
        const collapsed = cfg.panelCollapsed;
        root.remove();
        root = null;
        createUI();
        if (collapsed) toggle();
        if (pos.x !== null) {
            root.style.left = pos.x + 'px';
            root.style.top  = pos.y + 'px';
            root.style.right = 'auto';
            root.style.bottom = 'auto';
        }
    }
}

// ── Settings overlay ───────────────────────────────────────────────────────

function openSettings() {
    const overlay = document.createElement('div');
    overlay.className = 'tcm-overlay';
    overlay.innerHTML = /* html */ `
    <div class="tcm-settings-box">
      <h3>🐋 Token 监控设置</h3>
      <label><input type="checkbox" id="tcm-set-cache" ${cfg.showCacheInfo ? 'checked' : ''}> 显示缓存命中区域</label>
      <label><input type="checkbox" id="tcm-set-session" ${cfg.showSession ? 'checked' : ''}> 显示会话统计</label>
      <label><input type="checkbox" id="tcm-set-cost" ${cfg.showCost ? 'checked' : ''}> 显示费用估算</label>
      <label><input type="checkbox" id="tcm-set-tput" ${cfg.showThroughput ? 'checked' : ''}> 显示吞吐量 (tok/秒)</label>
      <label><input type="checkbox" id="tcm-set-trend" ${cfg.showTrend ? 'checked' : ''}> 显示迷你趋势图</label>
      <label>模型: <select id="tcm-set-model">
        <option value="deepseek-v4-pro" ${cfg.costModel === 'deepseek-v4-pro' ? 'selected' : ''}>DeepSeek V4 Pro</option>
        <option value="deepseek-v4-flash" ${cfg.costModel === 'deepseek-v4-flash' ? 'selected' : ''}>DeepSeek V4 Flash</option>
        <option value="deepseek-v3" ${cfg.costModel === 'deepseek-v3' ? 'selected' : ''}>DeepSeek V3</option>
        <option value="gpt-4o" ${cfg.costModel === 'gpt-4o' ? 'selected' : ''}>GPT-4o</option>
        <option value="claude-3.5-sonnet" ${cfg.costModel === 'claude-3.5-sonnet' ? 'selected' : ''}>Claude Sonnet 4</option>
        <option value="custom" ${cfg.costModel === 'custom' ? 'selected' : ''}>自定义</option>
      </select></label>
      <div id="tcm-custom-block" style="display:${cfg.costModel === 'custom' ? 'block' : 'none'}">
        <label>输入 ¥/百万: <input type="number" id="tcm-set-in"  value="${cfg.customPricing.input}" step="0.0001" min="0"></label>
        <label>缓存 ¥/百万: <input type="number" id="tcm-set-ch"  value="${cfg.customPricing.cacheHit}" step="0.0001" min="0"></label>
        <label>输出 ¥/百万: <input type="number" id="tcm-set-out" value="${cfg.customPricing.output}" step="0.0001" min="0"></label>
      </div>
      <div class="tcm-settings-actions">
        <button id="tcm-set-apply">应用</button>
        <button id="tcm-set-dismiss">关闭</button>
      </div>
    </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector('#tcm-set-model').addEventListener('change', function () {
        overlay.querySelector('#tcm-custom-block').style.display =
            this.value === 'custom' ? 'block' : 'none';
    });

    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('#tcm-set-dismiss').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#tcm-set-apply').addEventListener('click', () => {
        cfg.showCacheInfo  = overlay.querySelector('#tcm-set-cache').checked;
        cfg.showSession    = overlay.querySelector('#tcm-set-session').checked;
        cfg.showCost       = overlay.querySelector('#tcm-set-cost').checked;
        cfg.showThroughput = overlay.querySelector('#tcm-set-tput').checked;
        cfg.showTrend      = overlay.querySelector('#tcm-set-trend').checked;
        cfg.costModel      = overlay.querySelector('#tcm-set-model').value;
        if (cfg.costModel === 'custom') {
            cfg.customPricing.input    = +overlay.querySelector('#tcm-set-in').value || 0;
            cfg.customPricing.cacheHit = +overlay.querySelector('#tcm-set-ch').value || 0;
            cfg.customPricing.output   = +overlay.querySelector('#tcm-set-out').value || 0;
        }
        saveCfg();
        overlay.remove();
        rebuild();
    });
}

// ── Settings button in panel header ────────────────────────────────────────

function addSettingsButton() {
    const btn = document.createElement('button');
    btn.className = 'tcm-btn';
    btn.id = 'tcm-btn-settings';
    btn.textContent = '⚙';
    btn.title = '设置';
    btn.addEventListener('click', openSettings);
    const headBtns = root.querySelector('.tcm-head-btns');
    if (headBtns) headBtns.insertBefore(btn, headBtns.firstChild);
}

// ═══════════════════════════════════════════════════════════════════════════
// STscript command registration (if slash-commands are supported)
// ═══════════════════════════════════════════════════════════════════════════

function registerSlashCommands() {
    try {
        const ctx = getContext();
        if (typeof ctx.registerSlashCommand !== 'function') {
            console.log('[TokenCacheMonitor] STscript not available — use window.TokenCacheMonitor in console');
            return;
        }

        ctx.registerSlashCommand('token-stats', () => {
            const eff = cacheEfficiencyScore();
            const el = effLabel(eff);
            const tps = avgThroughput();
            const msg = [
                `🐋 **Token Monitor Stats**`,
                ``,
                `**会话统计:**`,
                `• 请求数: ${stats.requests}`,
                `• 输入 tokens: ${fmt(stats.totalPrompt)}`,
                `• 输出 tokens: ${fmt(stats.totalCompletion)}`,
                `• 合计 tokens: ${fmt(stats.totalPrompt + stats.totalCompletion)}`,
                `• 平均/请求: ${fmt(avgTokensPerRequest())}`,
                ``,
                `**缓存命中:**`,
                `• 命中: ${fmt(stats.totalCacheHit)} | 未命中: ${fmt(stats.totalCacheMiss)}`,
                `• 效率: ${eff}% (${el.text})`,
                ``,
                `**性能:**`,
                `• 平均速度: ${tps} tok/秒`,
                `• 总生成时间: ${(stats.totalDuration / 1000).toFixed(1)}s`,
                ``,
                `**费用:**`,
                `• 本次会话: ${fmtCost(stats.cost)}`,
                `• 预计 (+50条): ${fmtCost(projectedCost(50))}`,
            ].join('\n');

            if (typeof ctx.sendSystemMessage === 'function') {
                ctx.sendSystemMessage(msg);
            } else {
                try { toastr.info(msg.replace(/\*\*/g, ''), 'Token Stats', { timeOut: 8000 }); } catch { console.log(msg); }
            }
        }, { description: '显示 token 统计摘要' });

        ctx.registerSlashCommand('token-reset', () => {
            resetStats();
            clearSession();
            refresh();
            const doneMsg = '✅ Token 统计已重置。';
            if (typeof ctx.sendSystemMessage === 'function') {
                ctx.sendSystemMessage(doneMsg);
            } else {
                try { toastr.success(doneMsg, 'Token Monitor'); } catch { console.log(doneMsg); }
            }
        }, { description: '重置所有 token 统计' });

    } catch { /* STscript not available — non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════

function refresh() { render(); }

function init() {
    loadCfg();
    // 初始化当前对话 ID
    try { _currentChatId = getContext()?.name2 || 'default'; } catch { _currentChatId = 'default'; }
    loadSession();
    hookEvents();
    createUI();
    addSettingsButton();
    registerSlashCommands();
    console.log('[Token监控] 🐋 已就绪 v3.2.1'
        + ` | 模型: ${cfg.costModel} | 缓存: ${cfg.showCacheInfo ? '开' : '关'}`
        + ` | MESSAGE_RECEIVED: ${!!event_types.MESSAGE_RECEIVED}`
        + ` | generateRawData: ${typeof getContext().generateRawData}`
        + ` | 对话: ${_currentChatId || '(未初始化)'}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for console debugging & STscript
window.TokenCacheMonitor = {
    stats,
    cfg,
    reset: resetStats,
    refresh,
    getReport: () => ({
        sessionRequests: stats.requests,
        totalTokens: stats.totalPrompt + stats.totalCompletion,
        totalCost: stats.cost,
        cacheEfficiency: cacheEfficiencyScore(),
        avgThroughput: avgThroughput(),
    }),
};
