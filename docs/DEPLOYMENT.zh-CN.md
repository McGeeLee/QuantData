# QuantData 构建、重新部署与演示

[English](./DEPLOYMENT.md) · [项目说明](../README.zh-CN.md)

项目将 React/Vite 前端和 Hono API 打包成一个 Cloudflare Worker，并用 SQLite Durable Objects 持久化供应商预算。首次预算版本需要执行 Durable Object 迁移。本地检查不会部署；下面的部署命令供操作者准备好后自行执行。

## 复现本地构建

推荐 `.nvmrc` 指定的 Node.js 24.19.0 与 npm（工具链要求 `^22.18.0 || >=24.11.0`），在仓库根目录执行：

```bash
# 如果使用 nvm：
nvm install
nvm use
node --version
npm --version
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm ci` 严格使用已提交的 `package-lock.json`，不要替换为无目的依赖升级。`npm run check` 依次运行 lint、TypeScript、单元/契约测试、Worker 生成类型检查、生产构建、Wrangler dry run 与真实本地 HTTP 运行时回归。dry run 只准备部署包，不上传。修改 `wrangler.jsonc` 后，先执行 `npm run cf-types` 并审阅类型差异，再重新检查。

单独运行时先构建：`npm run build && npm run test:runtime`，以检查当前生产产物。它会启动隔离的本地 workerd、使用空凭据和临时端口，验证诊断端点能接受空 POST（包括零长度和空分块请求），并拒绝非空请求体。它不会访问生产或供应商；完成后自动清理自己启动的进程。这个检查覆盖 Node 内存请求和前端 API 夹具无法替代的真实 HTTP 请求体语义。随后在真实本地 SQLite Durable Object 中验证并发不超额、重复结算幂等、供应商之间独立计数，以及重启后用量保留。还通过本地 HTTP 夹具验证 workerd 原生 fetch：GET/POST 可用、跳转不会被跟随、预算拒绝不发出请求。此回归不能用 mock 替换原生 RequestInit 行为；Workers 支持 redirect: manual，不支持 redirect: error。最后通过生产 ASSETS 绑定检查 `/`、`/about` 与双语文档的直接访问和刷新，同时确认 API 路径仍返回 JSON。

浏览器测试使用独立的前端 Vite 服务与 API 固定夹具，验证界面、失败状态和移动布局，**不证明 Yahoo、Tushare 或 Tiingo 已连通**。供应商与 MCP 单元测试也使用受控响应。要测试真实本地 Worker，可选择一个未占用端口：

```bash
npm run dev -- --host 127.0.0.1 --port 5183 --strictPort
```

打开终端打印的本地地址。`--strictPort` 在端口占用时直接退出，不干扰其他项目。此开发服务会调用真实供应商适配器，行情查询可能消耗供应商配额，也可能因网络或上游限制失败。本地 Durable Object 存储与生产独立；用相同凭据发出的真实本地请求不会计入生产预算。除有意验收供应商外，优先使用夹具测试。

Yahoo 不需要密钥。Tushare/Tiingo 为可选源：仅在 `.dev.vars` 不存在时从 `.env.example` 创建它，再填入准备使用的密钥，保持该文件被 Git 忽略。不得将密钥写入 `VITE_*` 变量、源码、截图或浏览器存储。

## 免费额度预算与测试成本

