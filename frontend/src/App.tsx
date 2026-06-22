import { useCallback, useEffect, useRef, useState } from "react";
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
import VpnKeyIcon from "@mui/icons-material/VpnKey";
import TerminalIcon from "@mui/icons-material/Terminal";
import {
  accountFolderRequiresPrivateKeyFiles,
  accountLoginRequiresPassword,
} from "@/api/accountFolder";
import {
  applyRuntimeSettings,
  bootstrapCurrentSettings,
  getAccount,
  hasSessionAccountMaterial,
  loadAccountFolderFromPicker,
  subscribeToAltaStataEvents,
} from "@/api/altastata";
import { getSessionAccountMaterial } from "@/session/accountMaterial";
import { getRuntimeSettings, updateRuntimeSettings, type RuntimeSettings } from "@/config/runtimeSettings";
import type { AccountInfo, FileEntry } from "@/types";
import MillerColumns from "@/components/MillerColumns";
import BottomToolbar from "@/components/BottomToolbar";
import LogDialog from "@/components/LogDialog";
import CreateAccountDialog from "@/components/CreateAccountDialog";
import { installLogBuffer } from "@/utils/logBuffer";
import {
  mergeDeletingTargets,
  removeDeletingTargets,
  type DeletingTarget,
} from "@/utils/deletingTargets";

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
  const [accountFolderLabel, setAccountFolderLabel] = useState<string | null>(null);
  const accountFolderInputRef = useRef<HTMLInputElement | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  // Client-only "pending" folders. AltaStata stores files keyed by `/`-separated
  // prefixes, so a folder is just the implicit parent of one or more files.
  // Until the user uploads a file into a freshly-created folder, that folder
  // does not exist in the cloud at all -- mirroring `altastata-ui` (JavaFX)
  // which calls `addCloudFileInUploadingProcess` to keep the new directory
  // visible in the navigation pane without a backend call. We track the same
  // thing here as a flat set of full paths, e.g. `Set { "/foo", "/foo/bar" }`.
  // The `MillerColumns` view merges these into the listing for the matching
  // parent column, and they are pruned automatically on a refresh once the
  // backend's listing contains a real folder with the same path.
  const [pendingFolderPaths, setPendingFolderPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [deletingTargets, setDeletingTargets] = useState<DeletingTarget[]>([]);

  useEffect(() => {
    getAccount()
      .then(setAccount)
      .catch((e) => setError(String(e)));
  }, []);

  const addPendingFolder = useCallback((fullPath: string) => {
    setPendingFolderPaths((prev) => {
      if (prev.has(fullPath)) return prev;
      const next = new Set(prev);
      next.add(fullPath);
      return next;
    });
  }, []);

  const markPathsDeleting = useCallback((targets: DeletingTarget[]) => {
    setDeletingTargets((prev) => mergeDeletingTargets(prev, targets));
  }, []);

  const unmarkPathsDeleting = useCallback((targets: DeletingTarget[]) => {
    setDeletingTargets((prev) => removeDeletingTargets(prev, targets));
  }, []);

  // When MillerColumns reloads the backend listing and now sees a real folder
  // with the same path as one of our pending entries, drop the pending one so
  // the entry list stays clean (no duplicate icon for the same folder, no
  // ghost left behind when the user later deletes the folder).
  const reconcilePendingFolders = useCallback((realFolderPaths: Set<string>) => {
    setPendingFolderPaths((prev) => {
      let mutated = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (realFolderPaths.has(p)) {
          mutated = true;
          continue;
        }
        next.add(p);
      }
      return mutated ? next : prev;
    });
  }, []);

  // Stable callback for MillerColumns. If we let JSX inline this, App's
  // `<MillerColumns onSelectionContextChange={(...) => ...}>` would hand
  // MillerColumns a fresh function reference on every render, which retriggers
  // its selection-context effect, which calls back into us with a new `[]`
  // array (or a freshly filtered one), which sets new state here, which
  // re-renders App, which mints another fresh function reference, ad
  // infinitum -- the classic "Maximum update depth exceeded" loop.
  // We also short-circuit when the values are content-equal so React can bail
  // out of the inevitable extra render after the columns settle.
  const handleSelectionContextChange = useCallback(
    (entries: FileEntry[], currentPath: string) => {
      setSelectedEntries((prev) => {
        if (prev.length === entries.length && prev.every((e, i) => e === entries[i])) {
          return prev;
        }
        return entries;
      });
      setActivePath((prev) => (prev === currentPath ? prev : currentPath));
    },
    [],
  );

  const handleRefresh = useCallback(() => {
    setReloadToken((prev) => prev + 1);
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

  const openSettings = useCallback(() => {
    setSettingsDraft(getRuntimeSettings());
    const material = getSessionAccountMaterial();
    setAccountFolderLabel(material
      ? `${material.displayName} (${material.myUser})`
      : null);
    setSettingsStatus(null);
    setSettingsError(null);
    setSettingsOpen(true);
  }, []);

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

  const handleSaveAndSignIn = async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsStatus("Signing in...");
    try {
      const saved = await persistAndRefresh();
      setSettingsDraft(saved);
      if (!hasSessionAccountMaterial()) {
        throw new Error("Choose an account folder before signing in.");
      }
      await bootstrapCurrentSettings();
      setSettingsStatus("Signed in.");
      handleRefresh();
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
      setSettingsStatus(null);
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleAccountFolderSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      setSettingsError("No files received from folder picker. Try again, or use Chrome/Edge/Safari.");
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    setSettingsStatus("Loading account folder...");
    try {
      await loadAccountFolderFromPicker(files);
      const material = getSessionAccountMaterial();
      setAccountFolderLabel(material
        ? `${material.displayName} (${material.myUser})`
        : null);
      if (material) {
        setSettingsDraft((prev) => ({
          ...prev,
          userName: material.myUser,
          accountId: material.displayName || material.myUser,
        }));
      }
      const needsPassword = material
        ? accountLoginRequiresPassword(material.userProperties)
        : true;
      setSettingsStatus(needsPassword
        ? "Account folder loaded. Enter password and click Sign in."
        : "Account folder loaded. Click Sign in (no password needed for this account type).");
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : String(e));
      setSettingsStatus(null);
      setAccountFolderLabel(null);
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
            <Tooltip title="Generate keys">
              <span>
                <IconButton size="small" onClick={() => setCreateAccountOpen(true)}>
                  <VpnKeyIcon fontSize="small" />
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

      <CreateAccountDialog
        open={createAccountOpen}
        onClose={() => setCreateAccountOpen(false)}
      />

      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <MillerColumns
          reloadToken={reloadToken}
          pendingFolderPaths={pendingFolderPaths}
          deletingTargets={deletingTargets}
          onRealFolderPaths={reconcilePendingFolders}
          onSelectionContextChange={handleSelectionContextChange}
          onOpenSettings={openSettings}
        />
      </Box>

      <BottomToolbar
        selectedEntries={selectedEntries}
        activePath={activePath}
        pendingFolderPaths={pendingFolderPaths}
        onAddPendingFolder={addPendingFolder}
        onMarkPathsDeleting={markPathsDeleting}
        onUnmarkPathsDeleting={unmarkPathsDeleting}
        onRefresh={handleRefresh}
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
              label="Account ID (display)"
              value={settingsDraft.accountId}
              onChange={(e) => setField("accountId", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
              helperText="Updated when you choose an account folder."
            />
            <TextField
              label="Password"
              type="password"
              value={settingsDraft.accountPassword}
              onChange={(e) => setField("accountPassword", e.target.value)}
              disabled={settingsBusy}
              fullWidth
              size="small"
              helperText={(() => {
                const material = getSessionAccountMaterial();
                if (material && !accountLoginRequiresPassword(material.userProperties)) {
                  return "Not required for HSM or HPCS accounts — leave blank and click Sign in.";
                }
                return undefined;
              })()}
            />
            <input
              ref={(node) => {
                accountFolderInputRef.current = node;
                if (node) {
                  node.setAttribute("webkitdirectory", "");
                  node.setAttribute("directory", "");
                }
              }}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => void handleAccountFolderSelected(e)}
            />
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="outlined"
                disabled={settingsBusy}
                onClick={() => accountFolderInputRef.current?.click()}
              >
                Choose account folder
              </Button>
              <Typography variant="body2" color="text.secondary">
                {accountFolderLabel ?? (() => {
                  const material = getSessionAccountMaterial();
                  if (material && !accountFolderRequiresPrivateKeyFiles(material.userProperties)) {
                    return "No folder selected (pick *user.properties — HSM accounts have no local private key)";
                  }
                  return "No folder selected (pick *user.properties + private keys)";
                })()}
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Pick one account folder (e.g. rsa.bob123), not the parent accounts directory.
            </Typography>
            <FormControlLabel
              control={(
                <Switch
                  checked={settingsDraft.autoBootstrap}
                  onChange={(e) => setField("autoBootstrap", e.target.checked)}
                  disabled={settingsBusy}
                />
              )}
              label="Auto sign-in on first file operation"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSettings} disabled={settingsBusy}>Close</Button>
          <Button onClick={() => void handleSave()} disabled={settingsBusy} variant="outlined">Save</Button>
          <Button onClick={() => void handleSaveAndSignIn()} disabled={settingsBusy} variant="contained">
            Sign in
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
