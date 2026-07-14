# Hermes Multi-User Web Chat SPA

React + Vite SPA for the `web_chat` gateway platform. Pairs with
`gateway/platforms/web_chat.py` over the HTTP surface documented there.

## Scope

This is **intentionally distinct** from the existing `web/` dashboard
(which is a single-user local admin UI). The web-chat SPA is the
public-facing multi-user chat surface — register / login / chat with
the agent / manage workspace files, memory, and skills.

## Stack

- React 19 + react-dom 19
- TypeScript 5
- Vite 7
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **shadcn/ui** (New York style, Radix primitives, CSS variables)
- Hash router (hand-rolled — Platform routes)
- No Redux / Zustand (React state + Context)
- SSE via raw `fetch` + `ReadableStream`

### Theme

- Tokens live in `src/index.css` (shadcn `--primary`, `--background`, …)
- Legacy layout classes in `src/styles.css` alias `--accent` → `--primary`
- Dark by default; follows `prefers-color-scheme: light`
- Optional `.dark` class ready for a future manual theme toggle

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

## Project structure

```
web-chat/
├── components.json           shadcn config
├── src/
│   ├── main.tsx
│   ├── index.css             Tailwind + shadcn theme
│   ├── styles.css            Chat layout / legacy classes
│   ├── lib/utils.ts          cn() helper
│   ├── components/ui/        shadcn primitives
│   ├── pages/                Auth, Chat, Files, Skills, …
│   └── components/           App-level composites
├── package.json
├── tsconfig.json             paths: @/* → src/*
└── vite.config.ts
```
