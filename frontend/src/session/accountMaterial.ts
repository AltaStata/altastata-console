import type { LoginV2UploadMaterial } from "@/api/accountFolder";

/** In-memory account material for the current browser tab (never persisted). */
let sessionMaterial: LoginV2UploadMaterial | null = null;

export function getSessionAccountMaterial(): LoginV2UploadMaterial | null {
  return sessionMaterial;
}

export function setSessionAccountMaterial(material: LoginV2UploadMaterial | null): void {
  sessionMaterial = material;
}

export function clearSessionAccountMaterial(): void {
  sessionMaterial = null;
}

export function hasSessionAccountMaterial(): boolean {
  return sessionMaterial != null;
}
