# Mirasim 0.0.454 静态逆向与协议适配

## 结论和执行边界

2026-10-10 下载并静态分析官方 ARM64 DMG，对照当前已校验的官方 0.0.403 bundle。最明确的协议变化是**平台准入排队的客户端支持**；另外发现共享模型目录增加 Gemini 文本模型、Gemini CLI 的新流解析器，以及 Codex 桌面传输从 MITM 配置改为 egress/redirect。

初次分析阶段未访问真实用户 profile、令牌或生产数据库，没有真实模型调用、权益兑换、服务重启、提交或推送。当时新包的受限 `--version` 验证被工具权限拦截，因此分析与回归阶段保留 0.0.403 runtime。

**后续部署更新（2026-10-10）：用户明确授权执行，并要求“我要上线不要测试”。现已用校验后的完整 0.0.454 bundle 替换 vendor，同步默认客户端版本，保留旧版回退包；按要求跳过新版 CLI 验证及升级后测试。下文的 1421 项回归结果属于更换 runtime 之前，不能视为新版运行验证。** 服务重启结果另见部署记录；静态版本信息和本地 mock 通过均不是线上模型可用性证明。

## 1. 来源、校验与保存位置

工作目录：`.runtime/releases/inspection-0.0.454-2hGGvT/`。

| 产物 | 字节数 / SHA-256 |
| --- | --- |
| DMG | 118564049；`adc7d45bab6f42f8b2e517374b0bd8266f5d3eca22c11b70a99f610957121770` |
| 提取的新 `server.cjs` | 24032918；`c3fb553fc6ba60be2bb4c164661c7a4ab7d9eafc1268ef6149a3cd924a820f91` |
| 保留的官方 0.0.403 `server.cjs` | 22324070；`2cc4c182f3ffc8cda74b7f07f716a0691f8f812701e1fb24aaac6f36c29d2d99` |
| 新旧内嵌 WASM | 88281；两者均为 `fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95` |

来源：
- https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.454/Mirasim-0.0.454-arm64.dmg
- https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.454/SHA256SUMS

DMG SHA-256 与清单对应条目一致。Info.plist 的 `CFBundleVersion` / `CFBundleShortVersionString` 均为 `0.0.454`。这不等同于独立验证发布者签名或 macOS notarization。

采用系统 7-Zip 25.01 arm64，仅提取三个普通文件：Info.plist、server.cjs、app.asar。APFS 提示尾部有 3072 字节额外数据；选定文件提取成功，未挂载或启动应用。ASAR 用独立目录里的 Python 脚本以 `python3 -I` 读取，检查路径、大小及内嵌 SHA-256，解析出 268 个文件，内容共 18362923 字节。

- 原包：`download/Mirasim-0.0.454-arm64.dmg`
- 校验清单：`checksums/SHA256SUMS`
- 提取文件：`extracted/Mirasim.app/Contents/Resources/`
- ASAR 数据：`asar/`
- 文件偏移/大小/哈希：`analysis/asar-manifest.json`
- 旧源码、原有工作区差异和 bundle 备份：`baseline/`

新旧 WASM 字节相同、现有提取匹配仍能定位 payload、公钥字符串保持不变，均通过静态对照确认。未实例化新包代码或其 WASM。

## 2. 新版排队机制：不是简单延长超时

以下为 **客户端代码确认**，非对服务端内部实现的猜测。

### 2.1 三种不同状态

1. **请求已发送，尚无响应头**：可能排队，也可能连接、鉴权或计算等待，不能只凭沉默认定已入队。
2. **平台准入被拒绝**：HTTP **503**，带非空 `x-router-queue-class` 或解析错误码 `platform_queue_full`。不是本协议的 429 分支。
3. **账号/模型错误**：额度、权限、模型容量、平台故障分别处理；老的 `model_capacity_exhausted` 不自动等同于新增的 `platform_queue_full`。

可选响应头：

| 字段 | 含义与约束 |
| --- | --- |
| `x-router-queue-class` | 服务端提供的队列分类；客户端不枚举固定取值 |
| `x-router-queue-cause` | 客户端仅识别 `refused` |
| `x-router-queue-position` | 有限、非负数字，向下取整；缺失不是 0 |
| `x-router-queue-eta-ms` | 同上，单位毫秒；估计值不是保证 |
| `x-router-throttle-wait-ms` | 已有等待观测头；不是本地推算值 |

