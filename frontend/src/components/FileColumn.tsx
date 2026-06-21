import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import FolderIcon from "@mui/icons-material/Folder";
import FolderDeleteIcon from "@mui/icons-material/FolderDelete";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ImageIcon from "@mui/icons-material/Image";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import DescriptionIcon from "@mui/icons-material/Description";
import TableChartIcon from "@mui/icons-material/TableChart";
import ArchiveIcon from "@mui/icons-material/Archive";
import CodeIcon from "@mui/icons-material/Code";
import MovieIcon from "@mui/icons-material/Movie";
import AudioFileIcon from "@mui/icons-material/AudioFile";
import type { FileEntry } from "@/types";
import {
  isEntryDeleting,
  isRecursiveDeleteRoot,
  type DeletingTarget,
} from "@/utils/deletingTargets";

interface Props {
  title: string;
  isActive: boolean;
  entries: FileEntry[];
  selectedPaths: Set<string>;
  deletingTargets?: DeletingTarget[];
  onActivate: () => void;
  onSelect: (entry: FileEntry, modifiers: { ctrl: boolean; shift: boolean }) => void;
}

function ext(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function deletingIcon(entry: FileEntry) {
  if (entry.is_dir) {
    return <FolderDeleteIcon fontSize="small" sx={{ color: "warning.main" }} />;
  }
  return <DeleteOutlineIcon fontSize="small" sx={{ color: "warning.main" }} />;
}

function fileIcon(entry: FileEntry) {
  if (entry.is_dir) return <FolderIcon fontSize="small" sx={{ color: "#1976d2" }} />;

  const mime = entry.mime_type?.toLowerCase() ?? "";
  const extension = ext(entry.name);

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension)) {
    return <ImageIcon fontSize="small" sx={{ color: "success.main" }} />;
  }
  if (mime === "application/pdf" || extension === "pdf") {
    return <PictureAsPdfIcon fontSize="small" sx={{ color: "error.main" }} />;
  }
  if (mime.startsWith("text/") || ["txt", "md", "log", "rtf"].includes(extension)) {
    return <DescriptionIcon fontSize="small" sx={{ color: "text.secondary" }} />;
  }
  if (mime === "text/csv" || ["csv", "tsv", "xlsx", "xls"].includes(extension)) {
    return <TableChartIcon fontSize="small" sx={{ color: "success.dark" }} />;
  }
  if (["json", "xml", "yaml", "yml", "ts", "tsx", "js", "jsx", "java", "py", "go", "sql", "sh", "css", "html"].includes(extension)) {
    return <CodeIcon fontSize="small" sx={{ color: "secondary.main" }} />;
  }
  if (["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"].includes(extension)) {
    return <ArchiveIcon fontSize="small" sx={{ color: "warning.main" }} />;
  }
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(extension)) {
    return <MovieIcon fontSize="small" sx={{ color: "primary.main" }} />;
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a"].includes(extension)) {
    return <AudioFileIcon fontSize="small" sx={{ color: "primary.main" }} />;
  }
  return <InsertDriveFileIcon fontSize="small" />;
}

export default function FileColumn({
  title,
  isActive,
  entries,
  selectedPaths,
  deletingTargets,
  onActivate,
  onSelect,
}: Props) {
  return (
    <Box
      tabIndex={0}
      onFocus={onActivate}
      onMouseDown={onActivate}
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
        borderRight: 1,
        borderColor: isActive ? "primary.main" : "divider",
        outline: "none",
      }}
    >
      <Box
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
          fontSize: 12,
          fontWeight: 600,
          color: isActive ? "primary.main" : "text.secondary",
          textTransform: "lowercase",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={title}
      >
        {title}
      </Box>
      <List dense disablePadding sx={{ flex: 1, overflow: "auto" }}>
        {entries.map((entry) => {
          const isSelected = selectedPaths.has(entry.path);
          const isDeleting = isEntryDeleting(entry, deletingTargets);
          const isDeleteRoot = isRecursiveDeleteRoot(entry, deletingTargets);
          const showDeletingChrome = isDeleting && !isDeleteRoot;
          return (
            <ListItemButton
              key={entry.path}
              selected={isSelected}
              disabled={showDeletingChrome && !entry.is_dir}
              onClick={(event) => {
                if (showDeletingChrome && !entry.is_dir) return;
                onActivate();
                onSelect(entry, {
                  ctrl: event.ctrlKey || event.metaKey,
                  shift: event.shiftKey,
                });
              }}
              sx={{
                pr: 0.5,
                userSelect: "none",
                opacity: showDeletingChrome ? 0.65 : 1,
              }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                {showDeletingChrome ? deletingIcon(entry) : fileIcon(entry)}
              </ListItemIcon>
              <ListItemText
                primary={showDeletingChrome ? `${entry.name} (deleting…)` : entry.name}
                primaryTypographyProps={{
                  noWrap: true,
                  variant: "body2",
                  sx: showDeletingChrome
                    ? { fontStyle: "italic", color: "warning.main" }
                    : undefined,
                }}
              />
              {entry.is_dir && (
                <ChevronRightIcon fontSize="small" sx={{ opacity: 0.5 }} />
              )}
            </ListItemButton>
          );
        })}
        {entries.length === 0 && (
          <Box sx={{ px: 1.5, py: 1, fontSize: 12, color: "text.secondary" }}>
            Empty folder
          </Box>
        )}
      </List>
    </Box>
  );
}
