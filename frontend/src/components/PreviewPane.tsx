import { useEffect, useState } from "react";
import { Box, Stack, Typography } from "@mui/material";
import { fetchFilePreviewMetadata, fetchPreviewBlob, type FilePreviewMetadata } from "@/api/altastata";
import type { FileEntry } from "@/types";

interface Props {
  file: FileEntry | null;
}

const MAX_INLINE_TEXT_BYTES = 256 * 1024;
const MAX_INLINE_TEXT_CHARS = 20_000;

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString("en-US")} B`;
}

function clampTextPreview(value: string): string {
  if (value.length <= MAX_INLINE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_INLINE_TEXT_CHARS)}\n\n... preview truncated ...`;
}

export default function PreviewPane({ file }: Props) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<FilePreviewMetadata | null>(null);

  useEffect(() => {
    if (!file || file.is_dir) {
      setMetadata(null);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const details = await fetchFilePreviewMetadata(file.path, file.version);
        if (disposed) return;
        setMetadata(details);
      } catch {
        if (disposed) return;
        setMetadata(null);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [file]);

  useEffect(() => {
    if (!file || file.is_dir) {
      setPreviewSrc(null);
      setTextPreview(null);
      setLoading(false);
      setPreviewError(null);
      return;
    }
    const isImage = file.mime_type?.startsWith("image/");
    const isPdf = file.mime_type === "application/pdf";
    const isText = file.mime_type?.startsWith("text/");
    if (!isImage && !isPdf && !isText) {
      setPreviewSrc(null);
      setTextPreview(null);
      setLoading(false);
      setPreviewError(null);
      return;
    }

    let disposed = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setPreviewError(null);
    setPreviewSrc(null);
    setTextPreview(null);

    void (async () => {
      try {
        if (isText) {
          if (file.size != null && file.size > MAX_INLINE_TEXT_BYTES) {
            if (!disposed) {
              setPreviewError(
                `Text preview is disabled for files larger than ${formatBytes(MAX_INLINE_TEXT_BYTES)}.`,
              );
            }
            return;
          }
        }

        const blob = await fetchPreviewBlob(file.path, file.version, file.mime_type);
        if (disposed) return;

        if (isText) {
          const text = await blob.text();
          if (disposed) return;
          setTextPreview(clampTextPreview(text));
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setPreviewSrc(objectUrl);
      } catch (error) {
        if (disposed) return;
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!file) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
          bgcolor: "background.paper",
        }}
      >
        <Typography variant="body2">Select a file to preview</Typography>
      </Box>
    );
  }

  const isImage = file.mime_type?.startsWith("image/");
  const isPdf = file.mime_type === "application/pdf";
  const isText = file.mime_type?.startsWith("text/");
  const resolvedSize = metadata?.size ?? file.size;
  const resolvedReaders = metadata?.readers.length ? metadata.readers : file.readers;

  if (file.is_dir) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.paper",
        }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="subtitle2" noWrap>
            {file.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Folder: {file.path}
          </Typography>
        </Box>
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            p: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Folder selected. Choose a file to preview.
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="subtitle2" noWrap>
          {file.name}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Size: {formatBytes(resolvedSize)}
          </Typography>
          {file.created && (
            <Typography variant="caption" color="text.secondary">
              | Created: {file.created}
            </Typography>
          )}
        </Stack>
        {metadata?.tag && (
          <Typography variant="caption" color="text.secondary" display="block">
            Tag: {metadata.tag}
          </Typography>
        )}
        {resolvedReaders.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            Readers: {resolvedReaders.join(", ")}
          </Typography>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {loading && (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Loading preview...
            </Typography>
          </Box>
        )}
        {previewError && (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="error.main">
              {previewError}
            </Typography>
          </Box>
        )}
        {isImage && previewSrc && !loading && !previewError && (
          <img
            src={previewSrc}
            alt={file.name}
            style={{ maxWidth: "100%", display: "block", margin: "0 auto" }}
          />
        )}
        {isPdf && previewSrc && !loading && !previewError && (
          <iframe
            title={file.name}
            src={previewSrc}
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        )}
        {isText && !loading && !previewError && (
          <Box sx={{ p: 2 }}>
            <Typography
              component="pre"
              sx={{
                m: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
              }}
            >
              {textPreview ?? "(Empty file)"}
            </Typography>
          </Box>
        )}
        {!loading && !previewError && !isImage && !isPdf && !isText && (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No inline preview for {file.mime_type ?? "this file type"}.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
