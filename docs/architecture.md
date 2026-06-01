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

## Backend → AltaStata

```
React (axios)  →  FastAPI /api/*  →  altastata.AltaStataFunctions
                                       │
                                       ▼
                                    Py4J / gRPC
                                       │
                                       ▼
                                   JVM gateway (altastata-grpc-1.0.0-uber.jar)
                                       │
                                       ▼
                                  AltaStata cloud
```

Endpoints (see `backend/src/altastata_console/api/`):

| Path | Purpose |
|---|---|
| `GET /api/health` | liveness probe |
| `GET /api/account` | account id and display name |
| `GET /api/files?path=…` | directory listing |
| `GET /api/preview?path=…&version=…` | streaming bytes for inline preview |
| `GET /api/versions?path=…` | list historical versions (parses `✹`) |

## Open work for the implementation phase

1. **Wire `AltaStataFunctions`** into `api/files.py`, `api/preview.py`,
   `api/versions.py`. The mock data in `files.py` can stay behind a flag for
   tests.
2. **Auth.** The console needs to know which account to use. Two options:
   (a) container reads `~/.altastata/accounts/<id>/` like the JavaFX app and
   exposes one fixed account, or (b) login screen prompts for credentials
   and passes them to `AltaStataFunctions.from_credentials(...)`.
3. **Toolbar actions.** Today they are stubs; wire to upload (multipart),
   download (streaming response), share (readers list mutation), lock/unlock
   (encryption toggle), new folder, delete.
4. **Versions UI.** Show a timeline / selector when a file is selected, then
   pass `version` through to `/api/preview`.
5. **Error handling.** Wrap all axios calls in a notistack provider; surface
   gRPC/Py4J errors to the user.
6. **MIME types.** Backend should guess per extension before streaming.
7. **CI.** Add GitHub Actions workflow: lint + typecheck + tests for both
   frontend and backend, plus a Docker build smoke test.
