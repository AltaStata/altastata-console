/**
 * Shape of file/version metadata returned by the gRPC layer
 * (`frontend/src/api/altastata.ts`). Mirrors the field names exposed
 * by `altastata.v1.FileOpsService` so the UI can stay close to the
 * Java side without an extra translation layer.
 */

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  created: string | null;
  version: string | null;
  readers: string[];
  encrypted: boolean;
  mime_type: string | null;
}

export interface ListResponse {
  path: string;
  entries: FileEntry[];
}

export interface VersionEntry {
  version: string;
  created: string;
  size: number;
  author: string | null;
}

export interface AccountInfo {
  account_id: string;
  display_name: string;
}
