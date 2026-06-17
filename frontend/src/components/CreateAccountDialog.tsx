import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  accountTypeRequiresPassword,
  ALL_ACCOUNT_KEY_TYPES,
  generateAccountKeys,
  getSupportedAccountTypes,
  type AccountKeyType,
  type GenerateKeysResult,
} from "@/api/altastata";
import { getRuntimeSettings } from "@/config/runtimeSettings";
import {
  accountZipArchiveName,
  buildAccountZipBlob,
  triggerBrowserDownload,
} from "@/utils/accountZip";

const ACCOUNT_TYPE_LABELS: Record<AccountKeyType, string> = {
  RSA: "RSA",
  PQC: "PQC (post-quantum)",
  HPCS: "HPCS (RSA)",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function CreateAccountDialog({ open, onClose }: Props) {
  const [supportedTypes, setSupportedTypes] = useState<AccountKeyType[]>(ALL_ACCOUNT_KEY_TYPES);
  const [typesLoading, setTypesLoading] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);

  const [accountType, setAccountType] = useState<AccountKeyType>("RSA");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateKeysResult | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setPassword("");
    setDisplayName("");
    setError(null);
    setResult(null);
    setDownloadStatus(null);
    setBusy(false);
  }, []);

  const handleClose = () => {
    if (busy) return;
    resetForm();
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    resetForm();
    setTypesLoading(true);
    setTypesError(null);
    void getSupportedAccountTypes()
      .then((types) => {
        setSupportedTypes(types);
        if (types.length > 0) {
          setAccountType(types[0]);
        }
      })
      .catch((e) => {
        setTypesError(e instanceof Error ? e.message : String(e));
        setSupportedTypes(ALL_ACCOUNT_KEY_TYPES);
      })
      .finally(() => setTypesLoading(false));
  }, [open, resetForm]);

  const passwordRequired = accountTypeRequiresPassword(accountType);

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    setDownloadStatus(null);
    try {
      if (passwordRequired && !password) {
        throw new Error("Password is required for RSA and PQC accounts.");
      }
      const generated = await generateAccountKeys({
        accountType,
        password,
        suggestedDisplayName: displayName,
      });
      setResult(generated);
      setDisplayName(generated.displayName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadZip = async () => {
    if (!result) return;
    setDownloadStatus("Preparing zip...");
    try {
      const blob = await buildAccountZipBlob(result.displayName, result.accountFiles);
      triggerBrowserDownload(blob, accountZipArchiveName(result.displayName));
      setDownloadStatus("Download started. Save the zip somewhere safe.");
    } catch (e) {
      setDownloadStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const grpcUrl = getRuntimeSettings().grpcBaseUrl;

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Create account</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            Generates encryption keys via the gateway ({grpcUrl}). Keys are not
            stored on the server — download the zip and keep it on your machine.
          </Typography>

          {typesLoading && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2">Loading supported account types...</Typography>
            </Box>
          )}
          {typesError && <Alert severity="error">{typesError}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          {downloadStatus && <Alert severity="success">{downloadStatus}</Alert>}

          {!result ? (
            <>
              <FormControl fullWidth size="small" disabled={busy || typesLoading || supportedTypes.length === 0}>
                <InputLabel id="create-account-type-label">Account type</InputLabel>
                <Select
                  labelId="create-account-type-label"
                  label="Account type"
                  value={supportedTypes.includes(accountType) ? accountType : ""}
                  onChange={(e) => setAccountType(e.target.value as AccountKeyType)}
                >
                  {supportedTypes.map((type) => (
                    <MenuItem key={type} value={type}>
                      {ACCOUNT_TYPE_LABELS[type]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label="Folder name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={busy}
                fullWidth
                size="small"
                placeholder="rsa.myuser"
                helperText="Suggested name for ~/.altastata/accounts/&lt;name&gt;/. Leave blank for a random name."
              />

              <TextField
                label={passwordRequired ? "Password" : "Password (not used for HPCS)"}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy || !passwordRequired}
                fullWidth
                size="small"
                helperText={
                  passwordRequired
                    ? "Encrypts your private key files in the zip."
                    : "HPCS stores the private key in the hardware security module."
                }
              />
            </>
          ) : (
            <>
              <Alert severity="success">
                Keys generated for folder
                {" "}
                <strong>{result.displayName}</strong>
                .
              </Alert>

              <Typography variant="subtitle2">Files in zip</Typography>
              <List dense disablePadding>
                {Object.keys(result.accountFiles).sort().map((name) => (
                  <ListItem key={name} disableGutters>
                    <ListItemText primary={name} />
                  </ListItem>
                ))}
              </List>

              <Typography variant="subtitle2">Next steps</Typography>
              <Typography component="ol" variant="body2" color="text.secondary" sx={{ pl: 2, m: 0 }}>
                <li>Download the zip and unpack to a folder on your machine (e.g. ~/.altastata/accounts/).</li>
                <li>Send <code>public.key</code> (or PQC/HPCS public keys) to your org admin.</li>
                <li>Save the admin&apos;s <code>*user.properties</code> file into the same folder.</li>
                <li>Open Settings → choose that folder → Sign in.</li>
              </Typography>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          {result ? "Done" : "Cancel"}
        </Button>
        {!result ? (
          <Button
            variant="contained"
            onClick={() => void handleGenerate()}
            disabled={busy || typesLoading || supportedTypes.length === 0}
          >
            {busy ? "Generating..." : "Generate keys"}
          </Button>
        ) : (
          <Button variant="contained" onClick={() => void handleDownloadZip()}>
            Download zip
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
