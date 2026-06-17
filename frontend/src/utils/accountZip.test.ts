import { describe, expect, it } from "vitest";
import {
  accountZipArchiveName,
  buildAccountZipEntries,
} from "./accountZip";

describe("accountZip", () => {
  it("names zip from display folder", () => {
    expect(accountZipArchiveName("amazon.rsa.bob123")).toBe("amazon.rsa.bob123.altastata.zip");
  });

  it("prefixes each file with display folder", () => {
    const entries = buildAccountZipEntries("amazon.rsa.bob123", {
      "private.key": new Uint8Array([1, 2]),
      "public.key": new Uint8Array([3]),
    });
    expect(Object.keys(entries).sort()).toEqual([
      "amazon.rsa.bob123/private.key",
      "amazon.rsa.bob123/public.key",
    ]);
  });
});
