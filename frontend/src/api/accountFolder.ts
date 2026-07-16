/**
 * Parse an account directory picked via {@code <input webkitdirectory>}.
 * Account-folder LoginV2 flow (folder picker + password).
 *
 * Everything except {@code *user.properties} goes into {@code account_files}
 * (private keys, {@code license.jwt}, {@code org-ca.pem}, public keys, …).
 * Gateway materializes the map as a temp account dir — same kit as on disk.
 */
export interface LoginV2UploadMaterial {
  /** Top-level folder name from the picker (display only). */
  displayName: string;
  /** {@code myuser} from {@code *user.properties}. */
  myUser: string;
  userProperties: string;
  accountFiles: Record<string, Uint8Array>;
}

/** Used only to decide whether a local private-key file is required for login. */
const PRIVATE_KEY_BASENAMES = new Set([
  "private.key",
  "kyber_private.key",
  "dilithium_private.key",
  "hpcs-privkey.blob",
]);

const SKIP_BASENAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
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

function shouldSkipBasename(name: string): boolean {
  if (!name || name === "." || name === "..") return true;
  if (name.startsWith(".")) return true;
  return SKIP_BASENAMES.has(name.toLowerCase());
}

function readUserProperty(userProperties: string, name: string): string {
  for (const raw of userProperties.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === name) return value;
  }
  return "";
}

function extractMyUser(userProperties: string): string {
  return readUserProperty(userProperties, "myuser");
}

/** HSM accounts use a cloud KMS/HSM — no local private key file in the folder. */
export function accountFolderRequiresPrivateKeyFiles(userProperties: string): boolean {
  return readUserProperty(userProperties, "metadata-encryption") !== "HSM";
}

/**
 * HPCS and HSM sign-in does not decrypt a local PEM with a user password
 * (GREP11 / HSM PIN is configured on the gateway or in properties).
 */
export function accountLoginRequiresPassword(userProperties: string): boolean {
  if (readUserProperty(userProperties, "metadata-encryption") === "HSM") {
    return false;
  }
  if (readUserProperty(userProperties, "key-protection") === "HPCS") {
    return false;
  }
  return true;
}

export async function parseAccountFolder(files: FileList | readonly File[]): Promise<LoginV2UploadMaterial> {
  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    throw new Error("No files selected from account folder.");
  }

  let userPropertiesFile: File | null = null;
  const otherFiles: File[] = [];
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
    } else if (!shouldSkipBasename(basename)) {
      otherFiles.push(file);
    }
  }

  if (!userPropertiesFile) {
    throw new Error("Account folder must contain a *user.properties file.");
  }

  const userProperties = await userPropertiesFile.text();
  const myUser = extractMyUser(userProperties);
  if (!myUser) {
    throw new Error("user.properties is missing myuser=.");
  }

  const accountFiles: Record<string, Uint8Array> = {};
  for (const file of otherFiles) {
    const relativePath = file.webkitRelativePath || file.name;
    const basename = pathBasename(relativePath);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error(`Account file is empty: ${basename}`);
    }
    accountFiles[basename] = bytes;
  }

  const needsPrivateKeys = accountFolderRequiresPrivateKeyFiles(userProperties);
  const hasPrivateKey = Object.keys(accountFiles).some((name) => PRIVATE_KEY_BASENAMES.has(name));
  if (needsPrivateKeys && !hasPrivateKey) {
    throw new Error(
      "Account folder must contain a private key file (private.key, kyber_private.key + dilithium_private.key, or hpcs-privkey.blob).",
    );
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
