/**
 * server-patch.js — DeepSeek Cache Info Passthrough for SillyTavern  v2.0.0
 * ==========================================================================
 *
 * SillyTavern 的 Node.js 服务端代理了对话补全请求到 DeepSeek API。
 * 某些 ST 版本在解析和重新序列化上游响应时，可能会丢弃 `usage` 对象中的
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 字段，
 * 导致前端 Token Monitor 无法获取缓存命中数据。
 *
 * 本补丁通过 monkey-patch `http.request` / `https.request` 来拦截原始
 * DeepSeek API 响应，提取完整 `usage` 对象，使其能被 ST 处理器转发到
 * 浏览器端的 Token & Cache Monitor 扩展。
 *
 * ── 安装方式 ──────────────────────────────────────────────────────────────
 *
 * 【方式一】作为 Express 中间件（推荐，无需修改 server.js）：
 *   在 server.js 中找到 `const app = express();` 之后添加：
 *
 *     app.use(require('./server-patch.js').middleware);
 *
 * 【方式二】全局拦截模式：
 *   将本文件复制到 SillyTavern 根目录（与 server.js 同级），
 *   在 server.js 开头添加：
 *
 *     require('./server-patch.js');
 *
 * 【方式三】仅导出一个辅助函数（不需要修补时）：
 *   在你的 ST API 处理器中：
 *
 *     const { mergeUsage } = require('./server-patch.js');
 *     res.json(mergeUsage(apiResponseBody, req));
 *
 * ── 工作原理 ──────────────────────────────────────────────────────────────
 *
 * 补丁拦截所有从 ST 服务器发出的 HTTP(S) 请求。当请求匹配已知的 AI API
 * 端点（DeepSeek、OpenAI 等）时，它会：
 *   1. 收集响应体（chunk by chunk）
 *   2. 解析 JSON 并提取 `usage` 对象
 *   3. 将 `__ds_usage` 附加到请求对象上
 *   4. 同时维护一个全局 `__ds_pending_usage` 队列（最近 10 条）
 *
 * 前端 Token Monitor 通过 fetch() 拦截捕获 usage 数据。
 * 如果 ST 处理器已保留 usage，则无需本补丁。本文件作为安全网，
 * 确保 DeepSeek 的缓存命中字段不会在服务端丢失。
 *
 * ── 兼容性 ────────────────────────────────────────────────────────────────
 *
 * - SillyTavern 1.12.x+
 * - DeepSeek API (api.deepseek.com)
 * - OpenAI API (api.openai.com)
 * - Anthropic API (api.anthropic.com)
 * - Google Gemini API (generativelanguage.googleapis.com)
 */

'use strict';

const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const AI_HOSTS = [
    'api.deepseek.com',
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
];

/** Usage fields we explicitly preserve.
 *  Especially important for DeepSeek: prompt_cache_hit_tokens,
 *  prompt_cache_miss_tokens, prompt_cache_write_tokens */
const USAGE_FIELDS = [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'prompt_cache_write_tokens',
    'completion_tokens_details',
    'prompt_tokens_details',
    // Anthropic fields
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    // Gemini fields
    'promptTokenCount',
    'candidatesTokenCount',
    'totalTokenCount',
];

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function hostMatches(urlOrOpts) {
    if (!urlOrOpts) return false;
    const s = typeof urlOrOpts === 'string'
        ? urlOrOpts
        : (urlOrOpts.href || urlOrOpts.host || urlOrOpts.hostname || '');
    return AI_HOSTS.some(h => s.includes(h));
}

/**
 * Extract a clean usage object from the raw API response body.
 * Only includes known fields to avoid leaking extra data.
 */
