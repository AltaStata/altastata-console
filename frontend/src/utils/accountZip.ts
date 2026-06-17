import { zip } from "fflate";

/** Zip filename for a freshly generated account folder. */
export function accountZipArchiveName(displayName: string): string {
  const safe = displayName.trim() || "altastata-account";
  return `${safe}.altastata.zip`;
}

/**
 * Build zip entry paths as {@code <displayName>/<basename>} so unpacking under
 * {@code ~/.altastata/accounts/} yields the canonical layout.
 */
export function buildAccountZipEntries(
  displayName: string,
  accountFiles: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const folder = displayName.trim().replace(/[/\\]+$/, "") || "altastata-account";
  const entries: Record<string, Uint8Array> = {};
  for (const [basename, bytes] of Object.entries(accountFiles)) {
    entries[`${folder}/${basename}`] = bytes;
  }
  return entries;
}

export async function buildAccountZipBytes(
  displayName: string,
  accountFiles: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const entries = buildAccountZipEntries(displayName, accountFiles);
  return new Promise((resolve, reject) => {
    zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export async function buildAccountZipBlob(
  displayName: string,
  accountFiles: Record<string, Uint8Array>,
): Promise<Blob> {
  const zipped = await buildAccountZipBytes(displayName, accountFiles);
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