UI 把 `queue + cause=refused + 无 position` 显示为 **BUSY**，说明为“当前无空位、也无队列可等，自动重试”。因此不能向用户声称这种响应已经预留了一个 FIFO 位置。

### 2.2 官方 hold/resend

新版针对经 relay 的模型调用，在完整读完拒绝体、未取消且命中上述 503 条件时：
- `Retry-After` 取第一个逗号分隔部分，接受正有限数字秒；默认 5 秒，最少 1 秒、最多 60 秒。HTTP-date、0、负数或无效值回退 5 秒；此分支不读取 `retry-after-ms`。
- 从第一次 hold 开始计算 240 秒预算；下一次等待不能超出预算。初始请求等待及进行中的上游调用不完全纳入这一判断，因此它不是严格的整请求四分钟墙钟上限。
- 取消会终止等待；没有专为队列执行的账号轮换，每次重发重新解析正常路由。
- 每次重发生成新的上游 call ID，UI 保留同一逻辑请求 ID。不能据此推断服务端保存原队列位置或去重预留。
- 标记 `queueHeld` 的拒绝不累积账号故障、额度耗尽或上游失败事件。
- 队列预算耗尽后通常返回最后的 503；普通 503 的内部分类本身不是通用自动重试许可。

### 2.3 新增 readout API

客户端新增正常鉴权的 `GET /v1/queue?call=<当前尝试ID>`，用于观察而非声明本地队列：
- 首次 2.5 秒后查询，单次 10 秒超时；之后默认 5 秒，`next_poll_ms` 限制在 1–10 秒。
- 状态为 `none`，或 `waiting` 且 `kind` 为 `queue` / `throttle`。
- 可选 `eta_ms`、`waited_ms`；queue 可带 `position`、`class`、`cause:refused`、`retry_in_ms`。
- 404/405 暂停这一查询能力 10 分钟；主调用收到响应头便停止查询。
- UI 事件包括 `sent/readout/held/resent/released/answered`，只是客户端生命周期，不等于服务端调度算法。

本轮网关**未自动启用轮询**，避免增加未实测的鉴权请求和额外负载。

### 2.4 已有 failure header 与新增禁止重试信号

`x-router-failure` 在旧版已经存在，分类为 `request/auth/entitlement/quota/throttle/capacity/outage/cancelled`，scope 为 `request/model/account/platform`。它不是 0.0.454 新协议。不要把 capacity/throttle 都当账号额度耗尽。

新版本地 `cloud_unavailable` 从旧版的 422 permission_error 改为 503 api_error，并带 `x-should-retry:false` 和可选 Retry-After。**没有 queue 标记的这个 503 不是排队许可**，重试禁令应保留。

## 3. 不同用户调用有哪些区别

### 3.1 套餐与调用资格

新版 UI 明确列出下表；未取得旧 renderer 对照，因此这是**当前 UI 证据**，不是全部都在本版本新增。

| 内部 plan | 展示名 | UI 中的模型范围 |
| --- | --- | --- |
| `none` | FREE | BYOK；不列平台模型集 |
| `go` | Go | Kimi / DeepSeek / GLM；设置页明确不含 Claude / GPT |
| `basic` | Basic | Claude / OpenAI / Kimi / DeepSeek / GLM |
| `plus` | Pro | 同上，使用量等级不同 |
| `max` | Max | 同上，使用量等级不同 |

不能从 UI 推断具体 RPM、Token 预算、并发槽位或优先级。账户已有 plan 但当前不被服务时，客户端仍可显示 `cloud_plan_not_served`；有套餐不意味着所有模型现在可用。

UI 将 throttle 描述为 “Free plan pacing”，但这不能证明服务端严格按 JWT `none` 字段执行，也无法得出免费用户具体每分钟请求数。

### 3.2 本地 API Key 不是上游套餐

