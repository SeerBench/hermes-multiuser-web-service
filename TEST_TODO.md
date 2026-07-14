# TEST_TODO — 本轮改动人工测试审查清单

> **用途**：针对本对话相关改动的验收勾选表（非全站基线）。  
> **全链路基线**：[`docs/user-guide/platform-manual-testing.zh-CN.md`](docs/user-guide/platform-manual-testing.zh-CN.md)  
> **审查人**：________　**日期**：________　**环境**：□ 本地 □ 预发　**构建**：□ Vite `:5173` □ 生产 `:8643`

---

## 本轮改动一览

| 编号 | 功能 | 用户可感知入口 | 关键实现 |
|------|------|----------------|----------|
| A | Files 解析进度 UI | `#/files` | 轮询 `GET /api/v1/workspaces/{id}/files/{file_id}/status` |
| B | 注册 Onboarding | 注册成功后模态 | `localStorage` key：`hermes_onboarding_done:{userId}` |
| C | 技能库安装到 workspace | `#/skills` | `POST .../skills/install-from-catalog` |
| D | 技能预览 | `#/skills` 侧栏 | `GET .../skills/{name}` |
| E | 技能进化（Agent） | Chat | `web_skill_edit` / `web_skill_patch`（全局 fork-on-write） |
| F | 相关回归 | 顶栏 / 会话列表 / 移动端 | P0：bind 横幅、搜索、抽屉 |

---

## 0. 启动与自检（必做）

```bash
./startplatform.sh --host 127.0.0.1
# 前端调试：cd web-chat && npm run dev   → http://127.0.0.1:5173
# 或：cd web-chat && npm run build     → http://127.0.0.1:8643
```

| # | 检查 | 通过 |
|---|------|------|
| 0.1 | `curl -s http://127.0.0.1:8700/api/v1/healthz` → 200 | □ |
| 0.2 | `curl -s http://127.0.0.1:8643/api/healthz` → 200 | □ |
| 0.3 | 浏览器打开后出现 **注册/登录**（非仅 Legacy Key 弹窗；`curl -s http://127.0.0.1:8643/api/v1/healthz` 应为 platform-api 的 JSON，而非 `unauthorized`） | □ |
| 0.4 | 使用 `127.0.0.1`（避免 Cookie 与 `localhost` 混用） | □ |
| 0.5 | 审查前建议无痕窗口，或清空 Cookie + 相关 localStorage | □ |

**自动化（人工前建议先绿）**

```bash
scripts/run_tests.sh tests/gateway/test_web_sandboxed_skills.py
scripts/run_tests.sh tests/platform/test_skills_catalog.py
cd web-chat && npm run verify
```

| # | 命令结果 | 通过 |
|---|----------|------|
| 0.6 | gateway skill 测试通过 | □ |
| 0.7 | platform skills catalog 测试通过 | □ |
| 0.8 | `npm run verify` 通过 | □ |

---

## A. Files 解析进度 UI

**账号**：任意已登录 Platform 用户（有 workspace）。

| # | 步骤 | 预期结果 | 通过 | 备注 |
|---|------|----------|------|------|
| A1 | 打开 `#/files`，上传小 `.txt` / `.md` | 列表出现文件；状态徽章先「排队中/索引中」，再变「已就绪」 | □ | |
| A2 | 上传过程中不手动刷新 | 状态自动更新（约 2s 级轮询） | □ | |
| A3 | DevTools → Network | 可见对 `.../files/{id}/status` 的请求；就绪后对已完成文件不再持续无意义轮询 | □ | |
| A4 | 上传损坏/不支持文件（若可复现失败） | 状态「失败」，展示错误文案 | □ | 不可复现可标 N/A |
| A5 | 删除文件 | 条目消失，无未处理错误 | □ | |
| A6 | 切换中/英文 | 状态文案切换正确（Queued↔排队中 等） | □ | |

**结论 A**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## B. 注册 Onboarding 向导

**账号**：必须用**新邮箱注册**（或删掉 `hermes_onboarding_done:{userId}`）。

