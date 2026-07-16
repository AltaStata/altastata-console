import {
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AccessDialogState } from "./types";

interface Props {
  state: AccessDialogState | null;
  onClose: () => void;
  onChange: (next: AccessDialogState) => void;
  onSubmit: () => void;
}

export default function AccessDialog({
  state,
  onClose,
  onChange,
  onSubmit,
}: Props) {
  return (
    <Dialog
      open={state !== null}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle sx={{ pb: 1 }}>
        {state?.mode === "share" ? "Share access" : "Revoke access"}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {state
              ? state.targets.length === 1
                ? `${state.targets[0].is_dir ? "Folder" : "File"}: ${state.targets[0].path}`
                : `${state.targets.length} items selected`
              : ""}
          </Typography>
          <Autocomplete
            freeSolo
            size="small"
            options={state?.knownUsers ?? []}
            value={state?.selected ?? ""}
            onChange={(_, value) => {
              if (!state) return;
              onChange({
                ...state,
                selected: typeof value === "string" ? value : "",
                error: null,
              });
            }}
            onInputChange={(_, value) => {
              if (!state) return;
              onChange({ ...state, selected: value, error: null });
            }}
            loading={state?.loadingUsers ?? false}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                label={state?.mode === "share" ? "Share with user" : "Revoke from user"}
                placeholder="user.account"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {state?.loadingUsers
                        ? <CircularProgress color="inherit" size={16} />
                        : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />
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
          color={state?.mode === "revoke" ? "warning" : "primary"}
          onClick={onSubmit}
          disabled={!state || !state.selected.trim()}
        >
          {state?.mode === "share" ? "Share" : "Revoke"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