当前网关：
- 控制台管理员、推理 API Key、Mirasim 上游账号是不同身份。
- 所有有效推理 Key 共享一个账号池，没有每 Key 独立付费套餐、账号分配、并发配额或公平队列。
- 因而两个本地用户可能消耗同一个上游额度，也可能因轮换使用不同上游账号。
- Responses 历史及稳定 relay 会话已有按调用方和模型隔离。本轮进一步将通用账号 affinity 绑定到 API Key 的记录 ID，避免相同 system/首消息让两个用户互相影响选账号。
- 此前的问题是**路由耦合**，并未证实会话内容泄漏。本轮也不把共享账号池改称“独立用户额度”。

实际排队速度还受模型、账号资格、已用额度、请求上下文和服务端容量影响。没有真实账号对照实验，无法判断不同套餐的实际等待分布。

## 4. 其他新特性与协议稳定项

| 观察 | 证据与处理 |
| --- | --- |
| 共享 fallback 模型表增加 `gemini-3.1-pro-preview` | contextWindow=1048576；独立 Gemini CLI 列表旧版已有此模型，不能说模型本身新出现 |
| 新增 Gemini 本地 CLI stream-json driver | 解析 init/message/tool_use/tool_call/tool_result/result；映射文本、工具、usage。属于本地 CLI 输出，不是新 relay SSE API |
| Codex 传输配置改为 egressTarget | 新值 `https://chatgpt.com`；旧 MITM/proxy/CA 配置移除。旧的图片/search/compact 字面路径重写因此消失，不代表服务端删除这些接口 |
| relay agent 表 | 仍有 claude/codex/pi/dsh/zcode/kimi，没有可据以确认的 Gemini 独立 relay agent |
| 主要协议转换器 | 对应区域的 3856 个属性/比较/case token 序列相同；这仅说明未检测到字段/事件词汇变化，不是所有控制流完全等价的形式证明 |
| Gemini 图片桥接 | 新旧 bundle 及主要 ASAR 资源均未找到现有测试中的 Gemini 图片模型及请求字段，不能为了测试变绿就猜测 Codex Chat 路由 |

因此本轮保留已有图片、搜索、三协议转换边界，不盲目新增 Gemini 图片别名，不恢复已退役的 standalone compact，也不把目录存在视作真实模型调用成功。

## 5. 本轮已实现的兼容性改进

1. 新 `src/relay-queue.js`：有界读取队列头、识别显式 503 准入拒绝、按数字 Retry-After 计算等待，并在断连时立即解除等待。
2. `src/server.js`：显式平台拒绝优先保留当前账号，等待后通过现有 pool 再检查账号是否仍可选，不立即扫全账号池；不记账号 cooldown。最多 20 次准入拒绝，并受现有请求 deadline 与从预算创建开始计算的 240 秒上限约束，**比官方 hold-only 预算更严格**。普通容量故障仍保留原有策略。
3. 有显式队列证据但拒绝体未完整读完的 503 不进入队列重发；普通超大/停滞 503 保留已有有界 failover。队列错误同时支持 JSON 和首条 SSE data JSON；`x-should-retry:false` 终止重试并保留响应头。
4. `src/request-log.js`：每次尝试仅在实际收到队列头时添加 `queue`，不保存凭据、不编造位置和 ETA。上游字节与客户端心跳继续区分。
5. `src/queue-keepalive.js`：响应 `write(false)` 后等 drain，不继续积压心跳；停止/关闭/错误时清理定时器及自身监听器，保持三协议错误格式。
6. `src/pool.js` / `src/server.js`：固定单次请求重试期间的 rotation mode；不同 Key 的通用 affinity 分离；刷新等待结束后先检查客户端是否已断连。
7. `package.json`：测试入口显式 `test/*.test.js`，避免 Node 自动递归扫描历史 DMG 提取目录、符号链接和源码备份。

上述协议适配阶段没有对身份头伪装、授权绕过或签名算法新增修改，当时没有替换 0.0.403 runtime；后续按用户明确要求升级完整 bundle，见开头部署更新。

## 6. 验证结果

