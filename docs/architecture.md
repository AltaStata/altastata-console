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
| event listeners on `AltaStataFileSystem` | `subscribeToAltaStataEvents` in `frontend/src/api/altastata.ts` |
| status bar / log inspector | `frontend/src/components/LogDialog.tsx` (terminal icon) |

## Runtime data path

```
React (Vite dev / static build)
  └─ grpc-web calls from `frontend/src/api/altastata.ts`
      ├─ UsersService       (bootstrap/password)
      ├─ FileOpsService     (list/getBuffer/read/upload/delete, zip stream)
      ├─ AttributesService  (size/readers metadata)
      ├─ SharingService     (share/revoke)
      └─ EventsService      (long-running Subscribe stream → SHARE/DELETE)
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
| Live updates on `SHARE` / `DELETE` | `EventsService.Watch` server stream (typed `Event` payloads, `since_sequence` replay) + ~7s follow-up `listDir` to absorb backend's "Finishing shot" lag |
| Self-healing auth | `withBootstrapRetry` — on `status=16`/`status=9`/"User is not initialized" the client transparently re-runs the bootstrap sequence and retries the call once |

## Runtime settings and secrets

- Connection/auth settings are provided at runtime from the in-app Settings dialog.
- Values are stored locally in browser storage for developer convenience.
- `.env.local` can provide local defaults, but secrets are not meant to be committed.
- Source control policy: never commit real user properties, private keys, or passwords.

## Deployment

The repo produces a single artifact: the React SPA in `frontend/dist`.
There is no Python adapter, no backend service, and no Docker image
in this repo — the browser talks to `altastata-grpc` directly via
gRPC-Web.

The bundle is distributed through the `altastata` Python package
under `altastata/lib/altastata-console-static/`. Any image or
environment that installs `altastata` (pip / Jupyter / mycloud
containers) automatically gets the UI bytes alongside the library.

In production, the Java gRPC server (`mycloud/altastata-grpc`) serves
those static files directly from the filesystem path supplied via the
`ALTASTATA_WEB_UI_DIR` environment variable on `:9877` — both gRPC
API and SPA come from the same origin and port, so CORS is a non-issue
and there is no separate web server to operate. The Python launcher
(`altastata-grpc-server` in the `altastata` package) sets
`ALTASTATA_WEB_UI_DIR` automatically when the bundle is present at
`altastata/lib/altastata-console-static/`; if the directory is
missing or `index.html` is absent, the server logs a warning and runs
in gRPC-only mode (it never fails to start).

To refresh the bundle, run `altastata-python-package/scripts/build-bundled-artifacts.sh`
— it invokes `npm run build` here, then copies `frontend/dist/` into
`altastata-python-package/altastata/lib/altastata-console-static/`.
The bundle is **not committed** (`altastata/lib/` is gitignored); it
is rebuilt locally for each Python package release.
