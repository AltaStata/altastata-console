/**
 * Parse an account directory picked via {@code <input webkitdirectory>}.
 * See mycloud {@code CONSOLE_ACCOUNT_SETUP_DESIGN.md} §4 / §6.
 */
export interface LoginV2UploadMaterial {
  /** Top-level folder name from the picker (display only). */
  displayName: string;
  /** {@code myuser} from {@code *user.properties}. */
  myUser: string;
  userProperties: string;
  accountFiles: Record<string, Uint8Array>;
}

const PRIVATE_KEY_BASENAMES = new Set([
  "private.key",
  "kyber_private.key",
  "dilithium_private.key",
  "hpcs-privkey.blob",
]);

function pathBasename(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function topLevelFolderName(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : "";
}

function isUserPropertiesBasename(name: string): boolean {
  return name.endsWith(".user.properties");
}

function extractMyUser(userProperties: string): string {
  for (const raw of userProperties.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "myuser") return value;
  }
  return "";
}

export async function parseAccountFolder(files: FileList | readonly File[]): Promise<LoginV2UploadMaterial> {
  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    throw new Error("No files selected from account folder.");
  }

  let userPropertiesFile: File | null = null;
  const privateKeyFiles: File[] = [];
  let displayName = "";

  for (const file of fileArray) {
    const relativePath = file.webkitRelativePath || file.name;
    if (!displayName) {
      const folder = topLevelFolderName(relativePath);
      if (folder) displayName = folder;
    }
    const basename = pathBasename(relativePath);
    if (isUserPropertiesBasename(basename)) {
      if (userPropertiesFile) {
        throw new Error("Account folder must contain exactly one *user.properties file.");
      }
      userPropertiesFile = file;
    } else if (PRIVATE_KEY_BASENAMES.has(basename)) {
      privateKeyFiles.push(file);
    }
  }

  if (!userPropertiesFile) {
    throw new Error("Account folder must contain a *user.properties file.");
  }
  if (privateKeyFiles.length === 0) {
    throw new Error(
      "Account folder must contain a private key file (private.key, kyber_private.key + dilithium_private.key, or hpcs-privkey.blob).",
    );
  }

  const userProperties = await userPropertiesFile.text();
  const myUser = extractMyUser(userProperties);
  if (!myUser) {
    throw new Error("user.properties is missing myuser=.");
  }

  const accountFiles: Record<string, Uint8Array> = {};
  for (const file of privateKeyFiles) {
    const relativePath = file.webkitRelativePath || file.name;
    const basename = pathBasename(relativePath);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`Key file is empty: ${basename}`);
    }
    accountFiles[basename] = bytes;
  }

  if (!displayName) {
    displayName = myUser;
  }

  return {
    displayName,
    myUser,
    userProperties,
    accountFiles,
  };
}
