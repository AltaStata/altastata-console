/**
 * Public AltaStata gRPC-Web client API.
 *
 * Import from {@code @/api/altastata}; this barrel re-exports the split modules.
 */

export { runWithConcurrency } from "./paths";
export {
  InvalidPasswordError,
  isUserNotInitializedError,
  loadAccountFolderFromPicker,
  hasSessionAccountMaterial,
  getSessionAccountMaterial,
  applyRuntimeSettings,
  bootstrapCurrentSettings,
  loginWithCurrentSettings,
  logout,
  getAccount,
} from "./auth";
export {
  listDir,
  listVersions,
  fetchPreviewBlob,
  type TextPreviewChunk,
  fetchTextPreviewChunk,
  type FilePreviewMetadata,
  fetchFilePreviewMetadata,
  uploadFile,
  uploadBrowserFile,
  deletePath,
  sharePaths,
  revokePaths,
  listKnownUsers,
  downloadFile,
  type StreamDirectoryZipOptions,
  streamDirectoryZip,
  streamFileDownload,
  suggestedZipFileName,
  resolveUploadTargetPath,
  makeUniqueArchiveName,
  suggestMultiZipName,
} from "./files";
export {
  type AltaStataEvent,
  subscribeToAltaStataEvents,
} from "./events";
export {
  ALL_ACCOUNT_KEY_TYPES,
  type AccountKeyType,
  type GenerateKeysResult,
  getSupportedAccountTypes,
  generateAccountKeys,
  accountTypeRequiresPassword,
} from "./accounts";
