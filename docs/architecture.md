# Architecture

## Visual reference

The visual target is **`mycloud/altastata-ui`** (JavaFX desktop, "AltaStata
Cloud File Explorer"). Three columns:

```
┌─────────────┬─────────────┬───────────────────────────────┐
│ folders     │ contents of │  preview pane                 │
│ (root)      │ selected    │  ┌─ name + size + created     │
│             │ folder      │  ├─ readers: alice, bob       │
│             │             │  └─ inline preview (PDF/img)  │
└─────────────┴─────────────┴───────────────────────────────┘
                                                                  ┌── BottomToolbar ──┐
                                                                  │ + 🗑  filter | ⬇ ⬆ 🔗 🔒 │
                                                                  └────────────────────┘
```

The left columns "drill in" Finder-style: clicking a folder appends a new
column to the right. Clicking a file replaces the right-most preview pane.

## Component map

| JavaFX (mycloud/altastata-ui) | React (this repo) |
|---|---|
| `MainController` columns | `frontend/src/components/MillerColumns.tsx` |
| `FileListView` per column | `frontend/src/components/FileColumn.tsx` |
| right preview pane | `frontend/src/components/PreviewPane.tsx` |
| bottom action bar | `frontend/src/components/BottomToolbar.tsx` |
| native window title (account) | `frontend/src/App.tsx` `<AppBar>` |
| account settings dialog | `frontend/src/App.tsx` `<Dialog>` |

## Runtime data path

```
React (Vite dev / static build)
  └─ grpc-web calls from `frontend/src/api/altastata.ts`
      ├─ UsersService       (bootstrap/password)
      ├─ FileOpsService     (list/getBuffer/read/upload/delete)
      ├─ AttributesService  (size/readers metadata)
      └─ SharingService     (share/revoke)
            │
            ▼
      altastata-grpc :9877 (Java)
            │
            ▼
      AltaStata cloud
```

The frontend currently mirrors JavaFX behavior:

| Behavior | Current implementation |
|---|---|
| Miller columns (one level per click) | `ListVersions` with `includingSubdirectories=false` |
| Text preview (large files) | `GetBuffer` first chunk only (`size` limited) |
| CSV preview | treated as text (`text/csv`) |
| Preview metadata | `GetAttributes` (`size`, `readers`) + version tag parsing |
| User derivation | `myuser` from user properties (JavaFX-compatible) |

## Runtime settings and secrets

- Connection/auth settings are provided at runtime from the in-app Settings dialog.
- Values are stored locally in browser storage for developer convenience.
- `.env.local` can provide local defaults, but secrets are not meant to be committed.
- Source control policy: never commit real user properties, private keys, or passwords.

## Deployment

The repo produces a single artifact: the React SPA in `frontend/dist`.
There is no Python adapter and no backend service — the browser talks
to `altastata-grpc` directly via gRPC-Web.

The multi-stage `Dockerfile` exposes two build targets:

- `dist` — Node stage that runs `npm run build` and leaves the bundle
  in `/app/dist`. Use this target when embedding the UI inside another
  image (e.g. a Jupyter image) via `COPY --from=...`.
- `runtime` — Default target. `nginx:alpine` serving the bundle on
  port 8080 with SPA history-API fallback (`nginx/default.conf`). The
  port is unprivileged so the image runs under arbitrary non-root UIDs
  on OpenShift/Kubernetes without extra capabilities.

Both stages build from the same source, so embedded and standalone
deployments stay in sync automatically.
