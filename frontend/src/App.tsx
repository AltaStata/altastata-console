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
import TerminalIcon from "@mui/icons-material/Terminal";
import {
  applyRuntimeSettings,
  bootstrapCurrentSettings,
  getAccount,
  setPasswordForCurrentSettings,
  subscribeToAltaStataEvents,
} from "@/api/altastata";
import { getRuntimeSettings, updateRuntimeSettings, type RuntimeSettings } from "@/config/runtimeSettings";
import type { AccountInfo, FileEntry } from "@/types";
import MillerColumns from "@/components/MillerColumns";
import BottomToolbar from "@/components/BottomToolbar";
import LogDialog from "@/components/LogDialog";
import { installLogBuffer } from "@/utils/logBuffer";

// Install once at module load so we capture every console.* call from then on,
// including the very first network errors before <App /> mounts.
installLogBuffer();

export default function App() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState("/");
  const [reloadToken, setReloadToken] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<RuntimeSettings>(getRuntimeSettings());
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    getAccount()
      .then(setAccount)
      .catch((e) => setError(String(e)));
  }, []);

  // Long-lived subscription to AltaStata events. The backend fires `SHARE`
  // when another user shares a file with us, and `DELETE` when our access is
  // revoked / a shared file is deleted. We use any event as a cue to reload
  // the current view so the user never sees a stale list.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    let controller = new AbortController();
    let retryHandle: number | undefined;
    const RECONNECT_DELAY_MS = 5_000;
    // SecureCloudEventProcessor fires the SHARE/DELETE event before its
    // background "Finishing shot" step finalises the inbound metadata, so a
    // listDir issued in the immediate event handler can still miss the new
    // file. We schedule a follow-up refresh ~7s later to pick it up. Empirical
    // gap observed in altastata-grpc logs is around 5s; pad it a bit.
    const FOLLOWUP_REFRESH_MS = 7_000;
    const followUpHandles = new Set<number>();

    const run = async () => {
      while (!cancelled) {
        controller = new AbortController();
        try {
          // eslint-disable-next-line no-console
          console.info("[altastata] subscribing to events");
          await subscribeToAltaStataEvents(
            () => {
              if (cancelled) return;
              // eslint-disable-next-line no-console
              console.info("[altastata] event received -> reloading view");
              setReloadToken((prev) => prev + 1);
              const handle = window.setTimeout(() => {
                followUpHandles.delete(handle);
                if (cancelled) return;
                // eslint-disable-next-line no-console
                console.info("[altastata] follow-up refresh after event lag");
                setReloadToken((prev) => prev + 1);
              }, FOLLOWUP_REFRESH_MS);
              followUpHandles.add(handle);
            },
            controller.signal,
          );
          if (cancelled) return;
          // eslint-disable-next-line no-console
          console.info("[altastata] event stream closed by server");
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          // eslint-disable-next-line no-console
          console.warn("[altastata] event subscription error, reconnecting", err);
        }
        if (cancelled) return;
        await new Promise<void>((resolve) => {
          retryHandle = window.setTimeout(() => {
            retryHandle = undefined;
            resolve();
          }, RECONNECT_DELAY_MS);
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (retryHandle !== undefined) window.clearTimeout(retryHandle);
      followUpHandles.forEach((h) => window.clearTimeout(h));
      followUpHandles.clear();
      controller.abort();
    };
  }, [account]);

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
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Tooltip title="View log">
              <span>
                <IconButton size="small" onClick={() => setLogOpen(true)}>
                  <TerminalIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Connection settings">
              <span>
                <IconButton size="small" onClick={openSettings}>
                  <SettingsIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>

      <LogDialog open={logOpen} onClose={() => setLogOpen(false)} />

      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <MillerColumns
          reloadToken={reloadToken}
          onSelectionContextChange={(entries, currentPath) => {
            setSelectedEntries(entries);
            setActivePath(currentPath);
          }}
          onOpenSettings={openSettings}
        />
      </Box>

      <BottomToolbar
        selectedEntries={selectedEntries}
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
            {/* Self-identifying build header so it is unambiguous which bundle
                the browser actually loaded (cache-busting questions otherwise
                require diffing hashed asset names by hand). */}
            <Typography variant="caption" color="text.secondary">
              UI build {__APP_VERSION__} · {__APP_BUILD_TIME__}
            </Typography>
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
