# Mirasim 0.0.516 解包、版本适配与空间额度调查

日期：2026-10-15。目标为用户指定的 ARM64 DMG，不声称这是其他渠道的最新版本。

## 结论

- 完整官方 `server.cjs` 已替换到 vendor，默认客户端版本同步到 `0.0.516`；没有修改官方 bundle 内部代码。
- 新包签名/封装 WASM、公钥与旧 `0.0.454` 完全相同，既有固定签名、加密向量和版本执行验证通过。
- 新增了空间钱包客户端：`getSpaceCredit`、`setSpaceCreditMode`、`setSpaceCreditPrefer`、成员上限、额度转入与到账查询。旧 `0.0.454` bundle 没有前两个消息类型，也没有 `x-mirasim-payer`。
- **额度信息只读 API 和显式启用的空间 turn 转发层已实现；自动获取 capability、真实空间权益与钱包扣费尚未验证，不能声称端到端完整可用。**
- 协作执行的 model gateway 和 turn-capability 续期链路在旧包已存在，不是 0.0.516 才新增的接口。
- 所选的一个本地账号只读实测：空间列表为空、空间数量配额为零。不能据此判断其他账号没有团队权益，也不能用它验证有余额空间的模型扣费。

## 产物与校验

目录：`.runtime/releases/inspection-0.0.516/`。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| DMG | 149600903 | `9076604bd173dd9bef3f07fc55969fbd8e4aaa72fc264c47e759f01f875b171e` |
| `server.cjs` | 25364146 | `671caeca8bae790743a1ee2fde417da8db406c79967f7ef92c89bffd172e77dc` |
| 内嵌 WASM | 88281 | `fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95` |

下载来源与清单：

```text
https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.516/Mirasim-0.0.516-arm64.dmg
https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.516/SHA256SUMS
```

DMG 哈希匹配官方清单。Info.plist 两个版本字段均为 0.0.516。这不等于验证 macOS 发布者签名或 notarization。

7-Zip 选择性提取 Info.plist、server.cjs、app.asar，没有挂载 DMG 或运行 Electron。APFS 提取有尾部额外数据警告；选定文件成功提取。复用之前的安全 ASAR 读取器，校验路径、边界与文件级 SHA-256，提取 269 项、内容 19722458 字节。清单保存在 `analysis/asar-manifest.json`。

旧 bundle 备份：`baseline/server-0.0.454.cjs`，SHA-256 为 `c3fb553fc6ba60be2bb4c164661c7a4ab7d9eafc1268ef6149a3cd924a820f91`。

## 四种不同的权益

| 名称 | 实际含义 | 不能推断什么 |
| --- | --- | --- |
| cloud-space seats | 账号能持有多少云空间 | 不是模型 Token、不是空间余额 |
| collaborator/viewer seats | 空间里可加入的协作者和观察者人数 | 成员席位不等于可替别人扣模型费用 |
| personal credit | 成员个人的平台模型额度 | 不能自动视为团队共享余额 |
| space credit | 某个空间的钱包及成员可用份额 | 总余额不等于当前成员可用余额或实际扣费方 |

客户端 `vAo` 的空间视图包含：`nodeId`、`spaceKey`、`mode`、`balance`、`funded`、`used`、`bonusPct`、`capMode`、周期刷新信息、`me`、`members`、`can`、`recent`。

`me` 里有 `cap/used/remaining/payer/prefer/reason`。模式可为 `personal/space`；上限方式为 `none/fixed/periodic`，周期为 `hour/day`。不能用“钱包余额大于零”替代实际成员鉴权。

客户端区分 `mode_off`、`chose_personal`、`cap_reached`、`space_empty`。页面明确提示：所有者开启空间额度后，成员才可选择优先用空间余额；固定均分和定期均分有不同的份额分配逻辑。

余额保持上游原始整数额度单位，不当作 Token 数量或直接当成美元展示。`bonusPct` 以服务端返回值为准，不把 UI 举例里的比例当作固定权益。

## 已确认的管理 API

这些请求由官方客户端通过 `machinesBaseUrl` 发出，默认继承 relay origin，可由 `MIRASIM_MACHINES_URL` 配置。客户端 `uSn/VY` 使用登录 bearer；不是模型推理设备票据。

