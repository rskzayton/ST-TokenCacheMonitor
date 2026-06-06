# 更新日志 (Changelog)

## v3.2.0 (2026-06-06)

### 修复
- **缓存命中数据源修复**：`generateRawData()` 提到数据源第一位。ST 服务端代理在存储 `lastMessage.usage` 时会标准化过滤，丢弃 DeepSeek 特有的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 字段。`generateRawData()` 返回完整原始 API 响应，不受此影响。
- `MESSAGE_RECEIVED` 事件处理：用户消息触发时不再错误清零 `genStartTime`，仅 AI 消息且携带 usage 时进入 record 流程。

### 移除
- 完全移除无效的 `window.fetch` 拦截器（ST 走服务端代理，浏览器端 fetch 看不到 API 请求）。
- 清理无用常量 `API_PATTERNS`、`DS_CACHE_FIELDS`。

## v3.1.0 (2026-06-06)

### 变更
- 数据源从 `GENERATION_ENDED` 切换到 `MESSAGE_RECEIVED` + `lastMessage.usage`。

## v3.0.0 (2026-06-06)

### 新增
- 界面全面中文化（面板、设置、提示、slash 指令）。
- 人民币（¥）计价表替代 USD，支持 8 款模型定价。
- 中文紧凑数字格式（1.2万 / 1.0亿）。
- 缓存效率评分中文标签（优秀/良好/一般/较低）。
- 模型选择更新为当前支持的最新模型。

## v2.0.x (2026-06-05)

### 修复
- 修复 `import` 路径错误（separate `../../../../script.js` + `../../../extensions.js`）。
- 修复 6 处 `$(...)` 缺少 `#` 前缀的 DOM 查询 bug。
- 修复 `generateRawData()` 缺 `await` 导致的异步 bug。
- 修复 `CHAT_CHANGED` 事件误判对话切换（ST 不存在 `chatId`，改用 `name2`）。
- 修复每个对话独立存储（localStorage key 基于角色名）。

### 新增
- 每个对话独立存储统计，切换角色自动保存/恢复。
- `auto_update: true`，ST 内可直接更新。
- 多数据源回退：`lastMessage.usage` → `getChatCompletionUsage()` → `generateRawData()`。
