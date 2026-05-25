<p align="center">
  <img src="assets/banner.png" alt="Hermes 多用户 Web 服务" width="100%">
</p>

# Hermes 多用户 Web 服务

<p align="center">
  <a href="https://github.com/SeerBench/hermes-multiuser-web-service/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/Upstream-Hermes%20Agent-blueviolet?style=for-the-badge" alt="Upstream: Hermes Agent"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=for-the-badge" alt="English"></a>
</p>

本仓库是 [Nous Research 的 Hermes Agent](https://github.com/NousResearch/hermes-agent) 的分叉，在 Agent 核心之上增加了**可自托管的多用户 Web 聊天服务**。单后端进程、每用户账号、每用户文件系统沙箱、每用户 30 天滚动 token 配额、SSE 浏览器 SPA。其余部分——Agent 主循环、技能系统、记忆、工具、模型提供商、网关适配器——全部来自上游。

> 上游 Hermes 是单用户 CLI/即时通讯 Agent。本分叉保留这一形态不变，在原有 Telegram / Discord / Slack / api_server 适配器旁边并列加入一个 `web_chat` 网关平台。

---

## 本分叉新增的内容

所有新代码位于 `gateway/web/` 和 `gateway/platforms/web_chat.py` 之内，该范围之外的文件不做修改。

| 组件 | 文件 | 作用 |
|---|---|---|
| 用户账号 | `gateway/web/users.py` | SQLite `web_users.db`——Argon2id 密码、API 密钥（`hermes_sk_…`）、浏览器会话（`hermes_ws_…`）、滚动 token 配额 |
| 鉴权中间件 | `gateway/web/auth.py` | Cookie + Bearer 两种凭据；把 `user_id` 绑定到请求 |
| 每用户沙箱 | `gateway/web/sandbox.py` | 用 ContextVar 隔离每请求的 workspace 和 `HERMES_HOME` |
| 配额闸门 | `gateway/web/quota.py` | 请求前 429 拦截，请求后记录 token，输出 `X-Quota-*` 响应头 |
| Agent 运行器 | `gateway/web/chat_runner.py` | 在 executor 线程内启动 `AIAgent`；与 `api_server.py` 平行实现而非改写 |
| 沙箱化文件工具 | `gateway/web/tools/sandboxed_file_operations.py` | `web_file_read/write/patch/search`——用 `confine_path()` 包装上游文件工具 |
| HTTP/SSE 适配器 | `gateway/platforms/web_chat.py` | `/api/auth/*`、`/api/keys`、`/api/conversations`、`/api/usage`、`/api/chat`（SSE） |

`state.db` 在用户间共享，但通过会话写入层新增的 `user_id` 列实现隔离。记忆（`MEMORY.md`、`USER.md`、Honcho 缓存）则完全隔离——所有记忆 provider 都通过 `get_hermes_home()` 寻路，而沙箱会在每个请求里覆写 `HERMES_HOME`。

---

## 与上游 Hermes 的兼容策略

Hermes Agent 是一个迭代很快的项目。本分叉的设计目标是**长期都能干净地 rebase 到每一次上游发布**。具体做法：

- **子包隔离。** 所有多用户代码都在 `gateway/web/` 包内。仅 `import gateway.web` 不会触碰 Hermes 的其它部分，外部布线零改动。
- **镜像而非改写。** `chat_runner.py` 是 `api_server.py` Agent 工厂的并列实现，不是它的重构。用约 150 行代码的重复换取与上游编辑频率最高的文件之间零冲突。
- **包装而非分叉。** 沙箱化文件工具直接 `import` 并调用 `tools/file_tools.py` 的函数，只在外层加一个 `confine_path()` 校验。上游对文件工具的任何改动都自动生效。
- **走 toolset 而非改核心。** 新工具（`web_file_*`）通过 `toolsets.py` 里专设的 `hermes-web-chat` toolset 注册——这是子包之外唯一的一处编辑。
- **可选依赖、按需安装。** `argon2-cffi` 放在 `[web-chat]` extra 之后，不跑 Web 服务的用户完全不会被强制安装此依赖。
- **不动承重文件。** `run_agent.py`、`cli.py`、`gateway/run.py`、`hermes_cli/main.py` 保持原样。即便这是一个分叉而非插件，仍然遵守 `CLAUDE.md` 关于「插件不得修改核心」的红线。

`gateway/web/` 之外仅有的改动有三处：（1）`toolsets.py` 加一个 toolset 条目，（2）`SessionDB` 的写路径加一列 `user_id`（提交 `2ce65f980`），（3）网关平台枚举里登记 `web_chat`。每处都很小且自包含，即便上游重写了对应文件，也能手动或借助 `git rerere` 重新落地。

实际维护循环就是：`git fetch upstream && git rebase upstream/main`。

---

## 适用场景

| 场景 | 是否合适 |
|---|---|
| 给家人/小团队自托管 Hermes，并希望有带登录的浏览器界面 | 合适——主要用例 |
| 给班级、实验室、学习小组提供私有 Agent 服务，并按用户限流 | 合适——每用户配额 + 沙箱已具备 |
| 在 Hermes 上做 SaaS 形态的 demo | 合适——多用户面已经摆好 |
| 单人个人 CLI / Telegram bot | 不合适——直接用上游 Hermes，本分叉带来的运维负担对你是多余的 |
| 给外部客户端提供 OpenAI 兼容 API | 不合适——请继续用上游 `api_server` 适配器；本分叉的 `/api/chat` 是为 SPA 调优的 SSE，并非 OpenAI 兼容协议 |
| 生产级多租户 SaaS（计费、SSO、RBAC） | 暂不合适——配额仅为 30 天滚动 token，没有计费，也没有团队/组织模型 |

---

## 硬件需求（单机自部署，云端 LLM）

下表假设 LLM 推理走云端（Nous Portal、OpenRouter、OpenAI、Anthropic 等），本机只跑网关进程和每用户 workspace。

|  | CPU | 内存 | 磁盘 |
|---|---|---|---|
| **最低** | 2 vCPU | 4 GB | 10 GB |
| **推荐** | 4 vCPU | 8 GB | 50 GB |

补充说明：

- **CPU。** 聊天链路本身是 I/O 密集（大头是 LLM）。CPU 主要消耗在 SSE 流推送、Argon2id 密码校验（每次约 50 ms）、以及用户触发的本地工具（搜索、文件操作、代码执行）。
- **内存。** Python 进程空载常驻约 300–500 MB；每路并发 Agent 任务再加 50–150 MB，具体看上下文长度和模型。8 GB 内存能舒服地承载 10–20 路并发会话。
- **磁盘。** 代码 + venv 约 2 GB。每用户数据——`web_workspaces/<user_id>/`、会话表行、记忆文件——会随使用增长。50 GB 足够数十名活跃用户用上一年。
- **网络。** 带宽主要被流式 token 占用（一般每轮 50–200 KB）。100 Mbit/s 足以撑起 50+ 路并发流。
- **本地 LLM。** 不在本 README 讨论范围内。如果自托管模型，GPU 大小依模型卡而定；只要推理服务通过网络访问，网关本机仍可维持上面的硬件规模。

---

## 快速开始

```bash
git clone https://github.com/SeerBench/hermes-multiuser-web-service.git
cd hermes-multiuser-web-service
./setup-hermes.sh                              # 创建 .venv 并安装 .[all,dev]
source .venv/bin/activate
uv pip install -e ".[web-chat]"                # 额外装上 argon2-cffi
```

在 `gateway/config.py` 里启用 `web_chat` 平台，并把 LLM 凭据写入 `~/.hermes/.env`，然后：

```bash
hermes gateway start
```

Web 服务监听平台配置块里的端口。用浏览器打开，注册第一个账号，**当场记下创建时只显示一次的 API 密钥**。后续用户可通过同一注册接口加入，或通过 `UserStore` 由管理员侧带外开通。

---

## HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/auth/register` | 创建用户 + 首个 API 密钥 + 会话 cookie |
| `POST` | `/api/auth/login` | 校验密码、下发 cookie |
| `POST` | `/api/auth/logout` | 失效 cookie |
| `GET`  | `/api/keys` | 列出当前用户的 API 密钥（不含明文） |
| `POST` | `/api/keys` | 签发新密钥——明文**仅返回一次** |
| `DELETE` | `/api/keys/{key_id}` | 吊销密钥 |
| `GET`  | `/api/conversations` | 列出当前用户的会话 |
| `GET`  | `/api/usage` | 查看配额当前状态 |
| `POST` | `/api/chat` | Agent 响应的 SSE 流 |
| `GET`  | `/api/healthz` | 公开的健康探针 |

SSE 事件类型：`token`、`tool_start`、`tool_end`、`reasoning`、`done`、`error`。每个 `done` 帧携带 `session_id`、`usage` 和汇总后的 `quota`——无需另开接口轮询。

---

## 安全模型

- **密码。** 由 `argon2-cffi` 提供的 Argon2id 哈希；不存明文，哈希也不可反推。
- **API 密钥 / Web 会话。** 创建时仅返回一次；数据库只存 `sha256(明文)`。即便库被拖走，已签发的密钥也无法被重建。
- **文件系统沙箱。** `web_file_*` 工具的每一个路径参数都会被 resolve，逸出 `$HERMES_HOME/web_workspaces/<user_id>/` 即被拒绝。沙箱在用户上下文之外被调用会直接抛错——**不存在「没沙箱也能跑」的降级路径**。
- **Toolset 白名单。** `hermes-web-chat` toolset 默认**不**包含 `terminal`、`code_execution`、`browser`。要重新启用请按部署环境单独评估威胁模型。
- **LLM 凭据。** 在启动时从 `config.yaml` / `~/.hermes/.env` 读取一次，全部用户共用。按用户的成本归因依赖配额计数器，而非每用户独立的 provider key。

网关本身预期跑在 TLS 终结反向代理（nginx、Caddy、Traefik）后面，监听端口只跑明文 HTTP。

---

## 项目状态

早期阶段。控制面（账号、密钥、配额、沙箱）已就位，对应测试在 `tests/gateway/` 下。React SPA 外壳仍是占位实现——SSE 协议已稳定，但前端仍很简陋。备份与管理工具目前只是脚本 + SQL，独立的管理 CLI 不在当前范围。

跟踪上游变化时，重点关注本分叉触碰过的路径：`gateway/run.py`、`gateway/platforms/api_server.py`、`tools/file_tools.py`、`toolsets.py`。其中任意一个若被大幅重写，本仓库的镜像文件可能需要做对应的同步编辑。

---

## 致谢

上游 Agent 及绝大多数代码：[Nous Research / Hermes Agent](https://github.com/NousResearch/hermes-agent)，MIT 许可。本分叉在其之上加了多用户 Web 服务层，并继承 MIT 许可。

更深层的工程细节请看：`AGENTS.md`（约 1100 行）上游工程指南、`CONTRIBUTING.md`（约 1300 行）上游贡献规范、`CLAUDE.md` 本仓库在 Claude Code 下的工作指引。

---

## 许可证

MIT——见 [LICENSE](LICENSE)。
