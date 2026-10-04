// MIGRATION.md (repository root): one section per row of the design
// record's 4.x-to-5.0 table (docs/rfcs/0003-v5.md, section 15), and an
// appendix that lists exactly what lint's no-v4-api reports, with the same
// replacements (`bun run guide:sync` rewrites it). Its code examples are
// checked by packages/core/test/readme (copies of compiled files).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./helpers";

const guide = readFileSync(join(REPO, "MIGRATION.md"), "utf8");

interface GuideNames {
  namesSection(): string;
  START: string;
  END: string;
}

/** The generator of the appendix (plain .mjs, read at run time). */
async function generator(): Promise<GuideNames> {
  return (await import(join(REPO, "packages/codemod/scripts/guide-names.mjs"))) as GuideNames;
}

/** The rows of every Markdown table in `text`, as trimmed cells (`\|` kept as `|`). */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/u.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/u)
        .map((cell) => cell.trim().replaceAll("\\|", "|")),
    );
}

describe("MIGRATION.md", () => {
  it("has a section for every row of section 15 of the design record", () => {
    const headings = guide.split("\n").filter((line) => line.startsWith("### "));
    const rfcRows = [
      "Service classes become",
      "`BaseRpcService`",
      "Method maps, `SubscriptionDataMap`",
      "`defineMethod`",
      "`verifyAllMethods`",
      "`this.create`, `this.update`, `this.delete` and lifecycle hooks",
      "`emitUpdate`, `emitCollection*` and `notifyCollections`",
      "`toDto`, `getProtectedFields` and `hasElevatedAccess`",
      "`checkAccess`, `checkEntryACL`, `checkBatchSubscriptionAccess` and `hasEntryACL`",
      "`defineCollection`",
      "`kickFromCollection`",
      "`emitToRoom` and `QuickdrawEventMap`",
      "`installAdminMethods`",
      "`ServiceRegistry` and `createQuickdrawServer`",
      "The client hooks",
      "`invalidateOn`",
      "`ServiceResponse`",
      "`./eslint-plugin`, `./eslint-config`",
      "`./client/inputs`",
    ];
    for (const row of rfcRows) {
      expect(
        headings.some((heading) => heading.includes(row)),
        row,
      ).toBe(true);
    }
  });

  it("lists every removed 4.x name with no-v4-api's replacement (bun run guide:sync)", async () => {
    const { namesSection, START, END } = await generator();
    const section = guide.slice(guide.indexOf(START), guide.indexOf(END) + END.length);
    expect(section.length).toBeGreaterThan(START.length);
    expect(rows(section)).toEqual(rows(namesSection()));
    expect(rows(section).length).toBeGreaterThan(190);
  });
});
