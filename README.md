# mirasim-2api

把已登录的 [Mirasim](https://mirasim.ai) 账号池，封装成 **OpenAI / Anthropic 兼容的本地 API 网关**，并附带一个 Web 控制台。

- 一个端点同时说三种协议：`/v1/chat/completions`、`/v1/responses`（含 Codex 别名）、`/v1/messages`，可跨协议互转（例如用 Chat 协议调用 Claude，或用 Messages 协议调用 GPT）。
- 多账号池：优先级、均摊 / 榨干 / 纯轮流三种轮询模式、按额度窗口自动跳过、429 自动停靠、失败转移。
- 流式、工具调用、推理（thinking）参数透传、图片生成/编辑、搜索，以及长排队时的协议原生心跳保活。
- Web 控制台：账号池、API Key 管理、用量与 Token 统计、请求明细、模型健康检查。
- 零第三方依赖，仅需 Node.js ≥ 22.5（使用内置 `node:sqlite`）。

> **声明**：本项目是非官方的第三方工具，与 Mirasim 没有隶属关系。请只使用你自己的账号，并自行确认用法符合 Mirasim 的服务条款；账号额度、模型可用性均由 Mirasim 中转服务决定。

## 快速开始

```bash
git clone <this-repo> mirasim-2api && cd mirasim-2api
cp .env.example .env     # 按需修改；.env 已在 .gitignore 中

# 1. 登录 Mirasim（每个账号一个独立目录；邮箱验证码或 GitHub 均可）
MIRASIM_HOME=$PWD/profiles/account-a npm run login -- email
# MIRASIM_HOME=$PWD/profiles/account-a npm run login -- github

# 2. 启动网关（多个账号用逗号分隔）
WEB_AUTH_PASSWORD='换成一个足够长的密码' \
MIRASIM_HOMES=$PWD/profiles/account-a,$PWD/profiles/account-b \
npm start
```

浏览器打开 <http://127.0.0.1:8787/>，用 `admin` 和上面的密码登录控制台，创建一个 API Key（`msk_` 前缀），然后调用：

```bash
# OpenAI Chat Completions
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer msk_你的key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'

# Anthropic Messages
curl http://127.0.0.1:8787/v1/messages \
  -H 'x-api-key: msk_你的key' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

可用模型以 `GET /v1/models` 的实时结果为准；上游目录不可用时，用 `MIRASIM_MODELS=gpt-5,claude-sonnet-4-5` 提供兜底列表。

## 接口一览

| 路径 | 说明 |
| --- | --- |
| `GET /` | Web 控制台（需登录） |
| `GET /healthz` | 健康检查 |
| `GET /v1/models` | 模型列表（需 API Key） |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses，别名 `/backend-api/codex/responses` |
| `POST /v1/messages` | Anthropic Messages，Key 放在 `x-api-key` |
| `POST /v1/images/generations`、`/v1/images/edits` | 图片生成与编辑（是否可用取决于上游权限） |

不会实现 OpenAI / Anthropic 的全部资源，也不会突破上游模型自身的能力与限额。

## 配置

全部通过环境变量配置，完整且带注释的列表见 [`.env.example`](.env.example)。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址。默认只监听本机回环 |
| `MIRASIM_HOMES` | — | 已登录的账号目录，逗号分隔 |
| `WEB_AUTH_USERNAME` / `WEB_AUTH_PASSWORD` | `admin` / 随机 | 控制台登录；不设密码时仅在交互终端打印一次性密码 |
| `WEB_AUTH_SECURE_COOKIE` | `false` | 仅当 HTTPS 在本进程终止时设为 `true` |
| `MIRASIM_DATABASE_FILE` | `~/.mirasim/mirasim.sqlite` | SQLite 路径（账号、Key 哈希、用量、日志） |
| `MIRASIM_ROTATION_MODE` | `spread` | `spread` 均摊 / `waterfall` 榨干 / `roundRobin` 纯轮流 |
| `MIRASIM_REASONING_MODE` | `passthrough` | 推理参数透传；`managed` 启用旧的默认值与下限逻辑 |
| `MIRASIM_MAX_REQUEST_BYTES` | 16 MiB | 请求体上限，最大 64 MiB |

## 安全须知

- **绝不要提交以下内容**（已写入 `.gitignore`）：`.env`、`profiles/` 与 `~/.mirasim/` 下的登录目录（`setting.json` 内是账号 token）、`.runtime/` 与任何 `*.sqlite*` 数据库、日志、`web-password`、`api-keys.json`。
- API Key 仅以 SHA-256 哈希存储；设置了控制台密码后，才会额外保存一份加密副本用于控制台内复制。
- 默认仅监听 `127.0.0.1`。若要对外提供服务，请放在带 TLS 的反向代理之后，设置强密码并开启 `WEB_AUTH_SECURE_COOKIE=true`。
- 请求日志不保留请求正文与凭据。
- 发现安全问题请通过私下渠道报告，不要直接公开 Issue。

## 开发与测试

```bash
npm test                                   # node --test test/*.test.js，全部为离线测试
MIRASIM_HOMES=$PWD/profiles/account-a npm run relay   # 运行内置的 relay CLI
```

测试使用本地桩，不会访问真实上游；离线通过不代表你的账号拥有某个模型或图片能力的权限。

## 项目结构

```
src/        网关实现（协议转换、账号池、中转签名、控制台后端等）
public/     Web 控制台前端
test/       离线测试
docs/       设计说明与逆向/实测记录；reference.md 为完整功能参考
vendor/     Mirasim 官方客户端的运行时包（见下）
```

## 文档

- [docs/reference.md](docs/reference.md)：协议行为、轮询与冷却策略、超时、推理透传、控制台各模块的详细说明
- [docs/search-protocol.md](docs/search-protocol.md)、[docs/image-protocol-and-features.md](docs/image-protocol-and-features.md)：搜索与图片协议
- `docs/mirasim-0.0.*-inspection.md`：各版本客户端的兼容性检查记录

## 关于 `vendor/`

`vendor/mirasim-server.cjs` 取自 Mirasim 官方客户端 `v0.0.516`，提供登录流程与请求签名/加密所需的运行时，本项目的代码并不重新实现这部分。它的版权与许可归 Mirasim 所有，不在本项目许可范围内；请在使用前确认你有权使用和再分发它。

## 许可证

见仓库根目录的 `LICENSE` 文件。
