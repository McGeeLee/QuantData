# Quant Data REST API

[English](./API.md) · [OpenAPI 3.1](https://quantdata.mcgeelee.com/openapi.json) · [MCP 指南](./MCP.zh-CN.md)

规范基础地址：`https://quantdata.mcgeelee.com`。重新部署请替换为自己的 origin；运行中的 OpenAPI 和发现链接会使用当前站点。参见[部署指南](./DEPLOYMENT.zh-CN.md)。

v1 API 完全公开、只读且无需鉴权，统一返回按日期升序的供应商原生日线 OHLCV。字段名、类型、`operationId` 和错误码不随语言改变。

## 发现与版本策略

- `GET /api/v1` 返回 API 链接、操作 ID 和 v1 限制。
- `GET /openapi.json` 提供机器可读契约。
- 响应包含 `X-API-Version: v1` 和 `X-Request-Id`。
- 破坏性变更必须使用新 URL 版本；v1 内允许新增可选字段与端点。

## 端点

| 操作 ID | 请求 | 用途 |
| --- | --- | --- |
| `getHealth` | `GET /healthz` | 健康检查，不探测上游或 Secret |
| `discoverApi` | `GET /api/v1` | API 发现文档 |
| `listDataSources` | `GET /api/v1/sources` | 配置状态、示例、风险与署名（不探测上游） |
| `checkSourceConnection` | `POST /api/v1/sources/{source}/check` | 手动固定样本连通性诊断；不返回行情价格 |
| `getMarketData` | `GET /api/v1/market-data` | 最多 2,000 条日线 OHLCV |
| `getMarketSnapshot` | `GET /api/v1/snapshot` | 最新收盘与涨跌指标 |

### 行情查询参数

| 参数 | 必填 | 规则 |
| --- | --- | --- |
| `source` | 是 | `yahoo`、`tushare` 或 `tiingo` |
| `symbol` | 是 | 数据源原生代码；服务会转为大写 |
| `start` | 否 | 包含边界的 `YYYY-MM-DD`；默认取 `end` 前一个日历月同日，若不存在则取上月最后一天 |
| `end` | 否 | 包含边界的 `YYYY-MM-DD`；默认 UTC 当天 |
| `lang` | 否 | `en` 或 `zh-CN`；省略时读取 `Accept-Language` |

两个日期均省略时，结束日期为 UTC 当天，开始日期为前一个日历月的同日；仅传入 `end` 时，也按该日期向前一个月计算。例如 `end=2026-03-31` 时默认 `start=2026-02-28`。这里是一个日历月，不是固定 30 天。

日期范围最长五年，并严格校验真实日历日期，因此 `2026-02-31` 会被拒绝。

| 数据源 | 合法示例 | 说明 |
| --- | --- | --- |
| Yahoo | `AAPL`、`BTC-USD`、`^GSPC`、`600519.SS` | 非官方 Chart 接口 |
| Tushare | `600519.SH`、`000001.SZ`、`430047.BJ` | 六位数字加 `.SH`、`.SZ` 或 `.BJ` |
| Tiingo | `AAPL`、`BRK-A` | Tiingo ticker；必须保留署名 |

## 示例

```bash
curl --get 'https://quantdata.mcgeelee.com/api/v1/market-data' \
  --data-urlencode 'source=yahoo' \
  --data-urlencode 'symbol=AAPL' \
  --data-urlencode 'start=2026-01-01' \
  --data-urlencode 'end=2026-08-10' \
  --data-urlencode 'lang=zh-CN'
```

`volume` 可能为 `null`。Tushare 成交量单位为手（每手 100 股），其他源使用提供方原生单位。当区间只有一条日线时，快照的 `previousClose`、`change` 和 `changePercent` 为 `null`。

`adjustment: "raw"` 保留 v1 契约值，含义是**本服务不做额外复权**，不能保证供应商 OHLC 未经调整。Yahoo 可能已按拆股调整；本适配器使用 Chart OHLC，不使用 `adjclose`。参见 [Yahoo 历史价格说明](https://finance.yahoo.com/quote/AAPL/history?filter=history&frequency=1d&interval=1d&period1=345423600&period2=1482361200)。

## 来源与时效

行情响应及快照的 `meta` 共用以下字段：

| 字段 | 含义 |
| --- | --- |
| `source`、`symbol` | 实际查询的数据源与规范化代码 |
| `latestBarDate` | 返回数据中最新交易日期，不是系统当前日期 |
| `fetchedAt` | 抓取供应商响应的 UTC 时间，缓存命中不刷新 |
| `cache.status` | `hit` 为读到有效缓存，`miss` 为未命中，`unavailable` 为缓存不可用而读取供应商；`miss` 不承诺后台写入成功 |
| `cache.ttlSeconds` | 缓存策略时长 3600 秒 |
| `cache.ageSeconds` | 自 `fetchedAt` 起经过的秒数，不是行情延迟秒数 |
| `count`、`truncated` | 返回条数与是否仅返回最近条目 |
| `warnings`、`attribution`、`volumeUnit` | 下游应保留的风险、署名与单位 |

这是历史日线，不是实时价格流。已配置不代表供应商已连通或账号有权限。无有效日线返回 `NOT_FOUND`，不生成替代行情；缓存故障也须通过共享预算检查才能请求所选供应商，供应商失败仍返回明确错误，不自动切换供应商。

## 手动连通性检查

```bash
curl --request POST \
  'https://quantdata.mcgeelee.com/api/v1/sources/yahoo/check?lang=zh-CN'
```

新部署请替换为自己的 origin。`source` 仅接受 `yahoo`、`tushare`、`tiingo`；`lang` 接受 `en` 或 `zh-CN`，无请求体。样本代码和日期由服务固定选择，与仪表盘表单无关：Yahoo/Tiingo 使用 `AAPL`，Tushare 使用 `600519.SH`。区间为最近一个日历月，结束日期为 UTC 当天，开始日期为上月同日；该日不存在则取上月最后一天。每次新检查绕过行情缓存，至多发出一次供应商请求，不自动重试。缺少所需密钥时直接返回 `not_configured`，不调用供应商；列出数据源不会触发检查，仪表盘也不会自动轮询。

HTTP **200 表示已生成诊断，不代表供应商成功**。响应顶层是独立诊断对象，不是行情响应：

| 字段 | 含义 |
| --- | --- |
| `source`、`status` | 检查的数据源与下表中的一种状态 |
| `checkedAt`、`durationMs` | 此次观测的 UTC 开始时间与耗时毫秒数 |
| `cached` | 是否复用旧诊断；命中时保留原检查时间、耗时和样本 |
| `nextCheckAt` | 建议最早再次检查的 UTC 时间，不代表会自动执行 |
| `sample.symbol`、`sample.start`、`sample.end` | 固定样本代码与包含边界的日期区间 |
| `sample.barCount`、`sample.latestBarDate` | 可选样本条数和最新交易日期，不返回 OHLCV 数值 |
| `error.code`、`error.upstreamStatus`、`error.providerCode` | 可选脱敏错误码、数字上游 HTTP 状态和供应商码；不含原始错误正文或凭据 |
| `requestId` | 本次 API 请求标识；复用旧诊断时也使用当前请求标识 |

| `status` | 含义 |
| --- | --- |
| `ok` | 此固定样本在 `checkedAt` 返回数据，不保证持续可用或其他标的权限 |
| `not_configured` | 所需密钥缺失，未发出供应商请求 |
| `access_denied` | 供应商拒绝访问；检查密钥、套餐权限或访问策略 |
| `rate_limited` | 供应商限制样本请求，遵循 `nextCheckAt` 和 `Retry-After` |
| `quota_exceeded` | 项目持久化预算阻止了本次尝试，等待 `nextCheckAt`/`Retry-After` |
| `quota_unavailable` | 无法取得预算许可，不会发出未经批准的尝试 |
| `timeout` | 供应商请求或响应体读取超时 |
| `network_error` | 从 Worker 运行时发出的网络请求失败 |
| `no_data` | 固定样本没有返回有效日线 |
| `upstream_error` | 其他供应商或响应异常，结合脱敏错误码判断 |

供应商诊断独立缓存 300 秒；供应商或项目预算更长的 `Retry-After` 会延长复用时长和 `nextCheckAt`。缓存命中不再次调用供应商。缓存键包含 Worker 版本，配置或密钥变更部署为新版本后，之前的诊断不再复用，但**不会重置持久化供应商预算**。缺密钥检查在读取缓存前执行。

读取缓存之后，`SOURCE_CHECK_RATE_LIMIT` 按数据源、边缘位置每 60 秒允许约一次新检查，由该位置的调用者共享。检查端点的 **HTTP 429** 表示服务自身限制诊断请求，与 HTTP 200 的 `status: rate_limited` 或 `quota_exceeded` 不同，应遵循 `Retry-After`。边缘限流器不是全局供应商预算；每次实际探测还须通过下述持久化预算，与行情、快照及 MCP 共用。任一保护不可用时，不发出未经批准的探测。

这些结果观察的是 **Cloudflare Worker → 供应商** 路径，不是浏览器的直接网络路径，不能据此认定用户家庭 IP 有问题。部署成功、密钥已配置或夹具测试通过，都不能单独证明线上供应商请求成功。

## 共享供应商预算

每次实际上游尝试前，`PROVIDER_BUDGET` 都先在按稳定供应商名选择的 SQLite Durable Object 中持久化预留。本部署所有调用者、边缘位置、REST 行情/快照、MCP 和手动检查共用每个供应商的计数，部署和轮换密钥不会重置。缓存命中消耗零次供应商请求；手动新检查至多一次，行情查询至多两次，每次重试单独计数。失败或结果未知的尝试保留计数。预算绑定缺失或许可失败会阻止尝试，不会自动切换供应商绕过限制。

| 数据源 | 项目上限 |
| --- | --- |
| Tiingo | 每小时 40 次；每 24 小时 800 次；每 31 天 400 个不同标的及 800,000,000 个计入预算的字节 |
| Tushare | 每分钟 40 次；每 24 小时 6,400 次 |
| Yahoo | 每分钟 1 次；每 24 小时 100 次；项目自定，并非 Yahoo 公布额度 |

窗口滚动且保守计数，与窗口重叠的桶整体计入：分钟/小时请求窗口可能多保留至多一分钟，24 小时请求窗口至多一小时，Tiingo 的 31 天字节窗口至多一天。不同标的按最近一次访问的精确时间统计 31 天。

Tiingo 每次尝试先预留 **6 MiB**。完整读取不超过 **5 MiB** 的 HTTP 2xx 响应后，结算为实际响应体字节数加 **16 KiB**，与后续数据校验是否成功无关；网络请求失败、非 2xx、取消、超大或未知响应保留全额预留。结算失败时也保留全额预留，但可返回已取得的数据。这是保守的项目预算，不是 Tiingo 计费表，也不能保证全账号零费用。

项目上限低于官方 [Tiingo Starter 额度](https://www.tiingo.com/about/pricing)及 [Tushare 120 积分日线额度](https://tushare.pro/document/1?doc_id=290)，但不涵盖之前的用量或其他共用账号应用。Tiingo 官方重置周期也与项目滚动窗口不同（[API 总览](https://www.tiingo.com/documentation/general/overview)）。请在官方控制台确认当前套餐、权限和用量，参阅[免费部署与测试成本](./DEPLOYMENT.zh-CN.md#免费额度预算与测试成本)，不要为继续测试而升级付费或绕过保护。

## 错误与客户端策略

```json
{
  "error": {
    "code": "INVALID_SYMBOL",
    "message": "代码格式不符合所选数据源的要求。",
    "details": { "source": "tushare", "expected": "..." },
    "requestId": "..."
  }
}
```

| HTTP | 常见错误码 | 策略 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_SYMBOL`、`INVALID_DATE_RANGE` | 修正请求 |
| 404 | `NOT_FOUND` | 更换代码、区间或源 |
| 404/405 | `ROUTE_NOT_FOUND`、`METHOD_NOT_ALLOWED` | 修正路由/方法并查看 `Allow` |
| 429 | `RATE_LIMITED` | 遵循 `Retry-After` |
| 429 | `QUOTA_EXCEEDED` | 项目预算阻止尝试；遵循 `Retry-After`，不要自动换源 |
| 502 | `UPSTREAM_ERROR` | 退避后重试 |
| 503 | `SOURCE_NOT_CONFIGURED`、`UPSTREAM_RATE_LIMITED` | 配置/更换源或遵循 `Retry-After` |
| 503 | `QUOTA_UNAVAILABLE` | 预算保护不可用；恢复绑定/服务后再尝试 |
| 504 | `UPSTREAM_TIMEOUT` | 退避后重试 |
| 500 | `INTERNAL_ERROR` | 重试一次；持续失败时报告 `requestId` |

可重试错误应使用带抖动的指数退避；不要原样重试 400。错误响应使用 `Cache-Control: no-store`。

## 缓存、限流与 CORS

- 成功结果按数据源、代码、区间和周期在边缘缓存 3,600 秒。
- 行情调用按匿名 IP/数据源/边缘位置每分钟约 60 次；健康、发现和文档不受该应用限流器限制，仍受 Cloudflare 账号/资源额度限制。
- 单次上游连接等待上限 10 秒，响应体读取另有 10 秒上限与 5 MiB 大小限制；行情请求的网络错误和 HTTP 502–504 在预算允许时最多重试一次，手动检查不重试。供应商 HTTP 429 立即返回，不额外尝试。较长的 `Retry-After` 会返回客户端。
- REST 允许跨域 `GET`/`OPTIONS`；手动检查路由另允许 `POST`/`OPTIONS`，并暴露 `X-Request-Id`、`X-API-Version` 和 `Retry-After`。

行情可能延迟、不完整或暂时不可用。本服务不构成投资建议。数据条款与再分发权限仍由调用者/部署者负责。
