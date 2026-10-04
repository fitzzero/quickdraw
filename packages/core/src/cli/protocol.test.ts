// `quickdraw-protocol` (src/cli/protocol.ts): `docs/protocol-v5.md` is what
// the protocol's sources generate, the same on every run; `--check` passes
// on the committed file and fails once `envelope.ts` changes; the document
// names every event, error code and frame type the sources declare; and the
// prose names only types that exist.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENT_EVENTS, SERVER_EVENTS } from "../contract/names";
import { ERROR_CODES, httpStatus } from "../protocol/errors";
import { PROTOCOL_VERSION } from "../protocol/version";
import { defaultPaths, generateProtocol, main, type ProtocolOutput } from "./protocol";
import { protocolModel } from "./protocolModel";
import { PROTOCOL_MARKER } from "./protocolRender";
import { PROTOCOL_SOURCES, readSources } from "./protocolSource";
import * as prose from "./protocolText";

const paths = defaultPaths();
const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the protocol sources in a package directory of its own, and a copy of the document. */
function copyOfSources(): { readonly packageDir: string; readonly out: string } {
  const packageDir = mkdtempSync(join(tmpdir(), "quickdraw-protocol-"));
  temporary.push(packageDir);
  for (const path of Object.values(PROTOCOL_SOURCES)) {
    mkdirSync(dirname(join(packageDir, path)), { recursive: true });
    cpSync(join(paths.packageDir, path), join(packageDir, path));
  }
  const out = join(packageDir, "protocol-v5.md");
  cpSync(paths.out, out);
  return { packageDir, out };
}

function run(args: string[], at = paths): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: ProtocolOutput = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  return { code: main(args, io, at), out, err };
}

describe("quickdraw-protocol", () => {
  it("finds docs/protocol-v5.md as the sources generate it (run bun run protocol:sync)", () => {
    expect(run(["--check"])).toMatchObject({ code: 0, err: "" });
    expect(readFileSync(paths.out, "utf8")).toBe(generateProtocol(paths.packageDir));
  });

  it("writes the same document on every run", () => {
    expect(generateProtocol(paths.packageDir)).toBe(generateProtocol(paths.packageDir));
  });

  it("fails --check after a change to envelope.ts, writing nothing, and writes it without", () => {
    const copy = copyOfSources();
    const envelope = join(copy.packageDir, PROTOCOL_SOURCES.envelope);
    const before = readFileSync(copy.out, "utf8");
    writeFileSync(
      envelope,
      readFileSync(envelope, "utf8").replace(
        "export interface CancelFrame {\n  readonly id: CallId;",
        "export interface CancelFrame {\n  readonly id: CallId;\n  /** Why the caller gave up. */\n  readonly reason?: string;",
      ),
    );
    const check = run(["--check"], copy);
    expect(check.code).toBe(1);
    expect(check.err).toContain("differs from the protocol sources: run bun run protocol:sync");
    expect(readFileSync(copy.out, "utf8")).toBe(before);

    expect(run([], copy)).toMatchObject({ code: 0, err: "" });
    const after = readFileSync(copy.out, "utf8");
    expect(after).toMatch(/\| `reason\?` +\| `string` +\| Why the caller gave up\. +\|/);
    expect(run(["--check"], copy).code).toBe(0);
  });

  it("names every event, error code and the protocol the sources declare", () => {
    const text = generateProtocol(paths.packageDir);
    for (const name of [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)]) {
      expect(text).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, "m"));
    }
    for (const code of ERROR_CODES) {
      expect(text).toMatch(
        new RegExp(`^\\| \`${code}\` +\\| ${String(httpStatus(code))} +\\|`, "m"),
      );
    }
    expect(text).toContain(`A 5.0 server speaks protocol \`${String(PROTOCOL_VERSION)}\``);
    expect(text.startsWith(`${PROTOCOL_MARKER}\n\n# quickdraw protocol v5\n`)).toBe(true);
  });

  it("documents every frame type an event reaches, with its fields", () => {
    const text = generateProtocol(paths.packageDir);
    for (const heading of ["CallEnvelope", "CollectionDelta", "PresenceFrame", "WireIndexRow"]) {
      expect(text).toContain(`#### \`${heading}\``);
    }
    expect(text).toMatch(/\| `v\?` +\| `Version` +\| The version of this call's result/);
    expect(text).toMatch(/\| `\{ t: "patched"; id: string; d: Partial<Item> \}` +\|/);
    expect(text).toMatch(/\| 2 and after +\| `fields` +\| `unknown\[\]` +\|/);
    // The event maps and the listener interfaces are the events' tables, not types.
    expect(text).not.toContain("ClientToServerEvents");
    expect(text).not.toContain("ClientListeners");
  });

  it("names in its prose only the types the sources declare", () => {
    const types = protocolModel(readSources(paths.packageDir)).types;
    const { TYPE_PARAMETERS: _parameters, ...texts } = prose;
    const strings = Object.values(texts).flatMap((value: unknown) =>
      typeof value === "string" ? [value] : [],
    );
    const named = strings.flatMap((text) =>
      [...text.matchAll(/`([A-Z][a-z][A-Za-z]*)`/g)].map(([, name]) => name),
    );
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((name) => name !== undefined && !types.has(name))).toEqual([]);
  });

  it("never replaces a file it did not write, and answers usage errors", () => {
    const copy = copyOfSources();
    writeFileSync(copy.out, "# Our protocol\n");
    const refused = run([], copy);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("was not written by quickdraw-protocol");
    expect(readFileSync(copy.out, "utf8")).toBe("# Our protocol\n");
    expect(run(["--out", "x"]).code).toBe(2);
    expect(run(["--help"]).out).toMatch(/^Usage: quickdraw-protocol/);
  });
});
