import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { NewFolderDialogState } from "./types";

interface Props {
  open: boolean;
  activePath: string;
  state: NewFolderDialogState | null;
  onClose: () => void;
  onChange: (next: NewFolderDialogState) => void;
  onSubmit: () => void;
}

export default function NewFolderDialog({
  open,
  activePath,
  state,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 1 }}>New folder</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Inside: {activePath}
          </Typography>
          <TextField
            autoFocus
            size="small"
            label="Folder name"
            placeholder="my-folder"
            value={state?.name ?? ""}
            onChange={(e) => {
              if (!state) return;
              onChange({
                ...state,
                name: e.target.value,
                error: null,
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
            fullWidth
          />
          <Typography variant="caption" color="text.secondary">
            The folder is local to this browser session until you upload a
            file into it. AltaStata stores files keyed by path prefix, so an
            empty folder has no on-cloud representation.
          </Typography>
          {state?.error && (
            <Typography variant="caption" color="error.main">
              {state.error}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={onSubmit}
          disabled={!state?.name.trim()}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
