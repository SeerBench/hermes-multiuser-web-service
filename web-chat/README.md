# Hermes Multi-User Web Chat SPA

Minimal React + Vite SPA for the `web_chat` gateway platform.  Pairs
with `gateway/platforms/web_chat.py` over the HTTP surface documented
there.

## Scope

This is **intentionally distinct** from the existing `web/` dashboard
(which is a single-user local admin UI).  The web-chat SPA is the
public-facing multi-user chat surface — register / login / chat with
the agent / manage API keys / inspect quota.

## Stack (deliberately minimal)

- React 19 + react-dom 19
- TypeScript 5
- Vite 7
- **No** UI framework (Tailwind / shadcn / MUI etc.)
- **No** router (hash-based, hand-rolled — five routes total)
- **No** state management lib (React `useReducer` + Context)
- **No** SSE client lib (raw `fetch` + `ReadableStream`)

Why so light: the deployment target is a 2c/4G VPS shared by N users.
Every kilobyte of JS the browser parses is a tax on the user
experience; every npm dependency is a future supply-chain risk.  The
plan's "Strategy 2" (see `../plans/.../kazoo.md`) sets the tone — we
optimize for fork-friendliness over framework comfort.

## Development

```bash
cd web-chat
npm install                          # ~50 MB node_modules, mostly
                                     # vite + typescript
npm run dev                          # http://localhost:5173, proxies
                                     # /api → http://127.0.0.1:8643
```

Run the gateway separately:

```bash
# In another terminal, from repo root:
hermes gateway run                   # with platforms.web_chat.enabled = true
                                     # in ~/.hermes/config.yaml
```

## Build for production

```bash
npm run build
```

Outputs to `../gateway/web/_static/`.  The `WebChatAdapter` serves the
SPA shell from `/` and assets from `/static/*` (wiring landed in
stage 7).

## Project structure

```
web-chat/
├── src/
│   ├── main.tsx              React root
│   ├── App.tsx               Top-level routing + auth gate
│   ├── api.ts                fetch wrapper + SSE chat stream
│   ├── styles.css            Single global stylesheet
│   ├── pages/
│   │   ├── AuthPage.tsx      register / login
│   │   ├── ChatPage.tsx      transcript + composer + SSE
│   │   └── SettingsPage.tsx  API keys + quota
│   └── components/
│       ├── QuotaBadge.tsx
│       ├── ConversationList.tsx
│       └── ToolEvent.tsx
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```
