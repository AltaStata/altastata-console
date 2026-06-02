import { describe, expect, it } from "vitest";
import {
  isUserNotInitializedError,
  resolveUploadTargetPath,
  runWithConcurrency,
} from "./altastata";
import type { FileEntry } from "@/types";

function dirEntry(path: string): FileEntry {
  return {
    name: path.split("/").filter(Boolean).pop() ?? path,
    path,
    is_dir: true,
    size: null,
    created: null,
    version: null,
    mime_type: null,
    readers: [],
    encrypted: false,
  };
}

function fileEntry(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    is_dir: false,
    size: null,
    created: null,
    version: null,
    mime_type: null,
    readers: [],
    encrypted: false,
  };
}

describe("isUserNotInitializedError", () => {
  it("matches FAILED_PRECONDITION (gRPC status 9)", () => {
    expect(
      isUserNotInitializedError(
        new Error("gRPC status=9 message=User is not initialized"),
      ),
    ).toBe(true);
  });

  it("matches the literal 'User is not initialized' message", () => {
    expect(isUserNotInitializedError("User is not initialized")).toBe(true);
  });

  it("matches the alternate 'has not been initialized' wording", () => {
    expect(
      isUserNotInitializedError(
        new Error("gRPC status=9 message=User has not been initialized"),
      ),
    ).toBe(true);
  });

  it("matches the password-bootstrap signatures (status=13)", () => {
    expect(
      isUserNotInitializedError(
        new Error(
          "gRPC status=13 message=Read stream failed: Password is null, but a password is required",
        ),
      ),
    ).toBe(true);
    expect(
      isUserNotInitializedError("call setPassword first"),
    ).toBe(true);
    expect(
      isUserNotInitializedError("set password for user failed"),
    ).toBe(true);
    expect(
      isUserNotInitializedError("account_password cannot be empty"),
    ).toBe(true);
  });

  it("matches UNAUTHENTICATED (gRPC status 16 / Invalid token)", () => {
    expect(
      isUserNotInitializedError(new Error("gRPC status=16 message=Invalid token")),
    ).toBe(true);
    expect(
      isUserNotInitializedError("invalid token"),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(
      isUserNotInitializedError(new Error("Network error: failed to fetch")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=14 message=Unavailable")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=5 message=Not found")),
    ).toBe(false);
    expect(isUserNotInitializedError(undefined)).toBe(false);
    expect(isUserNotInitializedError(null)).toBe(false);
  });

  it("does not confuse status=9/16 prefix-collisions like status=99 or status=160", () => {
    expect(
      isUserNotInitializedError(new Error("gRPC status=99 message=Synthetic")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=19 message=Synthetic")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=160 message=Synthetic")),
    ).toBe(false);
  });
});

describe("resolveUploadTargetPath", () => {
  it("places a flat file inside a selected folder", () => {
    expect(
      resolveUploadTargetPath("file.txt", dirEntry("/photos"), "/"),
    ).toBe("/photos/file.txt");
  });

  it("preserves nested webkitRelativePath inside a selected folder", () => {
    expect(
      resolveUploadTargetPath("trip/2025/img.jpg", dirEntry("/photos"), "/"),
    ).toBe("/photos/trip/2025/img.jpg");
  });

  it("places nested files at the active path when nothing is selected", () => {
    expect(
      resolveUploadTargetPath("trip/2025/img.jpg", null, "/photos"),
    ).toBe("/photos/trip/2025/img.jpg");
  });

  it("places files alongside the selected file (uses parent dir)", () => {
    expect(
      resolveUploadTargetPath("notes.txt", fileEntry("/photos/trip/img.jpg"), "/"),
    ).toBe("/photos/trip/notes.txt");
  });

  it("preserves nested paths alongside the selected file", () => {
    expect(
      resolveUploadTargetPath("nested/dir/x.txt", fileEntry("/photos/trip/img.jpg"), "/"),
    ).toBe("/photos/trip/nested/dir/x.txt");
  });

  it("handles uploads at the root with nested webkitRelativePath", () => {
    expect(
      resolveUploadTargetPath("a/b/c.txt", dirEntry("/"), "/"),
    ).toBe("/a/b/c.txt");
    expect(
      resolveUploadTargetPath("a/b/c.txt", null, "/"),
    ).toBe("/a/b/c.txt");
  });
});

describe("runWithConcurrency", () => {
  it("is a no-op for an empty input", async () => {
    let calls = 0;
    await runWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      seen.push(value);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects the concurrency cap (no more than N in flight at once)", async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    let active = 0;
    let peak = 0;
    await runWithConcurrency(items, 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // confirms parallelism actually happened
  });

  it("limits concurrency to items.length when limit exceeds it", async () => {
    let peak = 0;
    let active = 0;
    await runWithConcurrency([1, 2], 10, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBe(2);
  });

  it("treats a non-positive limit as a single worker", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (value) => {
      seen.push(value);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("propagates the first error and stops spawning new tasks", async () => {
    const startedIndices: number[] = [];
    await expect(
      runWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (_value, idx) => {
        startedIndices.push(idx);
        if (idx === 1) {
          throw new Error("boom");
        }
        // Tiny delay so worker 0 is still in-flight when worker 1 throws,
        // ensuring the abort flag flips before it picks up the next task.
        await new Promise((r) => setTimeout(r, 5));
      }),
    ).rejects.toThrow("boom");
    // Only the two initially-dispatched workers ran; abort prevented 2..7.
    expect(startedIndices.sort((a, b) => a - b)).toEqual([0, 1]);
  });
});
