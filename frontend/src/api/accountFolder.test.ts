import { describe, expect, it } from "vitest";
import { parseAccountFolder } from "./accountFolder";

function makeFile(
  name: string,
  relativePath: string,
  content: string | ArrayBuffer,
): File {
  const blob = typeof content === "string"
    ? new Blob([content], { type: "application/octet-stream" })
    : new Blob([content], { type: "application/octet-stream" });
  const file = new File([blob], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function asFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* iterate() {
      for (const file of files) yield file;
    },
  };
  for (let i = 0; i < files.length; i += 1) {
    Object.defineProperty(list, String(i), { value: files[i] });
  }
  return list as FileList;
}

describe("parseAccountFolder", () => {
  it("parses RSA account folder with user properties and private key", async () => {
    const props = [
      "acccontainer-prefix=altastata-test-",
      "myuser=bob123",
      "accounttype=amazon-s3-secure",
      "metadata-encryption=RSA",
    ].join("\n");
    const files = asFileList([
      makeFile(
        "altastata-test-bob123.user.properties",
        "amazon.rsa.bob123/altastata-test-bob123.user.properties",
        props,
      ),
      makeFile("private.key", "amazon.rsa.bob123/private.key", "encrypted-pem"),
      makeFile("public.key", "amazon.rsa.bob123/public.key", "public-pem"),
    ]);

    const material = await parseAccountFolder(files);

    expect(material.displayName).toBe("amazon.rsa.bob123");
    expect(material.myUser).toBe("bob123");
    expect(material.userProperties).toBe(props);
    expect(material.accountFiles["private.key"]).toBeTruthy();
    expect(material.accountFiles["public.key"]).toBeUndefined();
  });

  it("parses PQC private keys", async () => {
    const props = "myuser=alice\naccounttype=amazon-s3-secure\nmetadata-encryption=PQC\n";
    const files = asFileList([
      makeFile("alice.user.properties", "amazon.pqc.alice/alice.user.properties", props),
      makeFile("kyber_private.key", "amazon.pqc.alice/kyber_private.key", "kyber"),
      makeFile("dilithium_private.key", "amazon.pqc.alice/dilithium_private.key", "dil"),
    ]);

    const material = await parseAccountFolder(files);

    expect(material.myUser).toBe("alice");
    expect(Object.keys(material.accountFiles).sort()).toEqual([
      "dilithium_private.key",
      "kyber_private.key",
    ]);
  });

  it("rejects folder without user properties", async () => {
    const files = asFileList([
      makeFile("private.key", "amazon.rsa.bob/private.key", "pem"),
    ]);
    await expect(parseAccountFolder(files)).rejects.toThrow(/user\.properties/);
  });
});
