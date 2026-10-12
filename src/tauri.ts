/* Доступ к возможностям Tauri; в обычном браузере (разработка) их нет. */

export type UpdateInfo = {
  version: string;
  body?: string;
  downloadAndInstall: (cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};

export type TauriGlobal = {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  window: { getCurrentWindow: () => { setTheme: (t: "dark" | "light" | null) => Promise<void> } };
  app: { getVersion: () => Promise<string> };
  updater: { check: () => Promise<UpdateInfo | null> };
  process: { relaunch: () => Promise<void> };
};

export const tauri = (): TauriGlobal | undefined => (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