- 新鲜基线：Node 22.22.3，网络 namespace 仅开启 loopback，显式选择项目测试：**1339 项，1329 通过，10 失败**。
- 10 个既有失败：5 个未实现 Gemini 图片路由用例、1 个图片 helper 缺失导出导致的测试模块失败、4 个 native-search 引用断言失败。保留这些测试和现有在途工作，未删断言或编造上游能力。
- 初次测试尝试因清理 PATH 后选到系统 Node 20、自动发现遍历旧 `.runtime` 符号链接而失败；修正 Node 路径、测试范围后才得到上述有效基线。
- keepalive 新单元测试：42/42；queue 协议新单元测试：24/24；既有 timeout/disconnect 回归：54/54。
- 全量最终回归：同一 Node 22.22.3 和仅 loopback 的网络环境，`npm test` 共 **1421 项，1411 通过，10 失败**；失败项与新鲜基线一致，新增 82 项全部通过。全量命令仍以 exit 1 结束，不能称为全部通过。日志：`analysis/final-tests-2.log`。
- 路由集成：15/15，通过真实 loopback HTTP/SSE 配合模拟上游，覆盖不同 Key 的 affinity、请求内轮换模式快照、队列重发、三协议断连取消、重试预算和禁止重试响应头。
- 首次改动后全量回归曾出现 2 项新增失败：普通超大/停滞 503 的已有 failover 被过宽的“不完整拒绝体不重发”条件阻止。现已把该条件收窄至显式平台队列拒绝；最终回归无新增失败。
- `git diff --check` 及 `src/server.js`、`src/relay-queue.js`、`src/pool.js` 的 Node 语法检查通过。vendor 的 SHA-256 保持原值，DMG 与官方清单再次核验一致。
- 新包执行验证：初次被权限机制阻止；之后用户明确授权并要求直接上线、不测试。现已安装完整 0.0.454 vendor，但未执行独立 `--version`、固定向量或升级后回归验证；以上测试数字均基于安装前的 0.0.403 bundle。

## 7. 静态证据索引

均为零基 UTF-8 字节偏移，针对上面的精确哈希文件；不是行号。

| 内容 | 0.0.403 bundle | 0.0.454 bundle / 资源 |
| --- | --- | --- |
| queue admission parser / headers | 未找到对应符号 | 943758–944950 |
| hold/resend | 未找到对应符号 | 944919–947330；956328–957781 |
| queue readout / polling | 未找到 `/v1/queue` | 939703–943740 |
| queueHeld 不计故障/额度 | 无此新标记 | 1226660；1344623；16172975 |
| x-router-failure | 1206460–1209820 | 1343480–1346750 |
| cloud_unavailable 错误形状 | 20800–21250 | 19545–20365 |
| agent table | 862750–863670 | 1010880–1011815 |
| 共享模型目录新增 Gemini | 875525–877005 | 1023995–1025589 |
| Codex 传输配置 | 878474 | 1026928–1027022 |
| Gemini 本地 driver | 无对应 driver | 648120–655440 |
| 主要协议转换区域 | 2647096–2780646 | 2824771–2958420 |
| 套餐 UI | 未比较旧 renderer | `index-DJx0CZk4.js` 3343029；`settings-modal-DpU-RqgT.js` 140420 |
| BUSY/Free pacing 文案 | 未比较旧 renderer | `index-DJx0CZk4.js` 118634–119430；2201695 |

## 8. 直接部署记录（2026-10-10）

- 用户明确要求直接上线、不运行测试；本阶段未执行测试、独立 CLI 验证或真实模型探测。
- 已备份原 vendor：`.runtime/releases/deploy-0.0.454-g4kykaf7/server-0.0.403.cjs`。
- 已原子替换完整 0.0.454 vendor，安装后 SHA-256 为 `c3fb553fc6ba60be2bb4c164661c7a4ab7d9eafc1268ef6149a3cd924a820f91`；默认客户端版本、示例配置和相关测试版本断言已同步。固定签名向量保持不变，未运行这些测试。
- 当前部署使用 `mirasim-2api.service`，工作目录为本仓库，已有进程监听 `0.0.0.0:8787`。重启入口无测试 hooks。
- 尝试执行 `systemctl restart mirasim-2api.service` 时，权限机制要求用户明确点名该服务及重启动作，命令未执行。因此文件安装已完成，**服务尚未由本次部署重启，不能宣称新版已上线**。未尝试其他途径绕过重启限制。

## 尚不能下结论的部分

服务端 FIFO/权重/公平策略、账号/模型/平台槽位数量、套餐数值配额、取消是否即时释放服务端位置、重发是否保留排序，以及当前线上实际成功率，均不能从客户端静态包或 mock 测试证明。需要另行确认账号、次数及费用预算后进行有界真实测量。
