import type { FileEntry } from "@/types";
import type { DeletingTarget } from "@/utils/deletingTargets";

export interface BottomToolbarProps {
  selectedEntries: FileEntry[];
  activePath: string;
  /**
   * Full paths of folders the user has just created locally and that are
   * not yet backed by any file in the cloud. We need this here only so the
   * New Folder dialog can warn on duplicates BEFORE adding another pending
   * entry; the actual merge into the column listing happens in App.tsx /
   * MillerColumns.
   */
  pendingFolderPaths?: Set<string>;
  /**
   * Owner-supplied callback that registers a new pending folder. Receives
   * the FULL absolute path (e.g. `/foo/new-dir`).
   */
  onAddPendingFolder?: (fullPath: string) => void;
  onRemovePendingFolders?: (fullPaths: string[]) => void;
  onMarkPathsDeleting?: (targets: DeletingTarget[]) => void;
  onUnmarkPathsDeleting?: (targets: DeletingTarget[]) => void;
  onRefresh: () => void;
}

export type SaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Uint8Array | ArrayBuffer) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
};

export type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFileHandle>;
};

export type AccessDialogMode = "share" | "revoke";

export interface AccessDialogState {
  mode: AccessDialogMode;
  targets: FileEntry[];
  loadingUsers: boolean;
  knownUsers: string[];
  selected: string;
  error: string | null;
}

export interface NewFolderDialogState {
  name: string;
  error: string | null;
}
