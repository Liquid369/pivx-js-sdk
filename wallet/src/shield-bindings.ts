/**
 * Loads the pivx-shield-rust WASM module once per process.
 *
 * The published package is a web-target wasm-bindgen build; in Node we
 * initialize it with the wasm bytes from disk (no Web Worker, unlike the
 * browser-only `pivx-shield` wrapper). In browsers/bundlers the default
 * URL-based init is used.
 */
import * as shield from 'pivx-shield-rust';

export type Shield = typeof shield;

let ready: Promise<Shield> | undefined;

export function loadShield(): Promise<Shield> {
  ready ??= (async () => {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const wasmUrl = import.meta.resolve('pivx-shield-rust/pivx_shield_rust_bg.wasm');
      await shield.default({ module_or_path: await readFile(fileURLToPath(wasmUrl)) });
    } else {
      await shield.default();
    }
    return shield;
  })();
  return ready;
}