本部署保持 **Cloudflare Workers Free**，Durable Object 仅使用 **SQLite** 后端。Free 某项额度用尽后，对应操作会失败；不要为继续测试而升级 Paid、开通付费资源或删除预算保护。部署前在 Cloudflare 控制台确认实际套餐与用量。登录或上传成功不能证明账单状态；如账单 API 读取返回 403，应记录套餐核验仍依赖账号所有者查看控制台。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) · [Durable Objects 免费支持与限制](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

| 供应商 | 官方入门额度 | 项目保守上限 |
| --- | --- | --- |
| Tiingo Starter | 每小时 50 次、每天 1,000 次、每月 500 个不同标的、每月 1 GB | 每小时 40 次、每 24 小时 800 次、每 31 天 400 个不同标的及 800,000,000 个计入预算的字节 |
| Tushare 120 积分日线 | 每分钟 50 次、每天 8,000 次，所列档位价格为 ¥0 | 每分钟 40 次、每 24 小时 6,400 次 |
| Yahoo Chart | 不声称此非官方接口有已公布的免费额度 | 项目自定每分钟 1 次、每 24 小时 100 次 |

依据：[Tiingo 价格表](https://www.tiingo.com/about/pricing)、[Tiingo 额度与重置周期](https://www.tiingo.com/documentation/general/overview)、[Tushare 权限频次表](https://tushare.pro/document/1?doc_id=290)。Tushare 积分是权限门槛，不按请求扣减；凭据仍须具有对应权限（[积分说明](https://tushare.pro/document/1?doc_id=13)）。供应商实际套餐、剩余额度及数据展示权限须在各自官方控制台确认。

REST 行情、快照、MCP 与手动检查在**每次实际 fetch 尝试前**，都向同一个按供应商划分的 SQLite Durable Object 持久化预留。缓存命中消耗零次供应商请求；失败和重试仍计数。新手动检查至多一次尝试，未缓存行情查询对网络错误或 HTTP 502–504 在预算允许时至多尝试两次。供应商 HTTP 429 直接返回，不额外重试。缺密钥或预算拒绝不会发出供应商请求；应用不会在失败或限额后自动切换供应商。

Tiingo 每次尝试预留 **6 MiB**。完整读取不超过 **5 MiB** 的 HTTP 2xx 响应后，结算为实际响应体字节数加 **16 KiB**，与后续数据校验是否成功无关；网络请求失败、非 2xx、取消、超大、未知或未能结算的尝试保留全额预留。滚动计数采用保守桶边界：分钟/小时窗口可能多计至多一分钟，24 小时窗口至多一小时，31 天字节窗口至多一天；不同标的按精确最近访问时间统计 31 天。这是项目预算，不是供应商计费表的副本，也不是全账号零账单保证。

夹具单元/浏览器测试和隔离的本地 HTTP 回归产生**零次真实供应商调用**，打包与 dry run 也不调用供应商。真实本地或线上测试可能消耗额度；线上缓存命中虽不请求供应商，仍会使用 Cloudflare 资源。保护无法追溯安装前用量，也不涵盖其他应用、本地服务、独立 Worker 或另建命名空间共用账号的请求。真实探测前核对官方用量，保持手动、少量检查。

预算用尽返回 `QUOTA_EXCEEDED`（429，带 `Retry-After`），预算绑定缺失或许可失败返回 `QUOTA_UNAVAILABLE`（503）。连通性诊断则在 HTTP 200 响应内报告 `quota_exceeded` 或 `quota_unavailable`。应等待或恢复预算服务，不得绕过保护；若仅结算失败，已取得的数据可正常返回，但预算保留全额预留。

## 部署前检查配置

| 配置项 | 需要确认的内容 |
| --- | --- |
| `name` | `quantdata` 指向所选 Cloudflare 账号下已重命名的 Worker。已有 Worker 应先在 Cloudflare 中完成重命名；仅修改此值不会重命名已有 Worker。 |
| `vars.PUBLIC_ORIGIN` | 当前为 `https://quantdata.mcgeelee.com`。重新部署时填写自己的准确公开地址，不带路径、查询参数或凭据。MCP 使用其主机名作为允许列表。 |
| `routes` | 当前 `{ "pattern": "quantdata.mcgeelee.com", "custom_domain": true }` 条目会在部署时绑定该域名。请替换为自己已激活 Cloudflare zone 下的域名；若只使用默认 Workers 地址，则删除 `routes`。绑定前检查已有 DNS 和 Worker 占用。 |
| `workers_dev` | 显式设为 `true`，让当前 Worker 的默认地址提供网页和 REST API，与自定义域名并存；MCP 客户端使用配置的规范域名。 |
| `vars.APP_VERSION` | 与准备发布的服务版本保持一致。 |
| `compatibility_date`、`nodejs_compat` | 保留 `2026-08-08`，这是锁定 workerd 支持的最新日期；原 `2026-08-10` 会阻碍本地启动。运行时与依赖升级应配套测试。 |
| `ASSETS` | Vite 插件生成前端和 Worker；保留 SPA fallback 和 `run_worker_first` 中 API/MCP 路由。 |
| `MARKET_RATE_LIMIT` | 保留绑定名。`namespace_id` 是账号内标识，不是秘密；同账号创建独立限流器时使用不同 ID。每分钟 60 次按边缘位置执行，不是费用上限。 |
| `SOURCE_CHECK_RATE_LIMIT` | 保留独立诊断限流绑定及其独立 namespace；每个数据源、每个 Cloudflare 位置每 60 秒约一次新检查。先读诊断缓存再限流，不是严格全局配额或免费额度保障。 |
| `PROVIDER_BUDGET` | 必需 Durable Object 绑定，指向导出的 SQLite `ProviderBudget` 类。每个稳定供应商名选择一个持久化对象，由本部署所有请求入口和边缘位置共享。 |
| `migrations` | 保留 `{ "tag": "provider-budget-v1", "new_sqlite_classes": ["ProviderBudget"] }`。首次部署需要创建 SQLite 命名空间的权限；不得删除或改名类、命名空间或供应商名来重置用量。 |
| `VERSION_METADATA` | 向 `/healthz` 和 MCP 资源提供版本信息，并隔离不同 Worker 版本的诊断缓存；配置或密钥更新发布为新版本后旧诊断失效。 |
| `TUSHARE_TOKEN`、`TIINGO_KEY` | 可选 Worker Secret；缺失会禁用对应源，存在并不证明权限或连通性。 |

页面示例、REST 发现、OpenAPI 服务地址和 LLM 发现链接随当前访问地址生成。MCP 使用显式 `PUBLIC_ORIGIN` 配置，避免信任任意 Host 请求头；本地 localhost/loopback 与 MCP Inspector 浏览器来源仍可使用。`quantdata` Worker 的网页和 REST API 地址为 `https://quantdata.mcgeelee.workers.dev`；MCP 客户端必须连接 `https://quantdata.mcgeelee.com/mcp`。重新部署时如果同时保留自定义域名与 workers.dev，也请让 MCP 客户端连接配置的规范域名。不要通过放开任意 Origin 来掩盖配置错误。

单独修改 `PUBLIC_ORIGIN` 不会创建 DNS 或绑定自定义域名。带有 `custom_domain: true` 的 `routes` 条目会在 `wrangler deploy` 时完成绑定，由 Cloudflare 管理对应 DNS 和证书。重新部署时，必须替换或删除仓库中的 `quantdata.mcgeelee.com` 路由，使用自己控制的域名，并将 `PUBLIC_ORIGIN` 指向预期地址；不要将原域名条目部署到其他账号。SQLite 预算 Durable Object 为必需资源，无需 KV、D1 或 R2。Cache API 按 Cloudflare 边缘位置存放，重复请求不保证命中同一缓存。预算对象按供应商名选择，不依赖版本或密钥，因此重新部署和换密钥虽然会让诊断缓存失效，但保留预算计数。

## 准备好后自行部署

先在 Dashboard 确认 Workers Free、目标账号与要更新的既有 Worker；需要时完成本机认证：

```bash
npx wrangler login
npx wrangler whoami
```

若要使用 Tushare/Tiingo，只配置需要的 Secret；可使用交互式提示或目标 Worker 的 Dashboard，不要将密钥值直接写进命令：

```bash
npx wrangler secret put TUSHARE_TOKEN
npx wrangler secret put TIINGO_KEY
```

配置编辑完后重新生成类型（包括导出的 `ProviderBudget` 类与绑定）并运行本地检查。首次部署必须成功执行 SQLite 迁移；如权限或套餐限制阻止迁移，停止此次部署，保留预算保护并修复权限/配置。不得移除绑定或发布不受保护的供应商路径。准备完成后执行：

```bash
npm run cf-types
npm run check
npm run test:e2e
npm run deploy
```

`npm run deploy` 会先重新 Vite 构建，再运行 `wrangler deploy`。Vite 插件生成 Wrangler 自动读取的输出配置，因此改配置后不要直接部署旧构建。dry run 成功仅说明包可生成，不证明账号、供应商、自定义域名或线上缓存已经正常。

如果选择 Workers Builds 自动部署，主动设置目标仓库与分支、根目录 `/`、安装 `npm ci`、构建 `npm run build`、部署 `npx wrangler deploy`、Node.js 24.19.0。务必在 Cloudflare 确认实际触发器：只有关联并启用自动部署后，推送才会触发构建。仅凭仓库文件不能断言当前存在有效自动部署关联。

## 部署后真实验收

使用部署输出中的准确地址；下面地址仅为占位符：

```bash
QUANT_DATA_ORIGIN='https://your-worker.your-subdomain.workers.dev'
curl --fail-with-body "$QUANT_DATA_ORIGIN/healthz"
curl --fail-with-body "$QUANT_DATA_ORIGIN/api/v1/sources?lang=zh-CN"
curl --fail-with-body "$QUANT_DATA_ORIGIN/openapi.json"
curl --fail-with-body --get "$QUANT_DATA_ORIGIN/api/v1/market-data" \
  --data-urlencode 'source=yahoo' \
  --data-urlencode 'symbol=AAPL' \
  --data-urlencode 'lang=zh-CN'
```

确认首页、`/docs/en`、`/docs/zh-CN`、`/llms.txt` 和 `/llms-full.txt` 使用你的部署地址。将 Streamable HTTP MCP 客户端连接到规范地址 `/mcp`，列出工具并读取 `quant-data://api/openapi`。对每个已配置源分别使用原生有效代码查询。失败源保留“未验证”状态，检查稳定错误码和 request ID，不能拿生成数据代替。

成功响应需检查 `latestBarDate`、`fetchedAt`、`cache.status`、`cache.ageSeconds`、风险提示和成交量单位。重复查询可检查缓存，但不同边缘位置仍可能未命中。周末、节假日、历史日期范围、延迟源或尚未结束的日线都可能影响最新交易日期；刚抓取不代表刚成交。分享前还应在部署版本检查空输入、无效代码、供应商失败、快速点击、语言切换与手机布局。

### 手动检查数据源连通性

用户主动点击界面检查按钮或单独执行以下请求；不要将其放入轮询任务。无请求体，也不接受自定义代码或日期：

```bash
curl --request POST --fail-with-body \
  "$QUANT_DATA_ORIGIN/api/v1/sources/yahoo/check?lang=zh-CN"
```

Tushare/Tiingo 可分别替换路径中的数据源；未配置密钥时不发出上游请求。新检查从部署的 Worker 对固定代码发出一次最近日历月日线请求，旁路行情缓存，不返回价格或原始上游错误。观察 `status`、`checkedAt`、`durationMs`、`cached`、`nextCheckAt` 和安全错误码，而不能只看 HTTP 200。

正常诊断缓存 300 秒，供应商或项目预算更长的 `Retry-After` 可延长等待。命中缓存保留原时间与耗时，不会再测试供应商。HTTP 429 表示服务端诊断限流，应等待 `Retry-After`。HTTP 200 诊断中，`rate_limited` 表示供应商限流，`quota_exceeded` 表示共享项目预算阻止尝试，`quota_unavailable` 表示无法取得预算许可。缺少/过期密钥、访问权限、网络失败和限额需依据诊断区分，不能归因于用户家庭 IP。`ok` 只确认某次固定样本请求，不证明持续可用或所有代码权限。

部署管理 API 确认版本生效，不等于公开链路或供应商验收成功。如果公开访问受边缘策略阻止，应记录“尚未验证”，不要将管理 API 或模拟测试结果当作真实供应商成功。

## 作品集演示流程

1. 说明范围：单 Worker、三个供应商适配器、统一契约、浏览器 + REST + 只读 MCP。
2. 查询有效日线，指出数据源、最新返回交易日期、抓取时间、缓存状态、供应商原生价格语义和单位。
3. 切换中英文并展示手机布局；说明契约字段不随语言变，界面和错误会本地化。
4. 展示错误格式的代码和一个未配置源；手动检查一个数据源，区分当前诊断与缓存结果，说明请求来自 Worker，不暗示所有供应商持续在线。
5. 展示 OpenAPI、复制本站 REST/MCP 示例、保留供应商署名，并说明日线不是实时行情。

发布的仪表盘没有样例数据模式。浏览器测试夹具仅是合成测试数据，不能把测试截图表述为真实供应商验收，也不要将项目描述为策略、盈利预测或交易执行系统。

## 官方参考

- [Cloudflare Vite 构建输出与部署](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [MCP Host/Origin 校验](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Rate Limiting 绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