| 方法与路径 | 用途 | 本次行为 |
| --- | --- | --- |
| `GET /v2/machines` | v2 可见空间/机器列表 | 已实现只读代理并实测 |
| `GET /v2/machines/seats` | 空间数量 `used/limit/reachable/canAttach` | 已实现只读代理并实测 |
| `GET /v2/machines/{nodeId}/credit` | 空间钱包与当前成员视图 | 已实现，只通过 mock 验证 |
| `PUT .../credit/mode` | 所有者开启/关闭空间支付 | 后续已实现确认式代理，仅 mock 验证 |
| `PUT .../credit/prefer` | 当前成员支付偏好 | 后续已实现确认式代理，仅 mock 验证 |
| `PUT .../credit/caps` | 成员上限与均分 | 已实现确认式代理，仅 mock 验证 |
| `POST .../credit/transfers` | 个人额度转入，带 `credits/ref` | 后续已实现带幂等账本的确认式代理，仅 mock 验证 |
| `GET .../credit/transfers/{ref}` | 查询转入状态 | 后续已实现只读查询，仅 mock 验证 |
| `POST /v2/machines/allocations` | 创建云空间，带 `tier/requestId` | 后续已实现带配额检查及确认的代理，仅 mock 验证 |

UI 对转入提示不可退回、不退款、离开空间后归空间、删除空间时清零；因此不能为了探测而自动转入。此处是客户端提示，不是对服务端退款政策的独立法律判断。

官方桌面列表还会合并 `/v1/machines` 和 `/v2/machines`。本次只读 API 明确返回 v2 数据，不伪装成完整桌面视图。

## 为什么不能只换一个 header 消耗空间额度

`JGr/ypc/_pc`、`zGr.apply`、`managedGatewayRoute`、`gatewayLeg` 的调用链显示：

1. 协作回合带 `userToken`，按回合/会话安装 capability，读取过期时间并安排续期。
2. 执行端设置 `routeViaGateway` 到 `/v2/gateway/model`，使用该 capability 作为 bearer 或对应协议的 API key。
3. 此分支关闭普通设备 signer，和个人 relay 的设备票据、WASM 签名/metadata seal 分支分开。
4. 续期路径是 `/v2/gateway/turn-capability/renew`。回合结束会清理授权，客户端有 `cloud_turn_ended` 的显式拒绝。
5. `x-mirasim-payer` 在响应读取、调用记录中解析为 `space/personal`，不是客户端任意指定一个值即可改变实际扣费方的证据。

因此，把个人 relay 请求加一个空间 ID、复用别人 token、或者把设备票据当 turn capability，都没有证据支持。本次不新增这种假适配，也不绕过成员/回合授权。

真正继续适配，需要用户自己有权使用的空间、有效成员身份、所有者已启用且有余额的钱包，以及从正常官方流程取得的有效回合授权；再验证原生模型路径、流式结束/取消、续期及真实扣费方。必须比对调用前后个人和空间账本，不能只看 HTTP 200 或 `payer` 字段。真实模型调用和额度转入不在本次只读验证内。

## 本次代码

- `src/mirasim-release.js`：默认版本。
- `vendor/mirasim-server.cjs`：完整官方 bundle。
- `src/space-credit.js`：机器列表、数量配额和钱包视图白名单；缺失值保持 `null`，不合成为可用余额；不泄露 `spaceKey`、令牌、成员列表和事件历史。
- `src/dashboard.js`：选定账号的只读查询，401 最多刷新重试一次；不改轮换池额度、账号启用状态或空间设置。
- `src/config.js`：管理 origin 配置。
- `src/server.js`：首次适配提供三个 `/api/cloud/*` GET 接口；继承 Web 控制台会话认证，OpenAI API Key 不能替代控制台登录。后续管理面板与显式确认写操作见文末。
- 查询不会自动附加到 dashboard snapshot，避免每个账号、每次刷新都访问云管理服务。

## 验证与限制

实测时间：2026-10-15 19:39:53（Asia/Shanghai），只选择一个未禁用、已登录账号。

```json
{
  "GET /v2/machines/seats": 200,
  "GET /v2/machines": 200,
  "seats": { "used": 0, "limit": 0, "reachable": 0, "canAttach": true },
  "machineCount": 0
}
```

没有可见空间，因此没有调用空间钱包 GET，更没有调用 model gateway。`canAttach:true` 不能推翻 `limit:0`，也不证明托管云空间有创建配额。

- 定向测试：81/81，通过新版 `--version`、完整 bundle 哈希、既有签名/封装向量、原有鉴权，以及新增只读接口认证、重试、字段白名单和失败边界。
- 全量 `npm test`：1445 项，1435 通过、10 失败。
- 失败涉及图片桥接预期、缺失 `imagesResponseFromChat` 导出，以及原生搜索调用次数预期。在隔离副本中换回旧 0.0.454 bundle，重跑相关三个文件得到 40 项中 30 通过、相同 10 失败；未修改这些无关逻辑。这是旧 runtime 复现，不是假称干净 git 基线的全量测试。
- `node --check vendor/mirasim-server.cjs` 和 `git diff --check` 通过。
- 日志：`analysis/targeted-tests.log`、`analysis/full-tests.log`、`analysis/old-runtime-failures.log`；只读实测报告：`analysis/live-cloud-report.json`。不含登录令牌。
- 已更新磁盘文件；没有重启生产服务、提交或推送。需要重启后运行进程才采用新的模块默认值。

