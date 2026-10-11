// The console logger's levels (the 5.1 audit's CLIENT-5): in production the
// default writes from `info` up, since a call's record logs at debug with its
// caller's user id; `createConsoleLogger({ level })` names the lowest level
// written; outside production every level is written.

import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger, createConsoleLogger, type LogLevel } from "./logger";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Spies on the console, and says which levels wrote. */
function consoleSpies() {
  const spies = {
    debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
    info: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
  return (): LogLevel[] =>
    (Object.keys(spies) as LogLevel[]).filter((level) => spies[level].mock.calls.length > 0);
}

function writeEveryLevel(logger: typeof consoleLogger): void {
  logger.debug("a debug line", { userId: "u1" });
  logger.info("an info line");
  logger.warn("a warning");
  logger.error("an error");
}

describe("the console logger", () => {
  it("drops debug in production by default, and writes every other level", () => {
    vi.stubEnv("NODE_ENV", "production");
    const written = consoleSpies();
    writeEveryLevel(consoleLogger);
    expect(written()).toEqual(["info", "warn", "error"]);
  });

  it("writes every level outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const written = consoleSpies();
    writeEveryLevel(consoleLogger);
    expect(written()).toEqual(["debug", "info", "warn", "error"]);
  });

  it("writes from the level it is given, whatever NODE_ENV says", () => {
    vi.stubEnv("NODE_ENV", "production");
    const debugWritten = consoleSpies();
    writeEveryLevel(createConsoleLogger({ level: "debug" }));
    expect(debugWritten()).toEqual(["debug", "info", "warn", "error"]);
    vi.restoreAllMocks();
    const warnWritten = consoleSpies();
    const logger = createConsoleLogger({ level: "warn" });
    writeEveryLevel(logger.child({ service: "x" }));
    expect(warnWritten()).toEqual(["warn", "error"]);
  });

  it("refuses a level it does not know", () => {
    expect(() => createConsoleLogger({ level: "trace" as never })).toThrow(TypeError);
  });
});
