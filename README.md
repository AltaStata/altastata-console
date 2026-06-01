# altastata-console

Web console for [AltaStata](https://altastata.com) — a Finder-style file browser
for cloud accounts, modeled after the JavaFX desktop app
(`mycloud/altastata-ui`).

This repo is a React client for AltaStata Java gRPC (`mycloud/altastata-grpc`)
and follows the same RPC flows as `altastata-python-package/tests/js-grpc-ui`.

## Architecture

```
              ┌──────────────────────────────┐
 browser  →   │  altastata-grpc :9877        │
 (Vite dev)   │  Users/FileOps/Attrs/Sharing │
              └──────────────┬───────────────┘
                             │ JVM
                             ▼
                      AltaStata cloud
```

For local development, Vite serves the frontend and calls Java gRPC directly.

## Repo layout

```
altastata-console/
├── frontend/          React + TypeScript + Vite + MUI
│   └── src/
│       ├── components/
│       │   ├── MillerColumns.tsx   ← Finder-style 3-pane layout
│       │   ├── FileColumn.tsx      ← single column of files/folders
│       │   ├── PreviewPane.tsx     ← right pane: preview + metadata
│       │   └── BottomToolbar.tsx   ← upload/download/share/lock/...
│       ├── api/altastata.ts        ← typed API client
│       ├── theme/index.ts          ← MUI theme matching JavaFX look
│       └── types/index.ts          ← shared TS types
├── backend/           (legacy adapter, optional; not required for gRPC mode)
├── Dockerfile         (legacy full-stack image)
├── docker-compose.yml (legacy backend stack)
└── docs/architecture.md
```

## Quick start (development)

Prereqs: Node 20+, Java 17+.
Ensure AltaStata gRPC server is available on `127.0.0.1:9877`
(same as `altastata-python-package/tests/js-grpc-ui`).

```bash
# Frontend
cd frontend
npm install
npm run dev   # → http://localhost:5173
```

Open <http://localhost:5173>.

Default local account is Bob. To override for frontend gRPC mode, create
`frontend/.env.local`:

```bash
VITE_ALTASTATA_GRPC_BASE_URL=http://127.0.0.1:9877
VITE_ALTASTATA_ACCOUNT_ID=amazon.rsa.bob123
VITE_ALTASTATA_GRPC_USER_NAME=bob123_rsa
VITE_ALTASTATA_PASSWORD=123
# Optional if server is not pre-bootstrapped:
# VITE_ALTASTATA_USER_PROPERTIES=<multiline properties string with \n>
# VITE_ALTASTATA_PRIVATE_KEY=<encrypted private key with \n>
```

## Production build

```bash
docker build -t altastata-console:dev .
docker run -p 8000:8000 \
  -v ~/.altastata:/root/.altastata:ro \
  altastata-console:dev
```

Then open <http://localhost:8000>.

## Why a separate repo?

- `altastata` (Python package) is a library imported by data-science code.
  Its consumers don't want a node toolchain pulled in via `pip install`.
- Console release cadence is independent (UI fixes ship more often than
  library API changes).
- Mirrors the pattern already established in `mycloud/`:
  `altastata-admin-ui` / `altastata-admin-api` are similarly split.

## Reference UI

The visual target is `mycloud/altastata-ui` (JavaFX desktop, "AltaStata
Cloud File Explorer" v1.0.6) — three columns (folders → files → preview),
account name in the title bar, action toolbar at the bottom, light theme.
See `docs/architecture.md` for screenshots and mapping to web components.

## License

TBD — copy from `altastata` repo when finalizing.
