// `installJsdomShims` (`./testing/client`): what jsdom lacks for component
// tests against a real server, added only where it is missing.

import { afterEach, describe, expect, it } from "vitest";
import { installJsdomShims } from "./client";

const added = ["scrollTo", "scrollBy", "scrollIntoView"] as const;

afterEach(() => {
  for (const name of added) {
    Reflect.deleteProperty(Element.prototype, name);
  }
  Reflect.deleteProperty(Blob.prototype, "arrayBuffer");
});

describe("installJsdomShims", () => {
  it("lets elements scroll, doing nothing, and reads a blob's bytes", async () => {
    installJsdomShims();
    const element = document.createElement("div");
    expect(() => {
      element.scrollTo(0, 10);
      element.scrollBy(0, 10);
      element.scrollIntoView();
    }).not.toThrow();
    const bytes = await new Blob(["dump"], { type: "application/x-gzip" }).arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe("dump");
  });

  it("keeps what jsdom already has", () => {
    const own = (): void => undefined;
    Object.defineProperty(Element.prototype, "scrollTo", {
      value: own,
      configurable: true,
      writable: true,
    });
    installJsdomShims();
    expect(Element.prototype.scrollTo).toBe(own);
  });
});