| # | 步骤 | 预期结果 | 通过 | 备注 |
|---|------|----------|------|------|
| B1 | 注册成功 | 弹出 Onboarding（快速入门 / Get started），有步骤进度 | □ | |
| B2 | 若 `pending_bind` | 第 1 步为绑 API key，可提交 | □ | |
| B3 | 绑 key 成功 | 进入「上传文档（可选）」；顶栏 pending_bind 横幅应消失（刷新后亦消失） | □ | |
| B4 | 点「前往文件页」 | 路由到 `#/files`，进入下一步 | □ | |
| B5 | 或点「暂时跳过」 | 不强制上传，进入「打开对话」步 | □ | |
| B6 | 「打开对话」 | 关闭模态，进入 `#/chat`；localStorage 写入完成标记 | □ | Application → Local Storage 核对 |
| B7 | 同用户刷新 / 再登录 | **不再**弹出 Onboarding | □ | |
| B8 | 注册第二个新用户 | **仍会**弹出（按 userId 隔离） | □ | |
| B9 | 已 bind 用户清掉完成标记后再进 | 可再弹出；不应强制停在绑 key（可直接从上传/对话引导开始） | □ | |

**结论 B**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## C / D. 技能库：浏览、预览、安装

**前置**：全局库至少有一个 skill。本地为空时可临时植入：

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/skills/research/demo-skill"
cat > "$HERMES_HOME/skills/research/demo-skill/SKILL.md" <<'EOF'
---
name: demo-skill
description: "Manual test catalog skill for TEST_TODO."
version: 1.0.0
---
# demo-skill

Always include the token HELLO_DEMO in your first reply when this skill applies.
EOF
# 植入后需重启 gateway / 或确认 list 能扫到（进程已指向该 HERMES_HOME）
```

| # | 步骤 | 预期结果 | 通过 | 备注 |
|---|------|----------|------|------|
| C1 | 打开 `#/skills` | 可见「技能库」分区；有全局条目 | □ | |
| C2 | 点击 skill 名称 | 右侧预览 SKILL.md、`source`、描述 | □ | |
| C3 | 「添加到工作区」 | 进入「我的技能」；`source=user`；预览仍可读 | □ | |
| C4 | 磁盘核验 | `$HERMES_HOME/web_workspaces/<user_id>/skills/.../SKILL.md` 存在 | □ | |
| C5 | 同名再次添加（不覆盖） | 明确失败/冲突提示，不静默覆盖 | □ | 期望 409 或 UI 错误 |
| C6 | 启用开关切换 + 刷新 | 状态保持 | □ | |
| C7 | 用户 B（另一无痕）看 `#/skills` | **看不到** A 的 `source=user` 私有技能 | □ | |
| C8 | A 的 Cookie 调 B 的 workspace 安装 API | 404（隔离） | □ | 可选 curl |

**可选 curl（替换 Cookie / WS_ID）**

```bash
curl -s -b 'hermes_session=YOUR_COOKIE' \
  -X POST "http://127.0.0.1:8700/api/v1/workspaces/WS_ID/skills/install-from-catalog" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo-skill"}'
```

**结论 C/D**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## E. 技能进化（Chat Agent）

**前置**：已 bind key；Chat 可正常流式回复。

| # | 步骤 | 预期结果 | 通过 | 备注 |
|---|------|----------|------|------|
| E1 | 「列出我可用的技能」 | Agent 走 `web_skills_list`，能区分 global / user | □ | 可用工具事件面板观察 |
| E2 | 对**仅全局** skill：「把说明改成……」 | 使用 `web_skill_patch` 或 `edit`；之后在「我的技能」出现私有副本 | □ | |
| E3 | 查全局磁盘 | `$HERMES_HOME/skills/.../SKILL.md` **未改** | □ | |
| E4 | 查用户磁盘 | workspace 下私有 SKILL.md **已改** | □ | |
| E5 | 再对私有副本小改一次 | 直接改 user 文件，全局仍不动 | □ | |
| E6 | 「删除我刚装的个人技能」 | `web_skill_delete` 成功 | □ | |
| E7 | 「删除某个全局技能」 | 被拒绝 / 提示只读 | □ | |
| E8 | 「用 mkdir / 终端帮我装 skill」 | Agent 应按平台规则拒绝，引导 `web_skill_*` | □ | 负面用例 |

