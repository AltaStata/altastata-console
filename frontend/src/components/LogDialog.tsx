import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  clearLogEntries,
  subscribeLogEntries,
  type LogEntry,
  type LogLevel,
} from "@/utils/logBuffer";

interface Props {
  open: boolean;
  onClose: () => void;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  log: "#cccccc",
  debug: "#9aa0a6",
  info: "#8ab4f8",
  warn: "#f6b656",
  error: "#f28b82",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export default function LogDialog({ open, onClose }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return subscribeLogEntries(setEntries);
  }, []);

  const filtered = useMemo(() => {
    if (!filter) return entries;
    const needle = filter.toLowerCase();
    return entries.filter((e) => e.text.toLowerCase().includes(needle) || e.level.includes(needle));
  }, [entries, filter]);

  // Pin to the bottom whenever new entries arrive while autoScroll is on. We
  // intentionally key on filtered.length only — when the user scrolls back to
  // inspect old entries they should toggle autoScroll off first.
  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, autoScroll, filtered.length]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>UI log</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: "center" }}>
          <TextField
            size="small"
            label="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            sx={{ flex: 1 }}
          />
          <FormControlLabel
            control={(
              <Checkbox
                size="small"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
            )}
            label="Auto-scroll"
          />
          <Button
            size="small"
            variant="outlined"
            onClick={() => clearLogEntries()}
          >
            Clear
          </Button>
        </Stack>
        <Box
          ref={scrollRef}
          sx={{
            height: "60vh",
            overflowY: "auto",
            backgroundColor: "#1e1e1e",
            color: "#e8eaed",
            fontFamily: "Menlo, Consolas, monospace",
            fontSize: 12,
            lineHeight: 1.4,
            p: 1,
          }}
        >
          {filtered.length === 0 ? (
            <Typography variant="caption" sx={{ color: "#9aa0a6" }}>
              (no entries)
            </Typography>
          ) : (
            filtered.map((e) => (
              <Box
                key={e.id}
                sx={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: LEVEL_COLORS[e.level],
                }}
              >
                {`[${formatTime(e.timestamp)}] [${e.level.toUpperCase()}] ${e.text}`}
              </Box>
            ))
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
