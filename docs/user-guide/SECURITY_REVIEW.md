# Platform SaaS — 正式安全 Review Checklist

面向上线前的**可签署**安全审查。运维速查仍见 [DEPLOY.md §17](DEPLOY.md)；本页要求逐项勾选并在文末签署。

**范围**：`platform_api/`、Agent Gateway `web_chat`、`web-chat` SPA、部署面（nginx / SQLite|PG / 可选 Redis·MinIO）。  
**规模假设**：约 10–50 用户；控制面默认 SQLite。

---

## 1. Cookie / Session

- [ ] 会话 Cookie 名称为 `hermes_session`（或与 `PLATFORM_SESSION_COOKIE` 配置一致）。
- [ ] Cookie 设置了 **HttpOnly**（浏览器 JS 不可读）。
- [ ] Cookie **SameSite=Lax**（或更严的策略并已文档化）。
- [ ] 生产环境 `PLATFORM_COOKIE_SECURE=true`，且仅通过 HTTPS 访问。
- [ ] Gateway 侧 `cookie_secure: true`（与 platform-api 一致）。
- [ ] `allow_insecure_bind: false`（禁止公网明文绑定）。
- [ ] 已跑通自动化：`tests/platform/test_cookie_secure.py`。
- [ ] 已跑通生产探针：`scripts/verify-https-cookies.sh https://<域名>`。

**备注 / 证据链接**：

```
_________________________________________________________________
```

---

## 2. 越权 / 多租户隔离

- [ ] 所有触及用户文件 / memory / skills / knowledge 的路径在 `enter_user_context(user_id)` 内执行。
- [ ] Workspace API 校验归属：用户 A 无法读写用户 B 的 `workspace_id`。
- [ ] 文件 `storage_key` 沙箱：本地 `confine_path`；MinIO `s3://` key 必须落在本 workspace 前缀下。
- [ ] Admin API（`/api/v1/admin/*`）对非 admin 返回 **403**。
- [ ] 并发隔离回归绿：`test_concurrent_requests_dont_swap_user_contexts` 及 `tests/platform/test_isolation*.py`。
- [ ] 已覆盖：`tests/platform/test_storage_key_sandbox.py`。
- [ ] Legacy key 登录入口在 UI 上折叠为高级/运维路径，默认不以主路径暴露。

**备注 / 证据链接**：

```
_________________________________________________________________
```

---

## 3. 密钥与敏感数据

- [ ] `HERMES_WEB_KEY_VAULT_SECRET`（或等价 master key）仅存在于部署机 `.env`，权限 **600**，未进 Git。
- [ ] Upstream API key 以密文存库（`upstream_api_key_enc` / KeyVault），应用日志**无明文 key**。
- [ ] `NEW_API_ADMIN_TOKEN`、MinIO secret、DB 密码未写入仓库或 CI 日志。
- [ ] 密钥轮换步骤已知：更换 vault secret 前已备份；轮换后旧密文需 re-encrypt 或用户 re-bind（见 [platform-saas.md](platform-saas.md)）。
- [ ] 备份介质（含 `web_users_master.key`、SQLite/PG dump）加密且异机存放。

**备注 / 证据链接**：

```
_________________________________________________________________
```

---

## 4. 依赖审计（Supply chain）

- [ ] Python 依赖通过 `uv.lock` 锁定；`pyproject.toml` 新增包带**上界**（仓库依赖政策）。
- [ ] 近期执行过 `uv pip audit`（或等价）并处理高危项（记录日期与工具版本）。
- [ ] `web-chat`：近期执行过 `npm audit`（或 CI 等价），高危项已处理或明确 Waived。
- [ ] 无将未审查的 git URL / 未 pin 依赖直接引入生产路径。

**审计记录**（日期 / 命令 / 结果摘要）：

```
_________________________________________________________________
```

---

## 5. 网络面与健康探测

- [ ] 公网仅 **22 / 80 / 443**；`8700`、`8643`、Redis、MinIO、DB 端口不对公网开放。
- [ ] Platform 深度健康：`GET /api/v1/healthz` 返回 `checks.database` / `redis` / `object_store`；生产监控告警 503 / `degraded`。
- [ ] Gateway：`GET /api/healthz` 存活探测纳入监控。
- [ ] 可选：已跑 [deploy/loadtest](../../deploy/loadtest/README.md) 10 VU 基线，阈值通过。

**备注 / 证据链接**：

```
_________________________________________________________________
```

---

## 6. 签署

| 字段 | 填写 |
|------|------|
| Reviewer（姓名） | |
| Role / Team | |
| Date (UTC 或本地+时区) | |
| Environment（staging / prod） | |
| Result | Pass / Fail / Waived（注明 Waived 项） |
| Follow-ups | |

```
Result: _______________

Signature / ack: ________________________________  Date: ____________
```

**Waived 项明细**（编号 + 理由 + 计划关闭日期）：

```
_________________________________________________________________
```

---

## 相关文档

- [DEPLOY.md](DEPLOY.md) — VPS 部署与运维速查
- [platform-saas.md](platform-saas.md) — 架构与认证
- [deploy/loadtest/README.md](../../deploy/loadtest/README.md) — k6 10 VU 基线
