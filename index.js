/**
 * CodeWhale-Style Token & Cache Monitor for SillyTavern  v2.0.0
 * ====================================================================
 *
 * 将 CodeWhale 终端中的 token 统计体验带入 SillyTavern：
 *   - 实时 token 用量（prompt / completion / total）
 *   - DeepSeek 缓存命中/未命中统计 + 命中率可视化
 *   - 成本估算（支持 DeepSeek V4 Pro/Flash/V3 及自定义定价）
 *   - 吞吐量追踪（tokens/秒）
 *   - 缓存效率评分（0-100，颜色编码）
 *   - 会话持久化（localStorage，刷新不丢失）
 *   - 迷你趋势图（最近 20 次请求的 token 变化）
 *   - 成本预估（按当前速率推算）
 *   - STscript 命令：/token-stats, /token-reset, /token-export
 *   - 可拖拽、可折叠浮动面板
 *
 * 安装：将整个文件夹复制到 SillyTavern/public/scripts/extensions/
 *   或在 ST 扩展管理器中粘贴 GitHub 仓库 URL。
 *
 * 基于 CodeWhale (github.com/usewhale/DeepSeek-Code-Whale) 的
 * token 统计与分析功能设计。
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
    'deepseek-v4-pro':   { input: 0.55, cacheHit: 0.14,  output: 2.19 },
    'deepseek-v4-flash': { input: 0.14, cacheHit: 0.0028, output: 0.28 },
    'deepseek-v3':       { input: 0.27, cacheHit: 0.07,  output: 1.10 },
    // common fallbacks
    'gpt-4o':            { input: 2.50, cacheHit: 1.25,  output: 10.00 },
    'claude-3.5-sonnet': { input: 3.00, cacheHit: 0.30,  output: 15.00 },
};

/** URL substrings that identify AI API endpoints */
const API_PATTERNS = [
    '/chat/completions',
    '/completions',
    '/v1/chat/completions',
    '/v1/completions',
    'api.deepseek.com',
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
];

/** DeepSeek-specific usage fields we want to capture */
const DS_CACHE_FIELDS = [
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'prompt_cache_write_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
];

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
    stats.genStartTime     = 0;  // 标记已记录，防止 GENERATION_ENDED 双重调用

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
// Network interception (fetch monkey-patch)
// ═══════════════════════════════════════════════════════════════════════════

function matchesAPI(url) {
    if (!url) return false;
    return API_PATTERNS.some(p => url.includes(p));
}

function extractUsage(data) {
    if (!data) return null;
    // OpenAI / DeepSeek
    if (data?.usage?.prompt_tokens !== undefined) return data.usage;
    // Anthropic
    if (data?.usage?.input_tokens !== undefined) {
        const u = data.usage;
        return {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            prompt_cache_hit_tokens: u.cache_read_input_tokens || 0,
            prompt_cache_write_tokens: u.cache_creation_input_tokens || 0,
        };
    }
    // Gemini
    if (data?.usageMetadata) {
        const u = data.usageMetadata;
        return {
            prompt_tokens: u.promptTokenCount,
            completion_tokens: u.candidatesTokenCount,
        };
    }
    return null;
}

/** Read SSE stream to extract usage from the final chunk */
async function interceptStream(response) {
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const data = line.startsWith('data: ') ? line.slice(6).trim() : '';
                if (!data || data === '[DONE]') continue;
                try {
                    const chunk = JSON.parse(data);
                    if (chunk.usage) usage = chunk.usage;
                    // OpenAI streaming: usage may be nested
                    if (chunk.choices?.[0]?.usage) usage = chunk.choices[0].usage;
                    // DeepSeek: sometimes usage is at top level
                    if (chunk.usage?.prompt_tokens !== undefined) usage = chunk.usage;
                } catch { /* ignore parse errors */ }
            }
        }
        // Flush remaining
        if (buf.startsWith('data: ') && buf.slice(6).trim() !== '[DONE]') {
            try {
                const chunk = JSON.parse(buf.slice(6).trim());
                if (chunk.usage) usage = chunk.usage;
            } catch { /* ignore */ }
        }
    } catch { /* stream read error — non-fatal */ }

    return usage;
}