## 复查定位

静态证据来自 DMG 内的 `Resources/server.cjs` 及 ASAR 的 `dist/renderer/assets/index-DaFCwjCT.js`。`analysis/inspect.mjs` 只将 `\\xNN` 字符串转义解码并输出匹配上下文，不执行应用代码。

`analysis/space-credit-module.txt` 中有 `vAo/bAo/wAo/IAo/CAo/SAo/EAo`；`analysis/credit-contract.txt`、`analysis/machines.txt`、`analysis/gateway-contract.txt`、`analysis/gateway-leg.txt` 保存了接口和路由上下文。反混淆定位使用版本内符号名，不应硬编码为下个版本的生产接口。

## 后续适配：移除付费检测、接入空间 turn 传输

手动 Haiku 账号状态检测按钮、前端调用与后端模型探测方法已移除，旧 `POST /api/accounts/:key/status-check` 保留为 410 墓碑路由，不请求模型、不消耗额度。已移除页面对应额度提示。原有定时模型健康检测是另一项功能，本次未删除或改变其配置。

### 已确认的官方协议

- 官方 `Mqt` 执行器将空间模型调用送往管理源的 `/v2/gateway/model` 加原生 `/v1/...` 路径；使用 gateway-role peer 提供的 turn `userToken`，不是个人登录 bearer、device ticket 或自由选择的空间 ID。
- `S9e` 对应 `x-mirasim-client`，值来自客户端版本 `u8()`；它不是执行器密钥。gateway leg 不附加个人 device 签名或封装头。
- capability 更新使用 `POST /v2/gateway/turn-capability/renew`，只有 bearer、无请求体，响应读取 `token`。`HGr` 的提前续期量为 240000ms，`gpc` 的临时错误重试间隔为 30000ms，官方续期请求超时为 10000ms。
- `x-mirasim-payer` 是响应付款方 `space|personal`，不是调用者指定钱包的请求参数。不能据此伪造团队权益或保证从空间扣款。
- 官方代码还有用户/会话/调度 capability ledger。本次没有扫描或导入该账本，没有把发布应用的 capability 端点冒充普通空间推理签发接口。

### 已实现与验证边界

新增 `src/space-gateway.js`，仅在 `MIRASIM_SPACE_GATEWAY=true` 且调用者同时持有本地 API key 与有效官方 turn capability 时，接受扩展请求头 `x-mirasim-space-capability`。本地只解析 JWT 结构与到期时间，授权与签名验证仍由官方 gateway 完成。HTTPS 管理源默认使用已有 relay 源；禁止携带 URL 用户信息、查询串或片段，回环 HTTP 仅用于测试。

转发层复用 Messages / Chat / Responses 现有适配与流式处理，支持原生图片和搜索路由；远端 compact 保持原有禁用状态，不宣称新增支持。续期单飞、身份一致性检查、401/403 中止、临时故障到期拒绝、断开连接取消与 token 清理已有定向测试。响应历史与 GPT cache/session 按本地 key 和初始 capability 隔离；不回退个人登录、不刷新个人凭据、不修改个人配额账本和池冷却。空间 `/v1/models` 只列配置模型，不代表权益验证。付款方来自官方响应并记入请求日志，不记录 capability 原文。

这些是可用 capability 下的传输层实现，不是自动签发或真实空间扣费已打通的证明。当前没有可见空间或有效 turn，尚未执行真实空间推理。下一步须在有权限的真实空间中，通过官方流程取得 turn，完成一次最小推理及余额/成员上限对照；不要在聊天中提交凭据。客户端/服务器端权限、工具、多模态及模型可用性仍以实际官方 turn 权限为准。

定向模拟测试覆盖三类客户端协议 × Claude/GPT/DeepSeek 原生协议 × 流式/非流式的 18 种组合，另有图片、搜索、付款方、历史隔离、错误不回退、取消及旧检测路由边界。所有上游为本地测试桩，不消耗真实额度。日志为 `analysis/space-followup-tests.log`，全量回归为 `analysis/space-followup-full-tests.log`。

- 最终定向测试：244/244 通过，包括新增的续期 403 中断已开始流的集成测试。
- 全量回归：1486 项，1476 通过、10 项原有失败，失败列表仍为前述图片桥接和原生搜索问题；随后补充的一个流中止测试及最终页面提示修改已通过定向回归，未另行重跑全量。
- 修改模块的 `node --check` 与 `git diff --check` 均通过。未调用真实模型，未进行空间资金操作。

补充静态证据：`analysis/turn-manager.txt`、`analysis/space-executor-auth.txt`、`analysis/space-followup-capability.txt`、`analysis/space-followup-renderer.txt`。没有重启生产服务。

