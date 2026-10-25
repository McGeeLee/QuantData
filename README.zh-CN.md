# QuantData

[English](./README.md) · [行情面板](https://quantdata.mcgeelee.com/) · [项目介绍](https://quantdata.mcgeelee.com/about) · [API 指南](./docs/API.zh-CN.md) · [MCP 指南](./docs/MCP.zh-CN.md) · [部署指南](./docs/DEPLOYMENT.zh-CN.md) · [OpenAPI](https://quantdata.mcgeelee.com/openapi.json)

QuantData 是运行在单个 Cloudflare Worker 上的双语行情仪表盘、REST API、OpenAPI 3.1 服务与无状态 MCP Server。它将 Yahoo Finance Chart、Tushare Pro 和 Tiingo 统一为按日期升序的供应商原生日线 OHLCV。

项目与仓库统一使用 **QuantData**；已部署 Worker、API/MCP、缓存和浏览器存储标识仍保留 `quant-data`，以兼容现有部署与客户端。

> 这是历史日线数据，不是实时行情。行情可能延迟、不完整或暂时不可用。Yahoo Chart 是非官方接口，不保证长期稳定。本项目不提供投资建议。

## 主要能力

- React 19 + Vite 8 响应式仪表盘与 Lightweight Charts
- `/` 直接显示查询表单与图表，`/about` 独立展示项目介绍和 API/MCP 示例，不发出供应商 API 请求。行情页的详细连通性检查默认收起。
- Hono + Zod/OpenAPI REST 契约和稳定的双语错误格式
- 通过 Cloudflare Agents `createMcpHandler` 使用 MCP SDK v2
- 无状态 Streamable HTTP，兼容普通 2025 旧版无状态客户端
- 中英文 UI、文档、API 消息、风险提示和 MCP 文档资源
- 明确展示数据源、最新返回交易日期、抓取时间以及缓存命中/年龄
- 手动数据源连通性检查，显示脱敏诊断、检查时间与缓存状态，不自动轮询
- 一小时边缘缓存；按匿名 IP、数据源与边缘位置执行每分钟约 60 次 Cloudflare Rate Limiting
- REST、快照、MCP 与手动检查共享按供应商持久化的预算；预算耗尽或保护不可用时停止请求
- 行情查询上游 10 秒超时，网络错误与 HTTP 502–504 在预算允许时最多重试一次；供应商 HTTP 429 和手动检查不重试
- Secret 只从 Worker 绑定读取，不写入响应或日志

## 公开端点

| 端点 | 说明 |
| --- | --- |
| `GET /` | 行情面板：查询表单、历史图表和按需展开的连通性诊断 |
| `GET /about` | 项目介绍与 API/MCP 接入示例 |
| `GET /healthz` | 服务版本和 Cloudflare 部署元数据 |
| `GET /api/v1` | API 发现、链接、操作 ID 和限制 |
| `GET /api/v1/sources` | 数据源配置、市场、示例、风险和署名；不探测上游 |
| `POST /api/v1/sources/{source}/check` | 手动固定样本连通性诊断；不返回价格 |
| `GET /api/v1/market-data` | 供应商原生日线；默认最近一个日历月、最长五年、最多 2,000 条 |
| `GET /api/v1/snapshot` | 最新收盘、前收、涨跌额、涨跌幅和成交量 |
| `GET /openapi.json` | OpenAPI 3.1 机器契约 |
| `POST /mcp` | 无状态 Streamable HTTP MCP |
| `GET /docs/en` | 英文文档 |
| `GET /docs/zh-CN` | 中文文档 |
| `GET /llms.txt` | 大模型精简发现文件 |
| `GET /llms-full.txt` | 中英文完整模型上下文 |

### REST 示例

```bash
curl 'https://quantdata.mcgeelee.com/api/v1/market-data?source=yahoo&symbol=AAPL&start=2025-01-01&end=2025-12-31&lang=zh-CN'
```

`source` 可为 `yahoo`、`tushare` 或 `tiingo`。`start` 和 `end` 是包含边界的 `YYYY-MM-DD` 日期。可使用 `lang=en`、`lang=zh-CN` 或 `Accept-Language`；字段名、类型和错误码不会随语言改变。

默认区间为最近一个日历月：`end` 默认 UTC 当天，省略 `start` 时使用前一个日历月的同日；若该日不存在，则取上月最后一天（例如非闰年的 3 月 31 日 → 2 月 28 日）。仅传入 `end` 时也按此规则计算起始日期。

HTTP 错误响应使用以下格式：

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "请求参数无效。",
    "requestId": "..."
  }
}
```

## MCP 调用

将 Streamable HTTP 客户端连接到：

```text
https://quantdata.mcgeelee.com/mcp
```

客户端配置示例：

```json
{
  "mcpServers": {
    "quantdata": {
      "type": "http",
      "url": "https://quantdata.mcgeelee.com/mcp"
    }
  }
}
```

提供三个工具：

- `list_data_sources`：数据源状态与代码示例
- `get_market_data`：默认最近 120 条，可把 `limit` 提高到 500，并返回截断状态
- `get_market_snapshot`：最新收盘和涨跌指标

所有工具均为只读、幂等，具有 Zod 输入/输出 schema，同时返回精简文本与 `structuredContent`。资源为 `quant-data://docs/en`、`quant-data://docs/zh-CN` 和 `quant-data://api/openapi`。