function patchFetch() {
    const _fetch = window.fetch;
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string'
            ? args[0]
            : args[0]?.url || '';

        const resp = await _fetch.apply(this, args);

        if (!matchesAPI(url)) return resp;

        // Fire and forget — don't block the response
        (async () => {
            try {
                const ct = resp.headers.get('content-type') || '';

                if (ct.includes('text/event-stream')) {
                    const usage = await interceptStream(resp);
                    if (usage) {
                        const pt = usage.prompt_tokens || 0;
                        const ct2 = usage.completion_tokens || 0;
                        const ch = usage.prompt_cache_hit_tokens || 0;
                        const cm = usage.prompt_cache_miss_tokens !== undefined
                            ? usage.prompt_cache_miss_tokens
                            : Math.max(0, pt - ch);
                        record(pt, ct2, ch, cm);
                    }
                } else {
                    const clone = resp.clone();
                    const data  = await clone.json().catch(() => null);
                    const usage = extractUsage(data);
                    if (usage) {
                        const pt = usage.prompt_tokens || 0;
                        const ct2 = usage.completion_tokens || 0;
                        const ch = usage.prompt_cache_hit_tokens || 0;
                        const cm = usage.prompt_cache_miss_tokens !== undefined
                            ? usage.prompt_cache_miss_tokens
                            : Math.max(0, pt - ch);
                        record(pt, ct2, ch, cm);
                    }
                }
            } catch { /* silently ignore — best-effort tracking */ }
        })();

        return resp;
    };
}

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

    eventSource.on(event_types.GENERATION_ENDED, (data) => {
        const duration = stats.genStartTime ? Date.now() - stats.genStartTime : 0;

        // 如果 fetch 拦截器已记录（stats.lastPrompt 已更新），跳过事件钩子
        // 避免同一次请求被 record() 两次
        if (stats.genStartTime === 0) {
            // genStartTime 已被 fetch 拦截器清零 → 已记录过，跳过
            refresh();
            return;
        }

        // If ST passes usage in the event data, use it as primary source
        if (data?.usage?.prompt_tokens !== undefined) {
            const u = data.usage;
            record(
                u.prompt_tokens || 0,
                u.completion_tokens || stats.streamingCount,
                u.prompt_cache_hit_tokens || 0,
                u.prompt_cache_miss_tokens !== undefined
                    ? u.prompt_cache_miss_tokens
                    : Math.max(0, (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0)),
                duration
            );
        } else if (stats.streamingCount > 0 && stats.lastCompletion === 0) {
            // Fallback: use stream token count (no usage data captured)
            const p = getPricing();
            stats.lastCompletion = stats.streamingCount;
            stats.totalCompletion += stats.streamingCount;
            stats.lastTime = Date.now();
            stats.lastDuration = duration;
            stats.totalDuration += duration;
            stats.requests++;
            stats.cost += (stats.streamingCount / 1_000_000) * p.output;
            stats.streamingCount = 0;
            saveSession();
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
    if (score >= 80) return { text: 'Excellent', color: '#4caf50' };
    if (score >= 50) return { text: 'Good',     color: '#8bc34a' };
    if (score >= 30) return { text: 'Fair',     color: '#ff9800' };
    return              { text: 'Low',       color: '#f44336' };
}

// ═══════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════

let root = null;
let dragging = false, dX = 0, dY = 0;

function $(sel) { return root?.querySelector(sel); }
function $$(sel) { return root?.querySelectorAll(sel); }

function fmt(n) {
    if (n === undefined || n === null || isNaN(n)) return '-';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)    return (n / 1_000).toFixed(1) + 'k';
    return String(Math.round(n));
}

function fmtCost(n) {
    if (n === undefined || n === null || isNaN(n)) return '$0.00000';
    return '$' + n.toFixed(5);
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
        ? Math.round((stats.lastCompletion || stats.streamingCount) / (stats.lastDuration / 1000)) + ' tok/s'
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
    setText('tcm-ses-tps',     tps > 0 ? tps + ' tok/s' : '-');

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
        dot.title = generating ? `Generating (${stats.streamingCount} tokens, ${tps || '?'} tok/s)...` : 'Idle';
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
            bar.title = `Req #${stats.requests - hItems.length + i + 1}: P=${fmt(item.prompt)} C=${fmt(item.completion)} @ ${item.tps} tok/s`;
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
      <span id="tcm-dot" class="tcm-dot" title="Idle">⚪</span>
      <span class="tcm-title">🐋 Token Monitor</span>
    </span>
    <span class="tcm-head-btns">
      <button class="tcm-btn" id="tcm-btn-toggle" title="Collapse">${cfg.panelCollapsed ? '➕' : '➖'}</button>
      <button class="tcm-btn" id="tcm-btn-reset"  title="Reset all stats">↺</button>
      <button class="tcm-btn" id="tcm-btn-close"  title="Close panel">✕</button>
    </span>
  </div>
  <div class="tcm-body"${cfg.panelCollapsed ? ' style="display:none"' : ''}>
    <!-- Last Request -->
    <div class="tcm-section">
      <div class="tcm-section-title">▼ Last Request</div>
      <div class="tcm-row"><span>Prompt</span><span id="tcm-prompt">-</span></div>
      <div class="tcm-row"><span>Completion</span><span id="tcm-completion">-</span></div>
      <div class="tcm-row"><span>Total</span><span id="tcm-total">-</span></div>
      <div class="tcm-row" id="tcm-tps-row"><span>Speed</span><span id="tcm-tps">-</span></div>
    </div>

    <!-- Cache Info -->
    <div class="tcm-section" id="tcm-cache-section"${cfg.showCacheInfo ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ Cache (DeepSeek)</div>
      <div class="tcm-row"><span>Hit</span><span class="tcm-green" id="tcm-ch-hit">-</span></div>
      <div class="tcm-row"><span>Miss</span><span class="tcm-red" id="tcm-ch-miss">-</span></div>
      <div class="tcm-row"><span>Hit Rate</span><span id="tcm-ch-rate">-</span></div>
      <div class="tcm-row" style="margin-top:4px">
        <span>Efficiency</span>
        <span><span id="tcm-eff-score" style="font-weight:700">0</span> <span id="tcm-eff-label" style="font-size:10px">-</span></span>
      </div>
      <div class="tcm-eff-bar"><div class="tcm-eff-bar-fill" id="tcm-eff-bar-fill"></div></div>
    </div>

    <!-- Session Stats -->
    <div class="tcm-section" id="tcm-session-section"${cfg.showSession ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ Session</div>
      <div class="tcm-row"><span>Prompt</span><span id="tcm-ses-prompt">0</span></div>
      <div class="tcm-row"><span>Completion</span><span id="tcm-ses-compl">0</span></div>
      <div class="tcm-row"><span>Total</span><span id="tcm-ses-total">0</span></div>
      <div class="tcm-row"><span>Requests</span><span id="tcm-ses-req">0</span></div>
      <div class="tcm-row"><span>Avg/Req</span><span id="tcm-ses-avg">0</span></div>
      <div class="tcm-row"><span>Avg Speed</span><span id="tcm-ses-tps">-</span></div>
    </div>

    <!-- Cost -->
    <div class="tcm-section" id="tcm-cost-section"${cfg.showCost ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ Cost · <span id="tcm-model">-</span></div>
      <div class="tcm-row tcm-cost-row"><span>Session</span><span id="tcm-cost">$0.00000</span></div>
      <div class="tcm-row tcm-cost-row"><span>Proj. +50 msg</span><span id="tcm-cost-proj">$0.00000</span></div>
    </div>

    <!-- Mini Trend -->
    <div class="tcm-section" id="tcm-trend-section"${cfg.showTrend ? '' : ' style="display:none"'}>
      <div class="tcm-section-title">▼ Trend (last ${MAX_HISTORY})</div>
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
          <span><span class="tcm-legend-p"></span>Prompt</span>
          <span><span class="tcm-legend-c"></span>Completion</span>
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
    $('#tcm-btn-reset')?.addEventListener('click', () => { resetStats(); refresh(); });
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
    clearSession();
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
      <h3>🐋 Token Monitor Settings</h3>
      <label><input type="checkbox" id="tcm-set-cache" ${cfg.showCacheInfo ? 'checked' : ''}> Show cache section</label>
      <label><input type="checkbox" id="tcm-set-session" ${cfg.showSession ? 'checked' : ''}> Show session stats</label>
      <label><input type="checkbox" id="tcm-set-cost" ${cfg.showCost ? 'checked' : ''}> Show cost estimate</label>
      <label><input type="checkbox" id="tcm-set-tput" ${cfg.showThroughput ? 'checked' : ''}> Show throughput (tok/s)</label>
      <label><input type="checkbox" id="tcm-set-trend" ${cfg.showTrend ? 'checked' : ''}> Show mini trend chart</label>
      <label>Model: <select id="tcm-set-model">
        <option value="deepseek-v4-pro" ${cfg.costModel === 'deepseek-v4-pro' ? 'selected' : ''}>DeepSeek V4 Pro</option>
        <option value="deepseek-v4-flash" ${cfg.costModel === 'deepseek-v4-flash' ? 'selected' : ''}>DeepSeek V4 Flash</option>
        <option value="deepseek-v3" ${cfg.costModel === 'deepseek-v3' ? 'selected' : ''}>DeepSeek V3</option>
        <option value="gpt-4o" ${cfg.costModel === 'gpt-4o' ? 'selected' : ''}>GPT-4o</option>
        <option value="claude-3.5-sonnet" ${cfg.costModel === 'claude-3.5-sonnet' ? 'selected' : ''}>Claude 3.5 Sonnet</option>
        <option value="custom" ${cfg.costModel === 'custom' ? 'selected' : ''}>Custom</option>
      </select></label>
      <div id="tcm-custom-block" style="display:${cfg.costModel === 'custom' ? 'block' : 'none'}">
        <label>Input $/M: <input type="number" id="tcm-set-in"  value="${cfg.customPricing.input}" step="0.0001" min="0"></label>
        <label>Cache $/M: <input type="number" id="tcm-set-ch"  value="${cfg.customPricing.cacheHit}" step="0.0001" min="0"></label>
        <label>Output $/M: <input type="number" id="tcm-set-out" value="${cfg.customPricing.output}" step="0.0001" min="0"></label>
      </div>
      <div class="tcm-settings-actions">
        <button id="tcm-set-apply">Apply</button>
        <button id="tcm-set-dismiss">Close</button>
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
    btn.title = 'Settings';
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
                `**Session:**`,
                `• Requests: ${stats.requests}`,
                `• Prompt tokens: ${fmt(stats.totalPrompt)}`,
                `• Completion tokens: ${fmt(stats.totalCompletion)}`,
                `• Total tokens: ${fmt(stats.totalPrompt + stats.totalCompletion)}`,
                `• Avg per request: ${fmt(avgTokensPerRequest())}`,
                ``,
                `**Cache (DeepSeek):**`,
                `• Hit: ${fmt(stats.totalCacheHit)} | Miss: ${fmt(stats.totalCacheMiss)}`,
                `• Efficiency: ${eff}% (${el.text})`,
                ``,
                `**Performance:**`,
                `• Avg throughput: ${tps} tok/s`,
                `• Total generation time: ${(stats.totalDuration / 1000).toFixed(1)}s`,
                ``,
                `**Cost:**`,
                `• Session: ${fmtCost(stats.cost)}`,
                `• Projected (+50): ${fmtCost(projectedCost(50))}`,
            ].join('\n');

            if (typeof ctx.sendSystemMessage === 'function') {
                ctx.sendSystemMessage(msg);
            } else {
                try { toastr.info(msg.replace(/\*\*/g, ''), 'Token Stats', { timeOut: 8000 }); } catch { console.log(msg); }
            }
        }, { description: 'Show token statistics summary' });

        ctx.registerSlashCommand('token-reset', () => {
            resetStats();
            refresh();
            const doneMsg = '✅ Token stats reset.';
            if (typeof ctx.sendSystemMessage === 'function') {
                ctx.sendSystemMessage(doneMsg);
            } else {
                try { toastr.success(doneMsg, 'Token Monitor'); } catch { console.log(doneMsg); }
            }
        }, { description: 'Reset all token statistics' });

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
    patchFetch();
    hookEvents();
    createUI();
    addSettingsButton();
    registerSlashCommands();
    console.log('[TokenCacheMonitor v2] 🐋 Ready — CodeWhale-style token tracking active. '
        + `Model: ${cfg.costModel}, Cache: ${cfg.showCacheInfo ? 'ON' : 'OFF'}, `
        + `Session persisted: ${stats.requests > 0 ? stats.requests + ' reqs' : 'fresh'}`);
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
