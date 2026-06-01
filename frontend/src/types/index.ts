/**
 * Mirrors backend Pydantic models in altastata_console.models.
 * Keep in sync with backend/src/altastata_console/models.py.
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