MCP handler 对配置的 `PUBLIC_ORIGIN`、本地开发和 MCP Inspector 来源执行 Host/Origin 校验，防止 DNS rebinding。端点按设计不使用鉴权。

## 数据源行为

| 数据源 | 市场/示例 | Secret | 说明 |
| --- | --- | --- | --- |
| Yahoo Finance Chart | `AAPL`、`BTC-USD`、`600519.SS` | 无 | 非官方接口；成交量为提供方原生单位 |
| Tushare Pro | `600519.SH`、`000001.SZ` | `TUSHARE_TOKEN` | 成交量单位为手（每手 100 股） |
| Tiingo | `AAPL`、`TSLA` | `TIINGO_KEY` | 响应保留“Data provided by Tiingo”署名 |

v1 只提供供应商原生日线。`adjustment: "raw"` 表示本服务不再额外复权，不保证供应商返回的价格未经调整；Yahoo OHLC 可能已按拆股调整，本适配器不使用 Yahoo `adjclose`（[Yahoo 价格说明](https://finance.yahoo.com/quote/AAPL/history?filter=history&frequency=1d&interval=1d&period1=345423600&period2=1482361200)）。`configured: true` 仅报告配置存在，不表示已验证供应商连通性、配额或权限。缺失值保留 `null`；无数据时返回 `NOT_FOUND`，不使用生成行情替代。Secret 缺失时，`/api/v1/sources` 会报告未配置，调用对应数据源返回 `SOURCE_NOT_CONFIGURED`；`/healthz` 不会探测或泄露 Secret 状态。

### 手动连通性检查

点击数据源旁的检查按钮，或发送无请求体的 `POST /api/v1/sources/{source}/check?lang=zh-CN`。检查从 Cloudflare Worker 发出，固定查询 Yahoo/Tiingo 的 `AAPL` 或 Tushare 的 `600519.SH` 最近一个日历月日线（UTC 今天至上月同日，月底不足则取最后一天），绕过行情缓存，至多一次供应商请求；无密钥时直接报告 `not_configured`。不自动检查或轮询，不回显密钥或原始上游错误。

HTTP 200 仅表示诊断完成，应检查 `status`；只有 `ok` 表示该时间、该固定样本请求成功，不保证持续可用或其他标的权限。诊断结果独立缓存 300 秒，供应商或项目预算更长的 `Retry-After` 会延长等待；缓存命中保留原 `checkedAt`/`durationMs`，`cached` 与 `nextCheckAt` 显示复用和重试时间。未命中后按数据源、边缘位置每 60 秒允许约一次检查；端点 429 需遵循 `Retry-After`。每次实际供应商尝试还须通过共享持久化预算，`quota_exceeded` 表示项目预算暂停检查，`quota_unavailable` 表示预算保护不可用。结果反映 Worker 到供应商的路径，不能据此认定用户家庭 IP 有问题。完整状态和字段见 [API 指南](./docs/API.zh-CN.md#手动连通性检查)。

### 仅使用免费额度

部署保持 **Cloudflare Workers Free 与 SQLite Durable Objects**。项目默认上限：Tiingo 每小时 40 次、每 24 小时 800 次、每 31 天 400 个不同标的及 800,000,000 个计入预算的字节；Tushare 每分钟 40 次、每 24 小时 6,400 次；Yahoo 每分钟 1 次、每 24 小时 100 次（项目自定，并非 Yahoo 公布额度）。缓存命中不消耗供应商额度；实际尝试逐次计数，重试和失败也计入。单次手动检查至多一次尝试，行情查询至多两次，不自动切换供应商。每个数据源使用一个 SQLite Durable Object，部署或换密钥不会重置计数。保守字节预留和官方套餐依据见[预算与测试成本说明](./docs/DEPLOYMENT.zh-CN.md#免费额度预算与测试成本)。

这些上限只覆盖本部署已记录的请求，不涵盖历史用量、共用凭据的其他应用或整个账号账单。真实测试前须在官方控制台核对套餐与剩余额度。预算耗尽返回 `QUOTA_EXCEEDED`（429），保护不可用返回 `QUOTA_UNAVAILABLE`（503），不会发出被拦截的尝试。不要为继续测试而升级付费或绕过保护。

## 本地开发

推荐使用 `.nvmrc` 指定并经过本机验证的 **Node.js 24.19.0** 与 npm。锁定工具链要求 Node.js `^22.18.0 || >=24.11.0`，较早的 Node 22 版本不满足要求。

```bash
# 如果使用 nvm：
nvm install
nvm use
npm ci
npm run dev -- --host 127.0.0.1 --port 5183 --strictPort
```

Yahoo 不需要凭据，但非官方接口仍可能失败或限流。Tushare/Tiingo 为可选项：只在 `.dev.vars` 不存在时从 `.env.example` 创建，再在本机填写。不得提交该文件，也不要把密钥放进 `VITE_*` 变量。

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` 运行 lint、类型检查、单元/契约测试、Worker 生成类型校验、生产构建和部署 dry run。浏览器测试使用 API 夹具，不是真实供应商验收。真实上游检查需通过本地 Worker 或已部署服务完成，详见[部署与演示指南](./docs/DEPLOYMENT.zh-CN.md)。

## Cloudflare 部署

部署前审阅 `wrangler.jsonc`：Worker 名为 `quant-data`，兼容日期 `2026-08-08`，启用 `nodejs_compat`，`vars.PUBLIC_ORIGIN` 必须指向计划使用的公开地址。保留 SPA 资源、两个 Rate Limiting 绑定、版本元数据，以及指向 SQLite `ProviderBudget` 类的必需绑定 `PROVIDER_BUDGET`。首次 `provider-budget-v1` 迁移必须成功；无需 D1、KV 或 R2。

准备好后按[操作者指南](./docs/DEPLOYMENT.zh-CN.md)确认账号、可选 Secret、生成类型、构建和目标域名，再执行 `npm run deploy`；该命令会先构建再部署。当前 `routes` 条目会在部署时将 `quantdata.mcgeelee.com` 绑定为自定义域名。重新部署到自己的账号时，请替换或删除该条目，并将 `PUBLIC_ORIGIN` 改为自己的地址；单独修改 `PUBLIC_ORIGIN` 不会绑定域名或修改 DNS。

README 示例使用规范地址 `https://quantdata.mcgeelee.com`。原 `https://quant-data.mcgeelee.workers.dev` 地址继续提供网页和 REST API；MCP 客户端请使用 `https://quantdata.mcgeelee.com/mcp`。新部署请替换为自己的地址。运行中的仪表盘、文档、OpenAPI 和 LLM 发现链接会使用当前站点地址，MCP 则允许配置的规范域名。只有已启用的 Workers Builds 关联才会在推送到指定分支时自动部署，不能仅凭仓库假定 `main` 已关联。

## 作品集演示

展示一次真实日线查询及数据源、交易日期、抓取时间和缓存状态，再演示手机布局、语言切换、输入错误、未配置源、OpenAPI 与只读 MCP。定位是行情数据集成项目，不是实时行情或交易系统；保留供应商署名。[演示流程](./docs/DEPLOYMENT.zh-CN.md#作品集演示流程)明确区分合成测试夹具与真实供应商验收。

## 架构

```text
浏览器 / REST 客户端 / MCP 客户端
                 │
        Cloudflare Worker
        ├── React SPA 静态资源
        ├── Hono + OpenAPI API
        ├── 无状态 MCP v2 handler
        ├── 限流 + Cache API
        ├── 按供应商划分的 SQLite Durable Object 预算
        └── 统一数据适配层
            ├── Yahoo Chart
            ├── Tushare HTTP API
            └── Tiingo REST API
```

缓存键包含数据源、规范化代码、包含边界的日期范围和周期；只有成功规范化的数据会缓存 3,600 秒。命中时 `meta.fetchedAt` 保留原抓取时间；`meta.latestBarDate` 为最新返回交易日期，`meta.cache` 报告 `status`、`ttlSeconds` 与 `ageSeconds`。缓存故障时，也必须通过预算检查才能请求所选供应商，不会使用编造数据。API 与 MCP 共享适配、预算和错误映射层。

## 从 v2 迁移

v3 是完整重写。旧 Python、Streamlit、Pandas、Plotly、`yfinance`、`tushare` 和 `tiingo` 客户端实现已删除。主要行为差异：

- 单个边缘 Worker 取代 Streamlit 与服务端 DataFrame 流程；
- 浏览器、REST、OpenAPI 和 MCP 都是一等接口；
- 直接 HTTP 适配器具有明确的超时、重试与错误策略；
- 只保留原项目实际启用的 Yahoo、Tushare 与 Tiingo 供应商原生日线；
- 不迁移 AkShare、Binance 占位、Python 依赖和 Streamlit 配置。

## 署名与条款

数据仍受各提供方条款约束。Yahoo Chart 是非官方接口；Tushare 响应保留 Tushare 署名；Tiingo 响应包含所需署名。部署者需自行确保其数据套餐允许公开再分发。
