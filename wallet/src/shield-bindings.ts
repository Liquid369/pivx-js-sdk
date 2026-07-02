/**
 * Loads the pivx-shield WASM module once per process.
 *
 * Two builds exist. The single-core build (`pivx-shield-rust`) runs anywhere
 * but proves transactions on one thread, which is slow. The multicore build
 * (`pivx-shield-rust-multicore`) proves in parallel across Web Workers and is
 * much faster, but it needs a browser with SharedArrayBuffer available under
 * cross-origin isolation. Multicore is opt-in through {@link ProvingOptions}.
 *
 * For server-side proving throughput, use the native Rust SDK rather than the
 * WASM build — native proving does not have this constraint.
 */
import * as singleCore from 'pivx-shield-rust';

// Both builds expose the same set of exported functions; the multicore one
// adds initThreadPool. Type against the single-core surface either way.
export type Shield = typeof singleCore;

export interface ProvingOptions {
  /**
   * Use the multicore WASM build and spin up a worker thread pool. Requires a
   * browser with SharedArrayBuffer (cross-origin isolated). Ignored with a
   * warning where that is unavailable, falling back to single-core.
   */
  multicore?: boolean;
  /** Worker threads for the multicore pool. Defaults to the hardware core count. */
  threads?: number;
}

let ready: Promise<Shield> | undefined;

async function initSingleCore(): Promise<Shield> {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const wasmUrl = import.meta.resolve('pivx-shield-rust/pivx_shield_rust_bg.wasm');
    await singleCore.default({ module_or_path: await readFile(fileURLToPath(wasmUrl)) });
  } else {
    await singleCore.default();
  }
  return singleCore;
}

function multicoreUsable(): boolean {
  // The rayon thread pool is built on Web Workers + SharedArrayBuffer, so it
  // only runs in a browser that is cross-origin isolated.
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    (typeof process === 'undefined' || !process.versions?.node)
  );
}

async function initMulticore(threads?: number): Promise<Shield> {
  // Loaded dynamically so single-core users need not install the package.
  const mc: any = await import('pivx-shield-rust-multicore' as string);
  await mc.default();
  const n = threads ?? (globalThis.navigator?.hardwareConcurrency ?? 4);
  await mc.initThreadPool(n);
  return mc as Shield;
}

/**
 * Load and memoize the WASM module. The first call decides single- vs
 * multicore for the process; later calls return the same instance.
 */
export function loadShield(opts: ProvingOptions = {}): Promise<Shield> {
  ready ??= (async () => {
    if (opts.multicore) {
      if (multicoreUsable()) {
        try {
          return await initMulticore(opts.threads);
        } catch (err) {
          console.warn(
            `multicore proving unavailable (${(err as Error).message}); using single-core`,
          );
        }
      } else {
        console.warn(
          'multicore proving needs a cross-origin-isolated browser; using single-core. ' +
            'For server-side proving use the native Rust SDK.',
        );
      }
    }
    return initSingleCore();
  })();
  return ready;
}
