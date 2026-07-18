# Hermes Multi-User Web Chat SPA

React + Vite SPA for the `web_chat` gateway platform. Pairs with
`gateway/platforms/web_chat.py` and the Platform control plane
(`platform_api/`) over the HTTP surface documented in
`docs/user-guide/web-chat.md` / `platform-saas.md`.

## Scope

This is **intentionally distinct** from the existing `web/` dashboard
(which is a single-user local admin UI). The web-chat SPA is the
public-facing multi-user surface:

- Auth (email register / login, or legacy API-key login)
- Chat with SSE streaming
- Workspace: **Files → Knowledge → Skills → Memory**
- **Usage Center** (`#/usage`) — platform activity / token ledger
- Settings (account, models; Usage tab links to Usage Center; new-api billing proxy)
- Admin console (`role=admin`): users + audit log

There is **no** `QuotaBadge`. Two usage surfaces coexist:

| Surface | Route / API | Role |
|---------|-------------|------|
| Usage Center | `#/usage` → `/api/v1/usage/*` | Platform ledger (chat / skill / knowledge) |
| Upstream wallet | Settings / `/api/v1/billing/*` | new-api balance & logs |

## Centers (workspace + account)

| Center | Hash | Notes |
|--------|------|--------|
| Files | `#/files` | Upload, folders, tags; DocumentChunk trial search |
| Knowledge | `#/knowledge` | Build bases from files; delete base keeps files; agent retrieves `knowledge_chunks` |
| Skill | `#/skills` | Enable/disable, create, catalog install, config |
| Memory | `#/memory` | Structured items + pending AI suggestions |
| Usage | `#/usage` | Today/month summary, trend, by-model / by-skill, logs |

## Stack

- React 19 + react-dom 19
- TypeScript 5
- Vite 7
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **shadcn/ui** (New York style, Radix primitives, CSS variables)
- Hash router (hand-rolled — see `src/routing.ts`)
- No Redux / Zustand (React state + Context)
- SSE via raw `fetch` + `ReadableStream`
- Markdown: `marked` + `highlight.js` (fenced code + copy)

### Theme

- Tokens live in `src/index.css` (shadcn `--primary`, `--background`, …)
- Legacy layout classes in `src/styles.css` alias `--accent` → `--primary`
- Theme preference stored via `themeStorage` (system / light / dark)
- Optional `.dark` class for manual dark mode

### Adding shadcn components

```bash
cd web-chat
npx shadcn@latest add <component>   # e.g. select, dropdown-menu
```

Config: `components.json`. Generated UI code lands in `src/components/ui/`.

## Development

```bash
cd web-chat
npm install
npm run dev                          # http://127.0.0.1:5173
                                     # /api/v1 → :8700, /api → :8643
```

Platform full stack from repo root:

```bash
./startplatform.sh --host 127.0.0.1
```

Or legacy gateway only:

```bash
./startweb.sh --host 127.0.0.1
```

## Build for production

```bash
npm run build
# or: npm run verify   # typecheck + vitest + build
```

Outputs to `../gateway/web/_static/`.

## Routes (hash)

| Hash | Page |
|------|------|
| `#/chat` | Chat (default) |
| `#/settings` | Settings dialog |
| `#/files` | Workspace files |
| `#/file-tags` | File tags |
| `#/knowledge` | Knowledge Center |
| `#/memory` | Memory Center |
| `#/skills` | Skill Center |
| `#/usage` | Usage Center |
| `#/admin` | Admin users (admin only) |
| `#/admin/audit` | Admin audit log |
| `#/reset-password?token=` | Password reset (auth gate) |

## Project structure

```
web-chat/
├── components.json
├── src/
│   ├── main.tsx
│   ├── App.tsx                 Shell, skip-nav, auth gate
│   ├── index.css               Tailwind + shadcn theme
│   ├── styles.css              Chat layout / markdown / legacy
│   ├── routing.ts              Hash routes
│   ├── api.ts                  Gateway `/api/*` client
│   ├── platformClient.ts       Platform `/api/v1/*` client
│   ├── chatHotkeys.ts          ? / n / / shortcuts
│   ├── lib/utils.ts
│   ├── pages/
│   │   ├── AuthPage.tsx
│   │   ├── ChatPage.tsx
│   │   ├── SettingsPage.tsx
│   │   ├── FilesPage.tsx
│   │   ├── FileTagsPage.tsx
│   │   ├── KnowledgePage.tsx
│   │   ├── MemoryPage.tsx
│   │   ├── SkillsPage.tsx
│   │   ├── UsagePage.tsx
│   │   ├── AdminPage.tsx
│   │   └── AdminAuditPage.tsx
│   └── components/
│       ├── ui/                 shadcn primitives
│       ├── WorkspaceShell.tsx  Files → Knowledge → Skills → Memory
│       ├── MarkdownContent.tsx
│       ├── ChatComposer.tsx
│       ├── ShortcutsHelpDialog.tsx
│       └── …                   bubbles, lists, drawers, …
├── package.json
├── tsconfig.json               paths: @/* → src/*
└── vite.config.ts
```

## Keyboard shortcuts (chat)

Press `?` when not focused in an input:

| Key | Action |
|-----|--------|
| `Enter` | Send (in composer) |
| `n` | New conversation |
| `/` | Focus composer |
| `?` | Open shortcuts help |