## 2026-10-16：前端空间管理与额度读取自动续期

- 账号池新增团队协作空间面板：独立账号选择、按需读取 v2 空间/数量配额/钱包，未知值和零分别显示；切换账号或失败时清空旧钱包，不将错误当成零余额。
- `MIRASIM_SPACE_MANAGEMENT=true` 显式开放创建空间、切换支付模式、设置本人付款偏好和划转。按钮均要求单独确认，写操作要求控制台会话与账号选择身份校验；创建检查数量配额，支付模式/划转检查当前权限，写入前再次核对账号，防止异步期间账号重排导致误划。
- 新模块 `src/space-operations.js`，`space_operations` SQLite 表记录创建/划转 ref、操作指纹与白名单结果。相同 ref 的相同成功操作返回缓存，不再向官方发起写入；不同账号/目标/金额拒绝复用。并发、进程重启、超时及结果未知也不自动重发。查询状态不要求开启写开关。
- 官方 `u1i/A1i` 分配路径为 `/v2/machines/allocations`，载荷 `tier/requestId`；规格 `linux/linux-4c8g/mac`。`SAo` 的静态金额检查解码为最少 1000、步长 100、最多 100000000 原始额度；`mAo` 要求 UUID ref。代码未猜测任何额外签发端点。
- 个人 `/v1/limits` 与空间钱包数据不可读时，HTTP 401、网络/5xx 或数据缺失可触发登录刷新及一次重读；同账号强制续期单飞且五分钟限频。合法零余额、权限拒绝、404/405 或 429 不触发。刷新失败不循环、不补充余额、不延长订阅。额度读取失败不会清除池内先前有效的额度观察。
- 请求管理接口保留配置源的路径前缀；管理写失败不自动刷新后重放，避免重复划款。前端保留原 ref 以查询未知划转。
- 所有新增创建、支付修改、划转和推理均只通过本地模拟验证；没有实际创建空间、划转资金、验证团队钱包扣费或重启服务。自动取得 capability 仍未实现，界面明确提示创建/划款不保证 2api 可用。

补充静态上下文：`analysis/space-automation-management.txt`、`analysis/space-automation-renderer.txt`、`analysis/space-automation-functions.txt`、`analysis/space-automation-extra.txt`、`analysis/space-automation-issuance.txt`。这些是客户端静态证据，不等价于真实服务端写入验证。

本轮验证：最终定向 228/228 通过，覆盖前端按需读取、未知/零余额、确认取消、JSON 请求体、ref 保留、账号变更丢弃旧结果、HTTP 控制台鉴权、管理路径前缀、持久化去重、并发结果未知拒绝重发，以及个人/空间额度读取失败续期与限频。全量回归为 1515 项中 1505 通过，原有图片桥接/原生搜索 10 项失败不变；随后调整操作指纹只包含实际载荷，并补浏览器 UUID 兼容性测试，已由最终定向验证覆盖，未再重跑全量。`node --check` 与 `git diff --check` 通过。日志：`analysis/space-management-targeted-tests.log`、`analysis/space-management-full-tests.log`。

### 2026-10-16：成员额度（caps）实现

- 静态契约来自 `CAo`：载荷为 `capMode`（`none/fixed/periodic`），`periodic` 时附 `refresh`（`hour/day`，缺省 `day`），可选 `resplit`，以及 `overrides` 成员份额表。份额项为 `null`（清除该成员份额）或非负整数值，上限 `x6l = 100000000`；`SAo` 的划转区间解码为最少 0、步长与最多 100000000。响应读取 `view`。
- 新增 `SpaceOperations.caps`：要求 `MIRASIM_SPACE_MANAGEMENT=true`、`confirmed: true`、账号选择指纹与操作期间身份一致，并先读取钱包确认 `can.setCaps`，否则 403。通过 `/api/cloud/credit/caps`（PUT）暴露，控制台会话专用；纳入 `space_operations` 指纹校验，但 caps 不是金额划转，因此不要求 UUID ref。
- 前端新增成员额度模式、定期周期、单人份额覆盖三项控件，写入前单独确认；单人份额非整数或超范围时本地拒绝，不发请求。caps 不是幂等金额操作，重复提交等于再次下发同一分配，界面不做 ref 去重。
- caps 会改变共享额度分配，不是个人余额读取，也不是 2api 推理权益的证明；真实成员扣费仍需有效官方回合验证。
- 新增定向测试：`test/space-operations.test.js`、`test/space-management-http.test.js`、`test/dashboard-ui.test.js` 覆盖载荷、模式与份额校验、权限门禁、未启用写开关、HTTP 路由鉴权与部分 `view` 渲染。全部为本地桩，未调用真实空间接口，未重启生产服务。
