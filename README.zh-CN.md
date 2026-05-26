<p align="center">
  <a href="README.md">English</a> · <b><a href="README.zh-CN.md">中文</a></b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/上游-Hermes%20Agent-blueviolet?style=for-the-badge" alt="Upstream: Hermes Agent"></a>
  <a href="https://github.com/QuantumNous/new-api"><img src="https://img.shields.io/badge/上游-new--api-2496ED?style=for-the-badge" alt="Upstream: new-api"></a>
</p>

# Hermes 多用户 Web 服务

**基于 [Nous Research 的 Hermes Agent](https://github.com/NousResearch/hermes-agent) 构建的自托管多租户聊天 UI,认证与计费委托给上游 OpenAI 兼容网关(例如 [new-api](https://github.com/QuantumNous/new-api))。** 终端用户粘贴管理员在上游网关签发的 API key;返回的浏览器 Cookie 携带该 key 加密存储,后续每次 LLM 调用都由上游按 key 计费。一个 Python 进程为任意数量的用户提供完全隔离的对话、记忆和文件系统工作区。

这是 Hermes 上游的一个 **fork**,不是重新实现。Agent 主循环、技能系统、记忆 provider 栈、模型 provider 插件、25+ 个 gateway 适配器,全部直接来自上游,**一行未改**。我们新增的是一个 gateway 平台(`web_chat`)、配套的多租户隔离原语、以及对接 new-api 风格上游的薄薄一层胶水代码 —— 全部以**让 `git pull upstream main` 永久零合并冲突**的方式打包。

```
┌──────────────────────────────────────────────────────────────────┐
│  浏览器 SPA  ──Cookie(hermes_session)──▶  gateway:8643          │
│                                                  │               │
│                       ┌──────────────────────────┘               │
│                       ▼                                          │
│   auth:  Cookie → user_id + 解密后的上游 API key                 │
│   绑定:  enter_user_context(user_id), enter_upstream_key(key)    │
│                       │                                          │
│                       ▼                                          │
│   AIAgent(上游 Hermes)运行于 loop.run_in_executor               │
│         │                                                        │
│         ├─ 工具:web_search、memory、todo、skills、web_file_*    │
│         │                                                        │
│         ▼                                                        │
│   new-api 网关 ──Bearer(用户的 key)──▶ OpenAI / Anthropic /     │
│   (负责计费、限速、key 管理)              任何 LLM provider      │
└──────────────────────────────────────────────────────────────────┘
```

`new-api` 是我们的参考实现,但任何 OpenAI 兼容的计费网关都能用 —— 只要它支持 `GET /v1/models`(用于 key 验证)和 `POST /v1/chat/completions`(用于推理)。One API、Helicone、LiteLLM proxy、贵司内部网关都可以。

---

## 为什么这样切分?

在每一个聊天前端上再造一套用户管理 + token 计数 + Stripe 集成的栈,是浪费工程精力。new-api(以及它的生态)已经把这件事做得比任何业余项目都好。所以这个 fork 把职责收窄:

**Hermes 提供** agent 主循环、工具、技能、记忆,以及 SSE 流式聊天的服务端。
**new-api 提供** 用户账号、API key、按 key 计量、计费、模型路由、限速。
**这个 fork** 是中间的桥 —— 一个多用户聊天前端,用户用 new-api 的 key 认证,LLM 调用通过 new-api 路由。

具体来说,fork 自己还做的事情:

- **按用户的对话历史**(Hermes session DB 按 `user_id` 过滤)
- **按用户的记忆**(`MEMORY.md`、`USER.md`、所有 provider 缓存,全部按工作区隔离)
- **按用户的文件系统工作区**,位于 `$HERMES_HOME/web_workspaces/<user_id>/`
- **沙箱化文件工具**(`web_file_*`),镜像上游 `read_file` / `write_file` / `patch` / `search_files`,但拒绝任何越出用户工作区的路径
- 新的 gateway **HTTP 适配器**(`gateway/platforms/web_chat.py`),端口 8643,Cookie 鉴权,SSE 流式
- 极简的 **React SPA**(`web-chat/`)—— 65 KB gzipped JS,**不引入** UI 框架、router 库、状态管理库
- **静态加密的 key 存储**(服务端主密钥 Fernet 加密),首次登录粘贴一次就够了 —— 不用每次开浏览器都重新输入

以及 fork 不再做的事情(因为跟 new-api 重复):

- ❌ 不再支持邮箱/密码注册。**没有注册端点。**
- ❌ 不再签发 API key。Key 由 new-api admin 面板生成,这个 gateway 只验证它们。
- ❌ 不再有本地配额。计费和限额都在上游。
- ❌ 不再依赖 `argon2-cffi`。没有密码需要哈希了。

作为工作区锚点的 user_id 由 `sha256(api_key)[:12]` **派生** —— 确定性、不可逆。同一个 key 在任何浏览器任何机器上都映射到同一个 user_id,所以用户在哪儿登录都能看到同一份对话历史。不需要中央用户表 —— new-api 是唯一的身份来源。

---

<a id="screenshots"></a>
## 界面截图

> ⚠️ 下面的截图是 new-api 集成**之前**拍的,还显示已经被删除的邮箱注册流程和按用户配额面板。当前的登录是一个一次性 API key 输入模态框,用户首次点 Send 时弹出。新截图在 roadmap 上;流式对话那张图大体仍然准确。

<table>
  <tr>
    <td width="100%" valign="top">
      <a href="assets/screenshots/03-chat-streaming.png"><img src="assets/screenshots/03-chat-streaming.png" alt="SSE 流式对话 + 工具事件" /></a>
      <p><sub><b>SSE 流式对话 + 工具事件。</b>SSE token 帧增量渲染;工具调用(此处 <code>web_search</code>)inline 显示一行,带 preview + 时长。当前版本顶部已经没有配额 badge —— 计费交给 new-api 了。</sub></p>
    </td>
  </tr>
</table>

---

## 上游兼容性 —— 项目最核心的设计决定

这是关于本项目最重要的一件事。我们坚持一条严格的规则:

> **宁可代码冗余、宁可啰嗦,也不动上游文件。**

死掉的 fork 都是一种:悄悄改写了上游一半,然后半年都 merge 不了任何更新。我们拒绝做那种 fork。具体来说:

| 策略 | 用在哪 | 为什么有效 |
|---|---|---|
| **子包隔离** | 所有多租户代码住在新目录 `gateway/web/`、新文件 `gateway/platforms/web_chat.py`、新目录 `web-chat/` 下。 | 这些路径上游不存在,`git pull` 永远不会碰它们。冲突概率:0。 |
| **镜像,不重构** | `WebChatAgentRunner`(`gateway/web/chat_runner.py`)是 `api_server.py` 的 `_create_agent` / `_run_agent` 的 ~150 行平行实现。我们不把 api_server.py 重构成跟我们共享代码。 | api_server.py 是上游编辑最频繁的 gateway 文件。任何共享模块都会变成永久的合并冲突源。冗余只付一次,合并冲突会反复发生。 |
| **包装,不分叉** | `web_file_read` / `write` / `patch` / `search` 通过上游 `read_file_tool` / `write_file_tool` 等的公共函数签名调用,只在前面加一层 `confine_path` 校验。我们不分叉 `tools/file_operations.py`(~2k LOC)或 `tools/file_tools.py`。 | 上游可以自由重构工具内部。只有公共函数名对我们重要,而它们多个版本以来都没变过。 |
| **上游文件里只做外科手术式的 bug 修复** | 少量小 B 类改动:`run_agent.py:517` 和 `agent/conversation_compression.py:391`(各 1 行 —— 把 `user_id` 传给 SessionDB 写入);`gateway/run.py` 的 `_create_adapter` 加一段 `elif Platform.WEB_CHAT`,`_resolve_runtime_agent_kwargs` 末尾加一段 `NEW_API_BASE_URL` 覆盖;`hermes_state.py` 两个查询方法加 `user_id` 参数;`hermes_cli/config.py` 的 `OPTIONAL_ENV_VARS` 加一条 `NEW_API_BASE_URL`。全部是 bug 修复或追加参数,**默认行为完全不变**。 | user_id 传播确实是真的多租户 bug,我们计划作为 PR 推回上游。NEW_API_BASE_URL 块是一个小运维 hook。冲突点都是秒级可解。 |
| **可选 extra** | `cryptography` 在 `[web-chat]` extra 里,不在 core。安装时不带这个 extra,适配器启动会带着清晰的安装提示拒绝运行。 | 不给从不跑 web 服务的用户增加 base 安装体积。 |

**我们刻意不动的文件**,即便有时绕开会更费力:

```
gateway/platforms/api_server.py    0 行改动
tools/file_operations.py           0 行改动
tools/file_tools.py                0 行改动
tools/terminal_tool.py             0 行改动
agent/memory_manager.py            0 行改动
cli.py                             0 行改动
hermes_cli/main.py                 0 行改动
```

记忆隔离不通过改 `memory_manager.py` 实现 —— 我们通过 ContextVar 重定向 `HERMES_HOME`。所有 memory provider 都已经在读 `get_hermes_home()`,所以重定向自动在每一层生效。每请求的上游 key 注入也用同样的 ContextVar 套路绑定 `api_key`。

维护循环:`git fetch upstream && git rebase upstream/main`。如果发生冲突,只会落在那几个具名 patch 上。

---

## 这个 fork 适合你吗?

| 场景 | 适配度 |
|---|---|
| **给小团队 / 社区 / 家人自托管聊天 UI**,身份和计费交给 new-api(或类似服务) | ✅ 核心用例 —— 这**就是**这个项目 |
| **已经跑了 new-api / One API / LiteLLM**,想要一个比自带前端功能更全的聊天界面(真实工具、记忆、技能) | ✅ 即插即用 —— `NEW_API_BASE_URL` 指向你的网关,粘贴用户现有的 key 即可 |
| **替代 OpenAI / Claude 作为"N 个人共用的私有 AI"**,每个人有独立的使用额度 | ✅ 专为此设计 —— new-api 按 key 计量,这个 UI 把那一切呈现给浏览器用户 |
| **公司内部工具**,反向代理 + 代理层 SSO | ✅ 上游加 TLS + SSO;Cookie 只看守聊天界面这一层 |
| **实验室 / 学习小组 / 课堂**,要每用户独立历史、记忆,(通过 new-api)按用户上限 | ✅ 隔离层很扎实;上限交给 new-api 强制 |
| **要做带付费计划的 SaaS 产品** | ⚠️ new-api 已经处理计费,但你还得自己加营销页 / Stripe 结账 / 注册流程的前端 |
| **单人 CLI / 本地开发工具** | ❌ 直接用上游 Hermes。`hermes` 和 `hermes dashboard` 满足你,无需多租户的运维开销 |
| **给外部应用做 OpenAI 兼容 API**(Open WebUI、LibreChat、OpenAI SDK) | ❌ 让它们直接打你的 new-api 网关。或用上游 Hermes 的 `api_server` 平台 |
| **让不可信用户跑任意 terminal 命令** | ❌ 工具错了 —— 见"安全模型"。Web 沙箱防意外路径穿越,不防内核漏洞 |

---

## 硬件配置参考

数字假定上游 LLM 是**云托管**的(通过 new-api 路由到 OpenAI / Anthropic / Nous Portal / OpenRouter / 自有 provider)。瓶颈位置随机型变化:

| 档次 | RAM | CPU | 同时活跃 agent | 同时在线 SPA 用户 | 最先碰到的瓶颈 |
|---|---|---|---|---|---|
| **2c / 4 GB** | 4 GB | 2 vCPU | 10–15 | 80–150 | new-api 限速或上游 LLM |
| **4c / 8 GB** ⭐ | 8 GB | 4 vCPU | 25–40 | 200–300 | new-api / LLM + SQLite >5 RPS |
| **8c / 16 GB** | 16 GB | 8 vCPU | 60–100 | 500–1000 | SQLite —— 该迁 Postgres 了 |
| 更大 | — | — | — | — | 不再是单机部署 —— Postgres + Redis + 多 worker |

磁盘:venv + 代码约 2 GB,然后按用户数据随使用增长。

**"活跃"** = "此刻正在 agent loop 中"。用户在读助手回复或在打字,是**在线**但**不活跃**。典型聊天场景活跃:在线比例大概 1:5 到 1:10。

实践观察:

- **并发活跃 agent 不再被一个共享上游 key 限死**。每个用户有自己的 new-api key + 自己的配额,所以上限是 new-api(或底层 provider)对单 key 的限速 × N 用户。
- **上下文压缩**是 CPU 尖峰,短暂会让 RSS 翻倍。多个用户同时压缩可能瞬时把 4 GB 撑爆。`WEB_CHAT_MAX_CONCURRENT_AGENTS`(默认 12)是安全阀。
- **SQLite 在持续 ~5 RPS 以下完全没问题**。WAL + jitter 重试足以扛突发。再高就要迁 Postgres。

---

## 快速上手

```bash
# 1. Clone + base 安装
git clone https://github.com/SeerBench/hermes-multiuser-web-service.git
cd hermes-multiuser-web-service
./setup-hermes.sh                                 # uv venv + .[all,dev]
source .venv/bin/activate
uv pip install -e ".[web-chat]"                   # 装上 cryptography(用于 KeyVault)

# 2. 指向你的 new-api(或其它 OpenAI 兼容网关)
echo "NEW_API_BASE_URL=https://your-new-api.example.com" >> ~/.hermes/.env

# 3. 在 ~/.hermes/config.yaml 启用平台
cat >> ~/.hermes/config.yaml <<'YAML'
platforms:
  web_chat:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8643
      max_concurrent_agents: 12
      cookie_secure: false             # 生产环境务必改为 true(HTTPS)
      cookie_ttl_seconds: 604800       # 7 天
YAML

# 4. 构建 SPA(一次性,约 50 MB node_modules)
cd web-chat && npm install && npm run build && cd ..

# 5. 在 new-api admin 面板:创建用户、签发 API key,把 key
#    通过外部渠道(邮件、Slack 等)发给对应的终端用户

# 6. 启动
hermes gateway run
```

浏览器打开 `http://127.0.0.1:8643/`。聊天 UI 已经直接可见 —— 输入消息按 Send。这时弹出模态框要 API key,粘贴管理员发给你的那把。返回的 Cookie 有效期 7 天,后续访问直接进聊天。

**生产部署**:gateway 前面接 TLS(Caddy / nginx / Traefik),`cookie_secure: true`,然后才可以改 `host: 0.0.0.0` —— 跳过 TLS 直接监听公网,适配器会**拒绝启动**。完整 checklist 在 [`docs/user-guide/web-chat.md`](docs/user-guide/web-chat.md)。

---

## HTTP 接口

唯一的鉴权方式是 `hermes_session` Cookie,由 `/api/auth/login` 签发。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/api/auth/login` | 无 | 用 new-api key 向上游验证,通过则签 Cookie |
| `POST` | `/api/auth/logout` | Cookie | 失效 Cookie + 删除服务端 session 行 |
| `GET`  | `/api/me` | 有 | 当前 `user_id` + 首次/最近登录时间 |
| `GET`  | `/api/conversations` | 有 | 列出该用户的 session(按 `user_id` 过滤) |
| `POST` | `/api/chat` | 有 | **SSE 流式** agent 响应 |
| `GET`  | `/api/healthz` | 无 | 健康探针 |
| `GET`  | `/static/*`, `/assets/*` | 无 | SPA 静态资源 |
| `GET`  | `/` | 无 | SPA shell |

没有 `/api/auth/register`、没有 `/api/keys/*`、没有 `/api/usage` —— 那些都在 new-api 那边。

### `POST /api/auth/login` 验证流程

```
{ "api_key": "sk-..." }
        │
        ▼
GET {NEW_API_BASE_URL}/v1/models     Authorization: Bearer sk-...
        │
        ├─ 2xx                 → 派生 user_id = "u_" + sha256(key)[:12]
        │                        upsert 用户行,Fernet 加密 key,签 Cookie
        ├─ 401 / 403           → 返回 401  code=invalid_key
        ├─ 其它 4xx            → 返回 502  code=misconfigured
        └─ 5xx / 429 / 网络异常 → 返回 503  code=upstream_unreachable
```

### SSE 事件协议(`POST /api/chat`)

| event | data | 何时发出 |
|---|---|---|
| `token` | `{"text": "..."}` | 助手 token 增量 |
| `tool_start` | `{"tool": "...", "preview": "..."}` | 工具调用开始 |
| `tool_end` | `{"tool": "...", "duration": 1.2, "error": false}` | 工具调用返回 |
| `reasoning` | `{"text": "..."}` | 模型 reasoning 文本(provider 决定) |
| `done` | `{"session_id": "...", "usage": {...}}` | 最终帧 |
| `error` | `{"message": "...", "code": "..."}` | 流中致命错误 |

会话中遇到 401(Cookie 过期或主密钥被轮换),SPA 重新弹出 key prompt,用户重新输入 key 后自动重发原消息。

---

## 多浏览器行为

因为 `user_id = sha256(api_key)[:12]` 是确定性派生的,同一把 key 在任何浏览器都映射到同一个 user_id → 同一份工作区 → 同一份对话历史。

| 场景 | 行为 |
|---|---|
| B 浏览器用 A 用过的同一把 key 登录 | B 的对话列表里能看到 A 创建的所有 session |
| B 重新打开 A 之前的 session | 完整历史可见 |
| A 创建新 session 时,B 已经开着列表页 | B 需要刷新才能看到(无实时推送) |
| A、B 都打开同一个 session,A 发了消息 | A 看到流式 token;B 刷新后才看到新一轮对话 |
| A、B 同时往同一个 session 发消息 | SQLite 写锁串行化;UI 不会自动同步 |

实时跨浏览器推送在 v0.15 中未实现。同步级别是 refresh-level。

---

## 安全模型

**默认隔离的**:

- **对话** —— `sessions.user_id` 过滤每个 `list_sessions_rich` / `search_messages` 调用。
- **记忆** —— `enter_user_context` 通过 ContextVar 重绑 `HERMES_HOME`;`MemoryManager` 和所有 provider 都读 `get_hermes_home()`,自动写到 `web_workspaces/<user_id>/memories/`。零侵入 —— 不改任何 agent 内部代码。
- **文件系统(工具)** —— `web_file_*` 把每个路径过 `confine_path`,越界拒绝。V4A 多文件 patch **直接拒绝**,因为它内部的文件路径没办法在不解析 V4A 格式的情况下被校验。
- **上游 API key** —— 用 Fernet 加密存储,主密钥在 `$HERMES_HOME/web_users_master.key`(权限 0600,首次启动自动生成)。请求时在内存解密,**绝不写日志**。通过任务级 ContextVar 注入到 AIAgent 的 LLM 客户端,并发请求之间永远看不到对方的 key。
- **Cookie session** —— `HttpOnly` + `SameSite=Lax` + 可选 `Secure`;服务端 `web_sessions` 表有行,登出立即吊销该行(不只是 Cookie 过期)。

**默认不隔离的**(明确的范围决定):

- **OS 级 shell**。默认 toolset 排除 `terminal`、`process`、`code_execution`、`browser_*`、`computer_use`。在没有 OS 级沙箱(Docker / firejail / chroot)的情况下不要把它们加回来。Python 层的 `confine_path` 只防意外路径穿越,不防内核漏洞。
- **内核漏洞**。`confine_path` 是 Python 层守卫,不是 CPython / 内核 CVE 的防御层。
- **上游美元成本超支**。计费发生在 new-api 那一层。要硬上限,请在 new-api admin 面板按 key 设配额 —— 这个 gateway 不重复这件事。

如果 `~/.hermes/web_users_master.key` 泄露,直接删掉重启即可。下次启动会自动生成新的密钥。**所有现存 Cookie session 会失效**(它们存储的加密 key 再也解不开),用户下次发消息时会重新弹出 key 输入框 —— **数据不丢失**,因为 user_id 本来就是从 key 派生的。

---

## 测试与质量

这个 fork 给每个 fork 特有的模块都配了自动化测试,`main` 分支上全部通过:

| 层 | 文件 |
|---|---|
| SessionDB 的 user_id 隔离 | `tests/hermes_state/test_user_id_filtering.py` |
| UserStore(用户行 + Cookie session) | `tests/gateway/test_web_users.py` |
| Sandbox + workspace contextvar | `tests/gateway/test_web_sandbox.py` |
| Cookie 鉴权中间件 | `tests/gateway/test_web_auth_middleware.py` |
| Chat runner(AIAgent factory + ContextVar key 注入) | `tests/gateway/test_web_chat_runner.py` |
| HTTP 适配器(login 流程、/me、/conversations、chat 鉴权门) | `tests/gateway/test_web_chat_adapter.py` |
| 沙箱 `web_file_*` 工具 | `tests/gateway/test_web_sandboxed_file_tools.py` |
| 上游 key 验证器(new-api `/v1/models` 探测) | `tests/gateway/test_web_upstream_validator.py` |
| 上游 key ContextVar + user_id 派生 | `tests/gateway/test_web_upstream_key.py` |
| Fernet KeyVault(加密 / 解密 / 主密钥文件) | `tests/gateway/test_web_key_storage.py` |

用项目的测试 wrapper 跑(与 CI 等价的 hermetic 环境):

```bash
scripts/run_tests.sh tests/gateway/test_web_*.py tests/hermes_state/test_user_id_filtering.py
```

最承重的测试是 **`test_concurrent_requests_dont_swap_user_contexts`** —— 两个并发 chat 请求(来自不同用户)各自必须能让自己的 `user_id` 和上游 API key 抵达 runner。这是多用户契约的关键验证:ContextVar 必须是 asyncio-task-local 而非 threadlocal,否则一个用户的请求会在并发下泄漏到另一个用户的工作区或计费账户。

---

## 仓库结构

```
.
├── gateway/
│   ├── platforms/web_chat.py        HTTP 适配器 —— Cookie 鉴权 + 路由 + SSE
│   └── web/                         ← 所有多租户代码住这里
│       ├── users.py                 UserStore(用户行 + Cookie session)
│       ├── auth.py                  Cookie 中间件 + KeyVault 注入
│       ├── sandbox.py               enter_user_context / confine_path
│       ├── upstream_key.py          每请求的上游 key ContextVar + user_id 派生
│       ├── upstream_validator.py    登录前向 new-api /v1/models 探测 key
│       ├── key_storage.py           KeyVault(Fernet + 磁盘主密钥)
│       ├── chat_runner.py           AIAgent 工厂(api_server 的镜像)
│       └── tools/
│           ├── __init__.py          (import 时触发副作用注册)
│           └── sandboxed_file_operations.py     web_file_* 工具
│
├── web-chat/                        ← React SPA → 构建到 gateway/web/_static/
│   ├── src/
│   │   ├── App.tsx                  hash router + nav,**无鉴权门**
│   │   ├── api.ts                   类型化 fetch 包装 + SSE async generator
│   │   ├── main.tsx                 React 入口
│   │   ├── styles.css               单文件全局样式(dark + light 自动切换)
│   │   ├── pages/{Chat,Settings}Page.tsx
│   │   └── components/{KeyPromptModal,ConversationList,ToolEvent}.tsx
│   ├── package.json                 react 19 + vite 7 + ts 5
│   └── vite.config.ts               dev 时代理 /api → :8643
│
├── tests/
│   ├── hermes_state/test_user_id_filtering.py
│   └── gateway/test_web_*.py        9 个测试文件覆盖 fork 表面
│
├── docs/user-guide/web-chat.md      运维指南(new-api 集成 walk-through)
│
└── (其它一切来自上游 Hermes Agent,未改动)
```

---

## 路线图

按"接下来最有用"的顺序:

- [ ] **GET /api/conversations/{id}** 拉取对话历史(SPA 现在能切换 session 但拉不出历史)
- [ ] **更新截图**匹配 new-api 登录流程
- [ ] **给上游提 plugin hook 提案** —— 在 `PluginManager` 加 `register_gateway_platform()`,然后整个 fork 可以作为 standalone plugin 发布,那几处外科手术 patch 跟着消失
- [ ] **Postgres 后端**给 `web_users.db`,在单机 SQLite 不够用时切换
- [ ] **OAuth / SSO** 在代理层,方便公司部署(Cookie 仍然守住聊天界面)
- [ ] **OS 级别按用户沙箱** —— 通过上游已有的 Docker terminal backend 实现
- [ ] **推送式多浏览器同步**(按用户的 SSE 事件总线),方便多端同时使用的用户

user_id 传播 fix 计划作为 PR 推回上游 —— 那确实是共享 `user_id` 列基础设施里的真 bug,对现有单用户调用方零行为变更。

---

## 致谢与许可

- **上游 agent**:[Nous Research / hermes-agent](https://github.com/NousResearch/hermes-agent) —— 整个 agent 主循环、技能系统、记忆栈、工具注册表、25+ 个 gateway 平台、模型 provider 插件、CLI,全部来自那里。这个 fork 只是在那个工作上面薄薄一层运维层。
- **上游计费网关**:[new-api](https://github.com/QuantumNous/new-api) —— 我们的参考实现,但任何 OpenAI 兼容的上游只要支持 `GET /v1/models` 就能工作(One API、Helicone、LiteLLM proxy、内部网关等等)。
- **许可**:MIT,与上游一致 —— 见 [`LICENSE`](LICENSE)。

延伸阅读:

- [`docs/user-guide/web-chat.md`](docs/user-guide/web-chat.md) —— 面向运维者:安装、HTTP 接口、容量规划、生产 checklist、管理任务。
- [`web-chat/README.md`](web-chat/README.md) —— SPA 开发笔记。
- 上游 agent 行为(技能、记忆、工具、模型路由)的文档在 [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) —— 那里说的所有内容在这里**未经修改地**适用。
- [`AGENTS.md`](AGENTS.md)(~1100 行)是上游的工程指南 —— 多用户层之下的一切以那为准。
- [`CLAUDE.md`](CLAUDE.md) 是 [Claude Code](https://claude.com/claude-code) 在本仓库工作时的导航文件。
