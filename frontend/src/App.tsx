import { useEffect, useState } from "react";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  applyRuntimeSettings,
  bootstrapCurrentSettings,
  getAccount,
  setPasswordForCurrentSettings,
} from "@/api/altastata";
import { getRuntimeSettings, updateRuntimeSettings, type RuntimeSettings } from "@/config/runtimeSettings";
import type { AccountInfo, FileEntry } from "@/types";
import MillerColumns from "@/components/MillerColumns";
import BottomToolbar from "@/components/BottomToolbar";

export default function App() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [activePath, setActivePath] = useState("/");
  const [reloadToken, setReloadToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<RuntimeSettings>(getRuntimeSettings());
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  useEffect(() => {
    getAccount()
      .then(setAccount)
      .catch((e) => setError(String(e)));
  }, []);

  const openSettings = () => {
    setSettingsDraft(getRuntimeSettings());
    setSettingsStatus(null);
    setSettingsError(null);
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    if (settingsBusy) return;
    setSettingsOpen(false);
  };

  const setField = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => {
    setSettingsDraft((prev) => ({ ...prev, [key]: value }));
  };

  const persistAndRefresh = async (): Promise<RuntimeSettings> => {
    const saved = updateRuntimeSettings(settingsDraft);
    applyRuntimeSettings();
    setAccount(await getAccount());
    setError(null);
    setReloadToken((prev) => prev + 1);
    return saved;
  };

  const handleSave = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsStatus(null);
    try {
      const saved = await persistAndRefresh();
      setSettingsDraft(saved);
      setSettingsStatus("Settings saved.");
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSaveAndRunBootstrap = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsStatus("Saving settings and running bootstrap...");
    try {
      const saved = await persistAndRefresh();
      setSettingsDraft(saved);
      await bootstrapCurrentSettings();
      setSettingsStatus("Bootstrap succeeded.");
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
      setSettingsStatus(null);
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSetPasswordOnly = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsStatus("Saving settings and calling SetPasswordForUser...");
    try {
      const saved = await persistAndRefresh();
      setSettingsDraft(saved);
      await setPasswordForCurrentSettings();
      setSettingsStatus("SetPasswordForUser succeeded.");
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
      setSettingsStatus(null);
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar variant="dense" sx={{ minHeight: 32, justifyContent: "space-between" }}>
          <Typography variant="caption" sx={{ ml: 1 }}>
            {account?.account_id ?? error ?? "loading..."}
          </Typography>
          <Tooltip title="Connection settings">
            <span>
              <IconButton size="small" onClick={openSettings}>
                <SettingsIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <MillerColumns
          reloadToken={reloadToken}
          onSelectionContextChange={(selected, currentPath) => {
            setSelectedEntry(selected);
            setActivePath(currentPath);
          }}
          onOpenSettings={openSettings}
        />
      </Box>

      <BottomToolbar
        selectedEntry={selectedEntry}
        activePath={activePath}
        onRefresh={() => setReloadToken((prev) => prev + 1)}
      />

      <Dialog
        open={settingsOpen}
        onClose={closeSettings}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>AltaStata Settings</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {settingsStatus && <Alert severity="success">{settingsStatus}</Alert>}
            {settingsError && <Alert severity="error">{settingsError}</Alert>}

            <TextField
              label="gRPC base URL"
              value={settingsDraft.grpcBaseUrl}
              onChange={(e) => setField("grpcBaseUrl", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
            />
            <TextField
              label="Account ID"
              value={settingsDraft.accountId}
              onChange={(e) => setField("accountId", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
            />
            <TextField
              label="User name"
              value={settingsDraft.userName}
              onChange={(e) => setField("userName", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
            />
            <TextField
              label="Password"
              type="password"
              value={settingsDraft.accountPassword}
              onChange={(e) => setField("accountPassword", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
            />
            <TextField
              label="User properties"
              value={settingsDraft.userProperties}
              onChange={(e) => setField("userProperties", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              multiline
              minRows={6}
              maxRows={12}
            />
            <TextField
              label="Private key"
              value={settingsDraft.privateKey}
              onChange={(e) => setField("privateKey", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              multiline
              minRows={6}
              maxRows={12}
            />
            <FormControlLabel
              control={(
                <Switch
                  checked={settingsDraft.autoBootstrap}
                  onChange={(e) => setField("autoBootstrap", e.target.checked)}
                  disabled={settingsBusy}
                />
              )}
              label="Auto bootstrap"
            />
            <TextField
              label="Bootstrap mode"
              value={settingsDraft.bootstrapMode}
              onChange={(e) => setField("bootstrapMode", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
              helperText="Use auto or full."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSettings} disabled={settingsBusy}>Close</Button>
          <Button onClick={() => void handleSave()} disabled={settingsBusy} variant="outlined">Save</Button>
          <Button onClick={() => void handleSetPasswordOnly()} disabled={settingsBusy} variant="outlined">
            Save & Set Password Only
          </Button>
          <Button onClick={() => void handleSaveAndRunBootstrap()} disabled={settingsBusy} variant="contained">
            Save & Run Bootstrap
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
