/// <reference types="vite/client" />

// Build-time constants injected via `vite.config.ts -> define`. They surface
// the package version and ISO build timestamp inside the bundle so the running
// UI can self-report which build is loaded.
declare const __APP_VERSION__: string;
declare const __APP_BUILD_TIME__: string;
