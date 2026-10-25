# Quant Data MCP Server

[English](./MCP.md) · [REST API 指南](./API.zh-CN.md)

规范端点：`https://quantdata.mcgeelee.com/mcp`。新部署需替换为你的规范地址，参见[部署指南](./DEPLOYMENT.zh-CN.md)。旧 `workers.dev` 地址继续提供网页和 REST API；MCP 的 Host 会按 `PUBLIC_ORIGIN` 校验，因此 MCP 客户端必须改用此规范端点。

服务完全公开、只读、无状态，使用 Streamable HTTP；支持当前 MCP SDK v2 客户端及 2025 旧版无状态兼容路径。请求相互独立，客户端不能依赖服务端会话状态。

## 客户端配置

```json
{
  "mcpServers": {
    "quant-data": {
      "type": "http",
      "url": "https://quantdata.mcgeelee.com/mcp"
    }
  }
}
```

浏览器/Inspector 客户端必须发送允许的 `Origin`。`wrangler.jsonc` 中 `vars.PUBLIC_ORIGIN` 的主机名、localhost/loopback 与 `inspector.modelcontextprotocol.io` 已允许。Host/Origin 校验可防止 DNS rebinding，因此任意浏览器来源会被拒绝。

## 工具选择

1. 选择数据源前先调用 `list_data_sources`。
2. 只需要最新值和涨跌指标时使用 `get_market_snapshot`。
3. 需要序列、分析或图表输入时使用 `get_market_data`。
4. 下游回答必须保留 `structuredContent.meta` 中的风险提示与署名。

| 工具 | 主要输入 | 输出 |
| --- | --- | --- |
| `list_data_sources` | `lang`（`en`/`zh-CN`） | 配置状态、市场、原生代码、风险与署名（不探测上游） |
| `get_market_data` | `source`、`symbol`；可选 `start`、`end`、`lang`、`limit` | 升序供应商原生日线；默认 120、最多 500 条 |
| `get_market_snapshot` | `source`、`symbol`；可选 `start`、`end`、`lang` | 最新收盘、前收、涨跌额、涨跌幅与成交量 |

所有工具声明只读、非破坏、幂等注解，并使用 Zod 输入/输出 schema。现代客户端获得精简文本与经过验证的 `structuredContent`；旧版无状态客户端还会获得 JSON 文本。`meta.truncated` 表示只返回所请求的最近若干条。

## 资源

| URI | MIME | 用途 |
| --- | --- | --- |
| `quant-data://docs/en` | `text/markdown` | 英文 API/MCP 指南 |
| `quant-data://docs/zh-CN` | `text/markdown` | 中文 API/MCP 指南 |
| `quant-data://api/openapi` | `application/json` | 当前 OpenAPI 3.1 REST 契约 |

资源发现带公开缓存提示，内容不包含凭据。

## 工具错误

工具失败设置 `isError: true` 并返回稳定 JSON 文本：

```json
{
  "error": {
    "code": "UPSTREAM_RATE_LIMITED",
    "message": "上游数据提供方正在限流。",
    "retryable": true,
    "retryAfterSeconds": 30,
    "hint": "请等待 Retry-After 指定的秒数后重试，或改用其他已配置数据源。",
    "requestId": "..."
  }
}
```

协议/schema 校验错误由 MCP SDK 返回；应用错误与 REST 共用错误码。模型应修正不可重试的参数/配置错误，遵循 `retryAfterSeconds`，并在报告持续故障时附上 `requestId`。

## 数据与运行语义

- 日期包含边界、严格校验且最长五年。
- 仅提供历史供应商原生日线，不是实时价格流。`meta.latestBarDate` 是最新返回交易日期；`meta.fetchedAt` 为抓取时间，缓存命中不会刷新它。
- `meta.cache` 报告 `status`（`hit`/`miss`/`unavailable`）、`ttlSeconds` 和 `ageSeconds`。抓取时间或缓存年龄不代表行情新旧程度；缺失指标保留 `null`。
- `adjustment: "raw"` 表示本服务不做额外复权；Yahoo 价格可能已按拆股调整，本适配器不使用 `adjclose`，不要将 raw 等同于保证未调整的价格。
- Tushare 成交量单位为手；其他源使用提供方原生单位。
- REST/MCP 共用按匿名 IP/数据源/边缘位置每分钟约 60 次限流和一小时边缘缓存。
- Yahoo Chart 是非官方接口，可能限流或随时变化。
- 配置 Worker Secret 前，Tushare/Tiingo 返回 `SOURCE_NOT_CONFIGURED`。“已配置”不等于已验证连通性、配额或权限。

行情可能延迟或不完整。本服务不构成投资建议。
