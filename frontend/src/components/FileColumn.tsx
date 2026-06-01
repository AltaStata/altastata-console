import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import FolderIcon from "@mui/icons-material/Folder";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { FileEntry } from "@/types";

interface Props {
  title: string;
  isActive: boolean;
  entries: FileEntry[];
  selected: FileEntry | null;
  onActivate: () => void;
  onSelect: (entry: FileEntry) => void;
}

export default function FileColumn({
  title,
  isActive,
  entries,
  selected,
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
          const isSelected = selected?.path === entry.path;
          return (
            <ListItemButton
              key={entry.path}
              selected={isSelected}
              onClick={() => {
                onActivate();
                onSelect(entry);
              }}
              sx={{ pr: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                {entry.is_dir ? (
                  <FolderIcon fontSize="small" sx={{ color: "#1976d2" }} />
                ) : (
                  <InsertDriveFileIcon fontSize="small" />
                )}
              </ListItemIcon>
              <ListItemText
                primary={entry.name}
                primaryTypographyProps={{ noWrap: true, variant: "body2" }}
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