function stripUsage(rawBody) {
    try {
        const data = typeof rawBody === 'string'
            ? JSON.parse(rawBody)
            : rawBody;
        if (!data?.usage && !data?.usageMetadata) return null;

        // DeepSeek/OpenAI format
        let src = data.usage;
        // Gemini format
        if (!src && data.usageMetadata) {
            src = {
                prompt_tokens: data.usageMetadata.promptTokenCount,
                completion_tokens: data.usageMetadata.candidatesTokenCount,
                total_tokens: data.usageMetadata.totalTokenCount,
            };
        }
        if (!src) return null;

        const usage = {};
        for (const key of USAGE_FIELDS) {
            if (src[key] !== undefined) {
                usage[key] = src[key];
            }
        }

        // Special handling: if prompt_cache_hit_tokens is present but
        // prompt_cache_miss_tokens is not, compute miss = prompt - hit
        if (usage.prompt_cache_hit_tokens !== undefined &&
            usage.prompt_cache_miss_tokens === undefined &&
            usage.prompt_tokens !== undefined) {
            usage.prompt_cache_miss_tokens = Math.max(0,
                usage.prompt_tokens - usage.prompt_cache_hit_tokens);
        }

        return Object.keys(usage).length > 0 ? usage : null;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Patch one request module
// ═══════════════════════════════════════════════════════════════════════════

function patch(mod) {
    const original = mod.request;

    mod.request = function (...args) {
        const url = typeof args[0] === 'string'
            ? args[0]
            : (args[0]?.href || args[0]?.host || args[0]?.hostname || '');

        if (!hostMatches(url)) {
            return original.apply(this, args);
        }

        const req = original.apply(this, args);
        const chunks = [];

        // Capture response body
        req.on('response', function (res) {
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    const usage = stripUsage(body);
                    if (usage) {
                        // Attach to request object
                        req.__ds_usage = usage;

                        // Maintain global pending queue (FIFO, max 10)
                        if (!global.__ds_pending_usage) {
                            global.__ds_pending_usage = [];
                        }
                        global.__ds_pending_usage.push({
                            time: Date.now(),
                            usage,
                            url,
                        });
                        if (global.__ds_pending_usage.length > 10) {
                            global.__ds_pending_usage.shift();
                        }
                    }
                } catch { /* ignore parse errors */ }
            });
        });

        // Handle request errors gracefully
        req.on('error', () => { /* silently ignore — ST will handle the error */ });

        return req;
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Apply patches
// ═══════════════════════════════════════════════════════════════════════════

patch(http);
patch(https);

console.log('[server-patch v2] 🐋 DeepSeek cache passthrough enabled. AI hosts:', AI_HOSTS.join(', '));

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Merge captured usage data into a response body.
 * Use this in your ST API handlers to enrich responses with cache info.
 *
 * @param {object} body - The response body being sent back to the browser
 * @param {object} [req] - The Express request object (optional)
 * @returns {object} - Enriched body
 */
function mergeUsage(body, req) {
    if (!body) return body;

    // Already has cache fields — nothing to do
    if (body.usage?.prompt_cache_hit_tokens !== undefined) return body;

    // Try the request-scoped usage (most reliable)
    if (req?.__ds_usage) {
        body.usage = { ...(body.usage || {}), ...req.__ds_usage };
        return body;
    }

    // Try global pending queue (match within last 10 seconds)
    const pending = global.__ds_pending_usage || [];
    const now = Date.now();
    const recent = pending.find(p => (now - p.time) < 10000);
    if (recent) {
        body.usage = { ...(body.usage || {}), ...recent.usage };
    }

    return body;
}

/**
 * Express middleware — overrides res.json to inject usage into
 * chat completion responses automatically.
 *
 * Usage: app.use(require('./server-patch.js').middleware);
 */
function middleware(req, res, next) {
    // Only intercept AI API proxy paths
    const isAiPath = req.path &&
        (req.path.includes('chat-completions') ||
         req.path.includes('completions') ||
         req.path.includes('generate') ||
         req.path.includes('messages'));

    if (!isAiPath) return next();

    const origJson = res.json.bind(res);
    res.json = function (body) {
        const enriched = mergeUsage(body, req);
        return origJson(enriched);
    };

    next();
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    mergeUsage,
    middleware,
    // Direct access for debugging
    get pending() { return global.__ds_pending_usage || []; },
};

// ── Legacy compatibility ───────────────────────────────────────────────────

// Also patch global so require('./server-patch') in server.js works
// without needing to assign to a variable
if (!global.__ds_patch_applied) {
    global.__ds_patch_applied = true;
}
