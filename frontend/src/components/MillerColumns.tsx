import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Box, Button, Stack, Typography } from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import { isUserNotInitializedError, listDir } from "@/api/altastata";
import type { FileEntry } from "@/types";
import FileColumn from "./FileColumn";
import PreviewPane from "./PreviewPane";

interface ColumnState {
  path: string;
  title: string;
  entries: FileEntry[];
  selected: FileEntry | null;
}

interface SelectOptions {
  focusNextColumn?: boolean;
}

interface Props {
  reloadToken?: number;
  onSelectionContextChange?: (selected: FileEntry | null, activePath: string) => void;
  onOpenSettings?: () => void;
}

/**
 * Finder-style 3+ pane file browser.
 *
 * - First column lists the root.
 * - Selecting a folder appends a new column to the right.
 * - Selecting a file opens the right-most "preview" panel.
 *
 * Mirrors mycloud/altastata-ui (JavaFX desktop) layout.
 */
export default function MillerColumns({
  reloadToken = 0,
  onSelectionContextChange,
  onOpenSettings,
}: Props) {
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [activeColumnIdx, setActiveColumnIdx] = useState(0);
  const [rootError, setRootError] = useState<Error | null>(null);
  const latestNavRequestRef = useRef(0);

  const sortEntries = useCallback((entries: FileEntry[]) => {
    return [...entries].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, []);

  const getColumnTitle = useCallback((path: string) => {
    if (path === "/") return "root";
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }, []);

  const loadColumn = useCallback(async (path: string) => {
    const data = await listDir(path);
    return {
      path,
      title: getColumnTitle(path),
      entries: sortEntries(data.entries),
      selected: null,
    } as ColumnState;
  }, [getColumnTitle, sortEntries]);

  const getColumnDefaultSize = useCallback((count: number) => {
    if (count === 0) return 20;
    const totalColumnSpace = 62;
    return totalColumnSpace / count;
  }, []);

  useEffect(() => {
    let mounted = true;
    loadColumn("/")
      .then((col) => {
        if (!mounted) return;
        setColumns([col]);
        setPreviewFile(null);
        setRootError(null);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setColumns([]);
        setPreviewFile(null);
        setRootError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      mounted = false;
    };
  }, [loadColumn, reloadToken]);

  useEffect(() => {
    setActiveColumnIdx((prev) => Math.min(prev, Math.max(columns.length - 1, 0)));
  }, [columns.length]);

  useEffect(() => {
    if (!onSelectionContextChange) return;
    const activeCol = columns[activeColumnIdx] ?? columns[columns.length - 1];
    const selected = activeCol?.selected ?? null;
    const activePath = selected?.is_dir ? selected.path : (activeCol?.path ?? "/");
    onSelectionContextChange(selected, activePath);
  }, [activeColumnIdx, columns, onSelectionContextChange]);

  const handleSelect = useCallback(async (
    colIdx: number,
    entry: FileEntry,
    options: SelectOptions = {},
  ) => {
    const navRequestId = ++latestNavRequestRef.current;
    setActiveColumnIdx(colIdx);
    setColumns((prev) => {
      if (!prev[colIdx]) return prev;
      const nextColumns = prev.slice(0, colIdx + 1);
      nextColumns[colIdx] = { ...nextColumns[colIdx], selected: entry };
      return nextColumns;
    });

    setPreviewFile(entry);
    if (!entry.is_dir) {
      return;
    }

    if (entry.is_dir) {
      try {
        const next = await loadColumn(entry.path);
        if (navRequestId !== latestNavRequestRef.current) return;

        setColumns((prev) => {
          if (!prev[colIdx]) return prev;
          if (prev[colIdx].selected?.path !== entry.path) return prev;
          const nextColumns = prev.slice(0, colIdx + 1);
          nextColumns[colIdx] = { ...nextColumns[colIdx], selected: entry };
          nextColumns.push(next);
          return nextColumns;
        });

        if (options.focusNextColumn) {
          setActiveColumnIdx(colIdx + 1);
        }
      } catch {
        setColumns((prev) => prev.slice(0, colIdx + 1));
      }
    }
  }, [loadColumn]);

  const moveSelection = useCallback((delta: number) => {
    const column = columns[activeColumnIdx];
    if (!column || column.entries.length === 0) return;
    const currentIndex = column.selected
      ? column.entries.findIndex((entry) => entry.path === column.selected?.path)
      : -1;
    const nextIndex = currentIndex < 0
      ? (delta >= 0 ? 0 : column.entries.length - 1)
      : Math.min(column.entries.length - 1, Math.max(0, currentIndex + delta));

    if (nextIndex === currentIndex) return;
    void handleSelect(activeColumnIdx, column.entries[nextIndex]);
  }, [activeColumnIdx, columns, handleSelect]);

  const openSelected = useCallback((focusNextColumn: boolean) => {
    const column = columns[activeColumnIdx];
    if (!column || column.entries.length === 0) return;
    const selected = column.selected ?? column.entries[0];
    void handleSelect(activeColumnIdx, selected, { focusNextColumn });
  }, [activeColumnIdx, columns, handleSelect]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      openSelected(true);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveColumnIdx((prev) => Math.max(0, prev - 1));
    }
  }, [moveSelection, openSelected]);

  if (rootError && columns.length === 0) {
    const needsPassword = isUserNotInitializedError(rootError);
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          p: 4,
          bgcolor: "background.default",
        }}
      >
        <Stack
          spacing={1.5}
          alignItems="center"
          sx={{ maxWidth: 520, textAlign: "center" }}
        >
          <Typography variant="subtitle1">
            {needsPassword
              ? "Set your password to access files"
              : "Cannot load files"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {needsPassword
              ? "Open Settings, fill in (or verify) your password, then click Save & Run Bootstrap."
              : rootError.message}
          </Typography>
          {onOpenSettings && (
            <Button
              variant="contained"
              size="small"
              startIcon={<SettingsIcon fontSize="small" />}
              onClick={onOpenSettings}
            >
              Open Settings
            </Button>
          )}
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }} onKeyDown={handleKeyDown}>
      <Box
        sx={{
          px: 1,
          py: 0.5,
          fontSize: 11,
          color: "text.secondary",
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.default",
        }}
      >
        Navigation: Up/Down select, Right or Enter open, Left go back
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, direction: "ltr" }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId="altastata-console-miller"
          dir="ltr"
        >
          {columns.map((col, idx) => (
            <Fragment key={`${idx}-${col.path}`}>
              <Panel
                id={`miller-col-${col.path}`}
                order={idx}
                defaultSize={getColumnDefaultSize(columns.length)}
                minSize={12}
              >
                <FileColumn
                  title={col.title}
                  isActive={idx === activeColumnIdx}
                  entries={col.entries}
                  selected={col.selected}
                  onActivate={() => setActiveColumnIdx(idx)}
                  onSelect={(e) => void handleSelect(idx, e)}
                />
              </Panel>
              <PanelResizeHandle
                style={{
                  width: 6,
                  cursor: "col-resize",
                  background: "rgba(0,0,0,0.18)",
                }}
              />
            </Fragment>
          ))}
          <Panel
            id="miller-preview"
            order={columns.length}
            defaultSize={38}
            minSize={20}
          >
            <PreviewPane file={previewFile} />
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}
