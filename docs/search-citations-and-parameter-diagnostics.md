# 搜索引用与参数转发诊断

## 引用

- Responses 原生引用继续保留；补齐仅通过 `response.output_text.annotation.added` 到达的引用聚合。
- Responses → Chat：在 SSE `delta.annotations` 和 JSON `message.annotations` 返回嵌套的 `url_citation`，同时保留原有 Markdown Sources。
- Chat → Responses：转换为 `output_text.annotations`，SSE 同时发送 `response.output_text.annotation.added`。
- Chat → Anthropic：JSON 顶层 `mirasim_annotations`、SSE `message_delta.delta.mirasim_annotations` 为网关扩展，**不是 Anthropic 原生搜索引用**。没有上游搜索结果标识时，不伪造 `encrypted_index`；标准客户端可能忽略扩展，但仍能显示正文 Sources。
- 桥接引用按输出正文的位置重新定位，采用 JavaScript UTF-16 索引，保留同一 URL 的不同引用区间。只接受 HTTP(S) URL 和有效区间；无法表示为连续正文的交错区间不输出结构化引用。
- 思考内容不作为正文引用定位目标。若 `<think>` 拆分改变了正文，相关转换保守省略结构化引用，避免错误高亮；不修改提示词。

## 参数诊断

请求明细的 `parameterDiagnostics` 对比客户端原始 JSON 与网关准备的上游 JSON。控制台「参数转发诊断」显示固定白名单字段的变化：新增、调整、未直传，以及存在关联输出字段。

报告只保存参数名、状态、关联字段名，不复制参数值、提示词、消息、凭据或图片。不存在变化的字段不列出；历史记录没有报告时显示「无已记录的参数变化」。

这不是上游能力探测，也不保证模型实际遵从参数。关联输出字段仅说明可能的协议映射，不保证参数语义等价；未直传可能是本地上下文处理，并不一定意味着功能失效。诊断本身不改变参数处理、模型选择或 system/developer/instructions。

## 验证范围

新增离线测试覆盖双向 Chat/Responses JSON/SSE、Anthropic 网关扩展、原生 Responses 引用、重复 URL、多内容块、emoji、无效区间与 URL、思考拆分、参数报告隐私和 UI 转义。

当前沙箱无法监听本地端口或重启系统服务；本次不包含真实上游联调或部署确认。后端需在允许的环境重启后生效。远程 compact 仍保持弃用，不恢复。

13 个相关测试文件回归通过。另跑 `test/think-tags.test.js`：6 个纯函数测试通过，3 个 HTTP 集成测试因 `listen EPERM 127.0.0.1` 无法运行。
