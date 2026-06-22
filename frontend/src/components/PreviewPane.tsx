import { useEffect, useState } from "react";
import { Box, Stack, Typography } from "@mui/material";
import {
  fetchPreviewBlobCapped,
  fetchTextPreviewChunk,
} from "@/api/altastata";
import type { FileEntry } from "@/types";

interface Props {
  file: FileEntry | null;
}

const TEXT_PREVIEW_CHUNK_BYTES = 4 * 1024;
const PREVIEW_INLINE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_TEXT_CHARS = 20_000;
const MEDIA_PREVIEW_TIMEOUT_MS = 10_000;

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString("en-US")} B`;
}

function clampTextPreview(value: string): string {
  if (value.length <= MAX_INLINE_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_INLINE_TEXT_CHARS)}\n\n... preview truncated ...`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout != null) window.clearTimeout(timeout);
  }
}

export default function PreviewPane({ file }: Props) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!file || file.is_dir) {
      setPreviewSrc(null);
      setTextPreview(null);
      setLoading(false);
      setPreviewError(null);
      setPreviewNotice(null);
      return;
    }
    const isImage = file.mime_type?.startsWith("image/");
    const isPdf = file.mime_type === "application/pdf";
    const isText = file.mime_type?.startsWith("text/");
    const isVideo = file.mime_type?.startsWith("video/");
    const isAudio = file.mime_type?.startsWith("audio/");
    if (!isImage && !isPdf && !isText && !isVideo && !isAudio) {
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
    setPreviewNotice(null);
    setPreviewSrc(null);
    setTextPreview(null);

    void (async () => {
      try {
        if (isText) {
          const chunk = await fetchTextPreviewChunk(file.path, file.version, TEXT_PREVIEW_CHUNK_BYTES);
          if (disposed) return;
          setTextPreview(clampTextPreview(chunk.text));
          if (chunk.truncated) {
            setPreviewNotice(`Showing first ${formatBytes(chunk.bytesRead)} of this file.`);
          }
          return;
        }

        const { blob, truncated } = await withTimeout(
          fetchPreviewBlobCapped(
            file.path,
            file.version,
            file.mime_type,
            PREVIEW_INLINE_MAX_BYTES,
          ),
          isVideo || isAudio ? MEDIA_PREVIEW_TIMEOUT_MS : 30_000,
          "Preview request timed out",
        );
        if (disposed) return;

        if (truncated && (isVideo || isAudio)) {
          setPreviewNotice(
            `Cannot build ${isVideo ? "video" : "audio"} preview within ${formatBytes(PREVIEW_INLINE_MAX_BYTES)}. Download the file to open it fully.`,
          );
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setPreviewSrc(objectUrl);
        if (truncated) {
          setPreviewNotice(
            `Preview shows first ${formatBytes(PREVIEW_INLINE_MAX_BYTES)}. Download to access full file.`,
          );
        }
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        if ((isVideo || isAudio) && /preview request timed out/i.test(message)) {
          setPreviewNotice(
            `Cannot build ${isVideo ? "video" : "audio"} preview in time. Download the file to open it fully.`,
          );
          setPreviewError(null);
          return;
        }
        setPreviewError(message);
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
  const isVideo = file.mime_type?.startsWith("video/");
  const isAudio = file.mime_type?.startsWith("audio/");
  const sizeText = file.size != null
    ? formatBytes(file.size)
    : "—";

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
            Size: {sizeText}
          </Typography>
          {file.created && (
            <Typography variant="caption" color="text.secondary">
              | Created: {file.created}
            </Typography>
          )}
        </Stack>
        {file.readers.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            Readers: {file.readers.join(", ")}
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
        {previewNotice && !loading && !previewError && (
          <Box sx={{ px: 2, pt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              {previewNotice}
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
        {isVideo && previewSrc && !loading && !previewError && (
          <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
            <video
              src={previewSrc}
              controls
              preload="metadata"
              style={{ maxWidth: "100%", maxHeight: "100%", outline: "none" }}
            >
              Your browser cannot play this video.
            </video>
          </Box>
        )}
        {isAudio && previewSrc && !loading && !previewError && (
          <Box sx={{ p: 2 }}>
            <audio src={previewSrc} controls preload="metadata" style={{ width: "100%" }}>
              Your browser cannot play this audio file.
            </audio>
          </Box>
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
        {!loading && !previewError && !isImage && !isPdf && !isText && !isVideo && !isAudio && (
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