**结论 E**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## F. 相关回归（本对话前序 P0）

| # | 检查项 | 预期 | 通过 |
|---|--------|------|------|
| F1 | 未 bind 时顶栏引导横幅 | 可见，可进 Settings 绑 key | □ |
| F2 | 未 bind 时发 Chat | 被拦截或提示需绑 key（非 Silent 403） | □ |
| F3 | 会话列表搜索 | 标题/预览可过滤 | □ |
| F4 | 视口 ≤720px | 汉堡菜单可开会话抽屉 | □ |
| F5 | 中英文切换 | Onboarding / Files / Skills 无 i18n key 裸露 | □ |

**结论 F**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## G. 隔离底线（双账号，建议）

| # | 场景 | 预期 | 通过 |
|---|------|------|------|
| G1 | A 上传文件 | B 的 `#/files` 不可见 | □ |
| G2 | A 安装的个人 skill | B 看不到 user 源 | □ |
| G3 | A / B 各自 Chat 会话 | 互不可见 | □ |
| G4 | Onboarding 完成标记 | 按 userId，互不影响 | □ |

**结论 G**：□ 通过　□ 有缺陷（编号：____）　□ 阻塞

---

## 建议验收顺序（约 25–40 分钟）

```
0 健康检查 + 自动化绿
 → B 新账号注册 + Onboarding 全流程 + bind-key
 → A 上传文件看进度徽章
 → C/D 技能库预览 + 安装到 workspace
 → E Chat 进化技能（fork 后改文案）+ 核对磁盘
 → G 第二账号隔离
 → F 移动端 / 搜索 / 横幅快速扫一眼
```

---

## 审查结论

| 判定 | 勾选 |
|------|------|
| **通过** — 可合并 / 可进下一步发布准备 | □ |
| **有条件通过** — 仅非阻塞缺陷，已登记 | □ |
| **不通过** — 存在阻塞项，需返工 | □ |

### 阻塞项

| ID | 现象 | 复现步骤 | 期望 | 实际 |
|----|------|----------|------|------|
| | | | | |

### 非阻塞项

| ID | 现象 | 建议 |
|----|------|------|
| | | |

### 签核

- 审查人：________________　签名/日期：________________
- 开发确认：________________　日期：________________

---

## 附录：代码触点（对照用）

| 功能 | 主要文件 |
|------|----------|
| Files 进度 | `web-chat/src/pages/FilesPage.tsx`、`fileIngestion.ts`、`platformClient.getFileStatus` |
| Onboarding | `OnboardingModal.tsx`、`onboardingStorage.ts`、`App.tsx`、`AuthPage.tsx` |
| Skills API | `platform_api/routers/skills.py` |
| Skills Agent | `gateway/web/tools/sandboxed_skill_manage.py`、`toolsets.py`、`chat_runner.py` |
| Skills UI | `web-chat/src/pages/SkillsPage.tsx` |
| i18n / 样式 | `web-chat/src/i18n/{en,zh}.json`、`styles.css` |
| 测试 | `tests/platform/test_skills_catalog.py`、`tests/gateway/test_web_sandboxed_skills.py`、`web-chat` vitest |

## 附录：常见问题（本轮相关）

| 现象 | 排查 |
|------|------|
| 没出现 Onboarding | 不是新注册；或已有 `hermes_onboarding_done:*`；或非 Platform 模式 |
| 技能库为空 | `$HERMES_HOME/skills` 无内容；gateway 与审查终端的 `HERMES_HOME` 不一致 |
| 安装成功但列表仍像 global | 刷新 `#/skills`；或同名 overlay 未刷新侧栏，重开预览 |
| 进度一直卡在索引中 | platform ingest 是否报错；看 platform-api 日志 / 文件 `error_message` |
| Chat 无 edit/patch | 确认 `hermes-web-chat` 工具集已含新工具且 gateway 已重启 |
| Cookie 异常 | 统一用 `127.0.0.1`，不要混 `localhost` |
