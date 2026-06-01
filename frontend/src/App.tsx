import { useEffect, useState } from "react";
import { AppBar, Box, Toolbar, Typography } from "@mui/material";
import { getAccount } from "@/api/altastata";
import type { AccountInfo, FileEntry } from "@/types";
import MillerColumns from "@/components/MillerColumns";
import BottomToolbar from "@/components/BottomToolbar";

export default function App() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [activePath, setActivePath] = useState("/");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    getAccount()
      .then(setAccount)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar variant="dense" sx={{ minHeight: 32, justifyContent: "center" }}>
          <Typography variant="caption">
            {account?.account_id ?? error ?? "loading..."}
          </Typography>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <MillerColumns
          reloadToken={reloadToken}
          onSelectionContextChange={(selected, currentPath) => {
            setSelectedEntry(selected);
            setActivePath(currentPath);
          }}
        />
      </Box>

      <BottomToolbar
        selectedEntry={selectedEntry}
        activePath={activePath}
        onRefresh={() => setReloadToken((prev) => prev + 1)}
      />
    </Box>
  );
}
