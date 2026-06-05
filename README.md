# 🐋 CodeWhale 风格 Token 统计与分析 — SillyTavern 扩展

> 将 [CodeWhale](https://github.com/usewhale/DeepSeek-Code-Whale) 终端中的 token 统计体验带入 SillyTavern。

实时监控对话 token 用量、DeepSeek 缓存命中/未命中率、成本估算、吞吐量追踪与趋势分析 —— 全部在一个可拖拽的浮动面板中。

---

## ✨ 功能

| 功能 | 说明 |
|------|------|
| 📊 **实时 Token 用量** | Prompt / Completion / Total 实时显示 |
| 🎯 **缓存命中分析** | DeepSeek 专用：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 精确统计 |
| 📈 **缓存效率评分** | 0-100 分，颜色编码（绿=优秀，黄=一般，红=低效） |
| 💰 **成本估算** | 支持 DeepSeek V4 Pro/Flash/V3、GPT-4o、Claude 3.5 Sonnet 及自定义定价 |
| ⚡ **吞吐量追踪** | 每秒 tokens 数（tok/s），含平均值 |
| 📉 **迷你趋势图** | 最近 20 次请求的 token 变化柱状图 |
| 🔮 **成本预估** | 基于当前速率推算后续 50 条消息的成本 |
| 💾 **会话持久化** | localStorage 保存，刷新页面不丢失统计数据 |
| ⌨️ **STscript 命令** | `/token-stats` 查看摘要，`/token-reset` 重置统计 |
| 🖱️ **可拖拽面板** | 拖拽、折叠、关闭自由控制 |

---

## 📦 安装

### 方式一：GitHub URL 安装（推荐）

1. 打开 SillyTavern，进入 **Extensions** 面板。
2. 点击 **Install Extension**，粘贴以下 URL：
   ```
   https://github.com/rskzayton/SillyTavern-TokenCacheMonitor-
   ```
3. 在扩展列表中启用 **"CodeWhale 风格 Token 统计与分析"**。
4. 刷新页面，右下角即可看到 🐋 浮动面板。

> 自动从 GitHub 拉取最新版本，后续更新只需在 ST 中点击 Update 即可。

### 方式二：复制文件夹

1. 将整个 `SillyTavern-TokenCacheMonitor` 文件夹复制到：
   ```
   SillyTavern/public/scripts/extensions/
   ```

2. 重启 SillyTavern（或刷新页面）。

3. 在 Extensions 面板中启用 **"CodeWhale 风格 Token 统计与分析"**。

### 可选：服务端补丁（DeepSeek 缓存字段透传）

如果发现缓存命中数据始终为 0，可能是 ST 服务端丢弃了 `prompt_cache_hit_tokens` 字段。安装 `server-patch.js`：

```bash
# 1. 将 server-patch.js 复制到 SillyTavern 根目录
cp server-patch.js /path/to/SillyTavern/

# 2. 编辑 server.js，在 `const app = express();` 后添加：
#    app.use(require('./server-patch.js').middleware);

# 3. 重启 SillyTavern
```

> **注意**：大多数情况下 **不需要** 服务端补丁。前端通过 `fetch()` 拦截已足够捕获 API 响应中的 usage 数据。只有在 ST 版本主动丢弃缓存字段时才需要。

---

## 🎮 使用

### 面板操作

- **拖拽** — 按住标题栏拖动面板到你喜欢的位置
- **双击标题栏** — 折叠/展开面板
- **⚙ 按钮** — 打开设置
- **↺ 按钮** — 重置所有统计
- **✕ 按钮** — 隐藏面板（再次点击显示）

### STscript 命令

在聊天输入框中输入：

| 命令 | 作用 |
|------|------|
| `/token-stats` | 显示完整 token 统计摘要 |
| `/token-reset` | 重置所有统计数据 |

### 浏览器控制台

```javascript
// 查看实时统计
TokenCacheMonitor.stats

// 获取报告
TokenCacheMonitor.getReport()
// → { sessionRequests, totalTokens, totalCost, cacheEfficiency, avgThroughput }

// 重置统计
TokenCacheMonitor.reset()
```

---

## 🔧 设置

点击面板上的 ⚙ 按钮打开设置：

| 设置项 | 说明 |
|--------|------|
| **Show cache section** | 显示/隐藏 DeepSeek 缓存命中区域 |
| **Show session stats** | 显示/隐藏会话统计 |
| **Show cost estimate** | 显示/隐藏成本估算 |
| **Show throughput** | 显示/隐藏吞吐量指标 |
| **Show mini trend chart** | 显示/隐藏迷你趋势图 |
| **Model** | 选择定价模型（影响成本计算） |
| **Custom pricing** | 当选择 "Custom" 时，手动设置 Input/Cache/Output 每百万 token 价格（USD） |

---

## 💲 默认定价（2026-06，USD/百万 tokens）

| 模型 | Input | Cache Hit | Output |
|------|-------|-----------|--------|
| **DeepSeek V4 Pro** | $0.55 | $0.14 | $2.19 |
| **DeepSeek V4 Flash** | $0.14 | $0.0028 | $0.28 |
| **DeepSeek V3** | $0.27 | $0.07 | $1.10 |
| GPT-4o | $2.50 | $1.25 | $10.00 |
| Claude 3.5 Sonnet | $3.00 | $0.30 | $15.00 |

> DeepSeek 的缓存命中折扣高达 **98%**（V4 Flash 缓存命中仅 $0.0028/百万 tokens）。保持良好的缓存命中率可以大幅降低成本。

---

## 📊 缓存效率评分

| 分数 | 标签 | 颜色 | 含义 |
|------|------|------|------|
| 80-100 | Excellent | 🟢 绿 | 大部分 prompt 命中缓存，成本极低 |
| 50-79 | Good | 🟡 黄绿 | 缓存利用较好 |
| 30-49 | Fair | 🟠 橙 | 缓存利用一般，可优化 |
| 0-29 | Low | 🔴 红 | 缓存命中率低，建议检查上下文一致性 |

---

## 🏗️ 技术架构

```
SillyTavern-TokenCacheMonitor/
├── manifest.json      # 扩展元数据
├── index.js           # 主逻辑（前端）
│   ├── fetch() 拦截   # 捕获 API 响应中的 usage 数据
│   ├── ST 事件钩子    # GENERATION_STARTED/ENDED、STREAM_TOKEN_RECEIVED
│   ├── 浮动面板 UI    # 可拖拽、折叠的 DOM 面板
│   ├── localStorage   # 会话数据持久化
│   └── STscript 命令  # /token-stats, /token-reset
├── style.css          # 面板样式（深色主题）
├── server-patch.js    # 可选服务端补丁（缓存字段透传）
└── README.md          # 本文档
```

### 数据流

```
DeepSeek API ──► ST Server (proxy) ──► Browser (fetch)
                                          │
                                   ┌──────┴──────┐
                                   │  fetch拦截   │
                                   │  提取 usage  │
                                   └──────┬──────┘
                                          │
                                   ┌──────┴──────┐
                                   │  stats 对象  │
                                   │  + UI 渲染   │
                                   │  + localStorage│
                                   └─────────────┘
```

---

## 🐛 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 缓存命中始终为 0 | ST 丢弃了缓存字段 | 安装 server-patch.js |
| 成本显示为 $0 | 定价模型不匹配 | 在设置中选择正确的模型 |
| 面板不显示 | 扩展未启用 | 检查 Extensions 面板 |
| 统计数据刷新后丢失 | localStorage 被清除 | 正常行为（隐私模式会清除） |
| 吞吐量显示 "-" | 无历史数据 | 发送几条消息后自动出现 |

---

## 📝 许可

MIT License — 与 CodeWhale 项目保持一致。

---

## 🔗 相关链接

- [CodeWhale](https://github.com/usewhale/DeepSeek-Code-Whale) — 终端 AI 编程助手
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) — LLM 前端
- [DeepSeek API 定价](https://api-docs.deepseek.com/quick_start/pricing)
- [ST 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
