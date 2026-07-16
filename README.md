# altastata-console

Web console for [AltaStata](https://altastata.com) — a Finder-style file browser
for cloud accounts, modeled after the JavaFX desktop app in
[`AltaStata/sovereign-data-fabric`](https://github.com/AltaStata/sovereign-data-fabric)
(`altastata-ui`).

This repo is a React client for AltaStata Java gRPC (`altastata-grpc` in the
same open-core repository).

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
│       │   ├── BottomToolbar.tsx   ← upload/download/share/lock/...
│       │   └── LogDialog.tsx       ← in-app UI-log panel
│       ├── utils/logBuffer.ts      ← console.* ring buffer for LogDialog
│       ├── api/altastata.ts        ← typed API client (gRPC-Web), events
│       ├── theme/index.ts          ← MUI theme matching JavaFX look
│       └── types/index.ts          ← shared TS types
├── scripts/
│   └── prevent-secrets-commit.sh   ← optional pre-commit secret guard
└── docs/architecture.md
```

## Quick start (development)

Prereqs: Node 20+, Java 17+.
Ensure an AltaStata gRPC server is available on `127.0.0.1:9877`
(for example via `altastata-grpc-server` from the
[`altastata` Python package](https://github.com/AltaStata/altastata-python-package)).

```bash
# Frontend
cd frontend
npm install
npm run dev   # → http://localhost:5173
```

Open <http://localhost:5173>.

Open the top-right **Settings** button and:

1. Set the gRPC base URL (default `http://127.0.0.1:9877`)
2. Choose your local **account folder** under `~/.altastata/accounts/...`
3. Enter the account password for RSA/PQC (leave blank for HPCS/HSM)
4. Click **Sign in** (LoginV2)

Optional: copy `frontend/.env.example` → `frontend/.env.local` only to
override the gRPC URL (default is already `http://127.0.0.1:9877`).
Do not put passwords or keys in env files — use the account-folder Sign in.

After cloning, install the secrets pre-commit hook once:

```bash
./scripts/install-git-hooks.sh
```

The Settings dialog header also shows the bundle's build version and ISO
timestamp (baked in at build time via Vite `define`) so it is unambiguous
which dist the browser is serving — handy when chasing cache-busting issues.

### Live updates (events)

While the UI is open it keeps a long-running gRPC server-streaming call to
`altastata.v1.EventsService/Watch`. The Java backend forwards share/delete
notifications as typed `Event` payloads and the UI auto-refreshes the current
view. The stream auto-reconnects on transient failures with the last seen
`since_sequence` to replay any missed events.

### UI log panel

The terminal icon next to the settings button opens a "UI log" dialog
showing recent `console.*` output captured by an in-app ring buffer
(`frontend/src/utils/logBuffer.ts`).

## Production build

```bash
cd frontend
npm install
npm run build   # → frontend/dist/
```

`frontend/dist/` is the only artifact this repo produces. It is a
static SPA that talks to `altastata-grpc` directly via gRPC-Web; no
Python, FastAPI, or Node runtime is required at runtime.

### Distribution

The bundle ships inside the [`altastata` Python package][pyalt] under
`altastata/lib/altastata-console-static/`. The Java gRPC server
(`altastata-grpc`) serves those static files directly on `:9877` — no
separate web container is needed.

[pyalt]: https://github.com/AltaStata/altastata-python-package

The bundle is **not committed** to the Python package repo
(`altastata/lib/` is gitignored, same policy as the runtime uber JAR).
It is rebuilt locally before each release by
[`altastata-python-package/scripts/build-bundled-artifacts.sh`][buildscript],
which runs `npm run build` here, then copies `frontend/dist/` into
`altastata-python-package/altastata/lib/altastata-console-static/`.

[buildscript]: https://github.com/AltaStata/altastata-python-package/blob/main/scripts/build-bundled-artifacts.sh

There is no Docker step in this repo.

## Why a separate repo?

- `altastata` (Python package) is a library imported by data-science code.
  Its consumers don't want a node toolchain pulled in via `pip install`.
- Console release cadence is independent (UI fixes ship more often than
  library API changes).

## Reference UI

The visual target is the JavaFX desktop explorer in
`AltaStata/sovereign-data-fabric` (`altastata-ui`) — three columns
(folders → files → preview), account name in the title bar, action toolbar
at the bottom, light theme. See `docs/architecture.md` for mapping to web
components.

## License

Licensed under the **Apache License, Version 2.0** — see [LICENSE](LICENSE).

Copyright 2026 AltaStata Inc. See also [NOTICE](NOTICE).
