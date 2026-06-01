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

## Optional backend adapter

`backend/` (FastAPI + Python `altastata`) remains in the repo as an optional
adapter/runtime path. It is not required for the default JS + Java gRPC flow.
