// What jsdom leaves out that component tests against a real server need
// (finding F3.11): an app's first run of `renderWithQuickdraw` under jsdom
// failed on both until it patched them itself.
//
// - Scrolling: jsdom lays nothing out, and has no `Element.prototype.scrollTo`,
//   `scrollBy` or `scrollIntoView`, which a list that follows its newest
//   item calls. Here they do nothing.
// - `Blob.prototype.arrayBuffer`: jsdom's `Blob` has none, and PGlite reads a
//   database dump through it, so a test that boots the API's test database
//   in the same process fails. Here it reads the blob with jsdom's
//   `FileReader`. (`openPgliteFromTemplate` from `./testing/prisma` uses
//   Node's own `Blob` and needs no patch.)
//
// Only what is missing is added, so a later jsdom that has them keeps its
// own. No Node built-in: `./testing/client` is imported by browser bundles'
// test runners too.

type Scrolling = "scrollTo" | "scrollBy" | "scrollIntoView";

const SCROLLING: readonly Scrolling[] = ["scrollTo", "scrollBy", "scrollIntoView"];

/** The blob's bytes, read with the `FileReader` jsdom has. */
function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(reader.result as ArrayBuffer);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The blob could not be read"));
    });
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Adds what jsdom lacks for component tests against a real server: no-op
 * `scrollTo`, `scrollBy` and `scrollIntoView` on elements, and
 * `Blob.prototype.arrayBuffer`. Call it from a `setupFiles` module of the
 * jsdom project; each one already there is kept. Does nothing without a DOM.
 *
 * @example
 * // vitest.setup.ts, listed in the jsdom project's setupFiles
 * import { installJsdomShims } from "@fitzzero/quickdraw-core/testing/client";
 * installJsdomShims();
 */
export function installJsdomShims(): void {
  const element: unknown = (globalThis as { readonly Element?: unknown }).Element;
  if (typeof element === "function") {
    const prototype = (element as { readonly prototype: Partial<Record<Scrolling, unknown>> })
      .prototype;
    for (const name of SCROLLING) {
      if (typeof prototype[name] !== "function") {
        Object.defineProperty(prototype, name, {
          value: (): void => undefined,
          configurable: true,
          writable: true,
        });
      }
    }
  }
  const blob: unknown = (globalThis as { readonly Blob?: unknown }).Blob;
  const fileReader: unknown = (globalThis as { readonly FileReader?: unknown }).FileReader;
  if (typeof blob === "function" && typeof fileReader === "function") {
    const prototype = (blob as { readonly prototype: { arrayBuffer?: unknown } }).prototype;
    if (typeof prototype.arrayBuffer !== "function") {
      Object.defineProperty(prototype, "arrayBuffer", {
        value(this: Blob): Promise<ArrayBuffer> {
          return readAsArrayBuffer(this);
        },
        configurable: true,
        writable: true,
      });
    }
  }
}
