import type { FileEntry } from "@/types";

/** A path currently being deleted. Directories use recursive=true (includesSubdirectories). */
export interface DeletingTarget {
  path: string;
  recursive: boolean;
}

function targetKey(target: DeletingTarget): string {
  return `${target.recursive ? "R" : "F"}:${target.path}`;
}

export function mergeDeletingTargets(
  prev: DeletingTarget[],
  additions: DeletingTarget[],
): DeletingTarget[] {
  const seen = new Set(prev.map(targetKey));
  const next = [...prev];
  let mutated = false;
  for (const target of additions) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(target);
    mutated = true;
  }
  return mutated ? next : prev;
}

export function removeDeletingTargets(
  prev: DeletingTarget[],
  removals: DeletingTarget[],
): DeletingTarget[] {
  const drop = new Set(removals.map(targetKey));
  const next = prev.filter((target) => !drop.has(targetKey(target)));
  return next.length === prev.length ? prev : next;
}

/** True when this row should show the deleting icon/label (files and nested folders). */
export function isEntryDeleting(entry: FileEntry, targets: DeletingTarget[] | undefined): boolean {
  if (!targets || targets.length === 0) return false;
  for (const target of targets) {
    if (target.recursive) {
      if (entry.path.startsWith(`${target.path}/`)) return true;
    } else if (entry.path === target.path) {
      return true;
    }
  }
  return false;
}

/** The folder row selected for recursive delete — stays navigable, no deleting chrome. */
export function isRecursiveDeleteRoot(entry: FileEntry, targets: DeletingTarget[] | undefined): boolean {
  if (!entry.is_dir || !targets) return false;
  return targets.some((target) => target.recursive && target.path === entry.path);
}

/** Hide rows being deleted (folder + descendants) from Miller columns while delete runs. */
export function shouldHideEntryWhileDeleting(
  entry: FileEntry,
  targets: DeletingTarget[] | undefined,
): boolean {
  if (!targets || targets.length === 0) return false;
  if (isRecursiveDeleteRoot(entry, targets)) return true;
  return isEntryDeleting(entry, targets);
}
