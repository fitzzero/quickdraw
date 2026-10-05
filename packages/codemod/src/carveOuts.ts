// Carve-out regions. An app made from the quickdraw template marks code a
// fork may strip as a whole between two comment lines (in any comment
// syntax):
//
//   // ── quickdraw-game:start ──
//   import type { GameServiceMethods } from "./game.js";
//   // ── quickdraw-game:end ──
//
// A script strips each region's lines and deletes the carve-out's own files.
// The code the codemod writes for a carved-out service (its contract, its
// entries in `contracts/index.ts`) keeps the markers, and every new file that
// belongs to a carve-out says so in a `[carve-out]` review marker, which the
// report lists: the script's list of files to delete needs it.

import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import type { Layout } from "./layout";
import type { ServiceModel } from "./model";
import { isUnder } from "./project";

const START = /──\s*([\w.@/-]+):start\s*──/u;
const END = /──\s*([\w.@/-]+):end\s*──/u;

/** One carve-out region of a file: its name and the offsets it spans. */
interface Region {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** The marker lines of carve-out `name`, as `//` comments. */
export function regionMarkers(name: string): { start: string; end: string } {
  return { start: `// ── ${name}:start ──`, end: `// ── ${name}:end ──` };
}

/** The carve-out regions of `text`. A region left open runs to the end. */
export function regionsOf(text: string): Region[] {
  const regions: Region[] = [];
  const open = new Map<string, number>();
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = START.exec(line)?.[1];
    const end = END.exec(line)?.[1];
    if (start !== undefined) {
      open.set(start, offset);
    } else if (end !== undefined && open.has(end)) {
      regions.push({ name: end, start: open.get(end) ?? 0, end: offset + line.length });
      open.delete(end);
    }
    offset += line.length + 1;
  }
  for (const [name, start] of open) {
    regions.push({ name, start, end: text.length });
  }
  return regions;
}

/** The carve-out holding `node`, if any. */
export function regionOf(node: Node): string | undefined {
  const position = node.getStart();
  return regionsOf(node.getSourceFile().getFullText()).find(
    (region) => region.start <= position && position <= region.end,
  )?.name;
}

/** The carve-out the first of `nodes` inside one belongs to. */
function firstRegion(nodes: readonly Node[]): string | undefined {
  for (const node of nodes) {
    const name = regionOf(node);
    if (name !== undefined) {
      return name;
    }
  }
  return undefined;
}

/**
 * The carve-out a 4.x service belongs to: the region holding its method map
 * in the shared package (the 4.x `ServiceMethodsMap` entry and its import),
 * else the region constructing its class (`new GameService(...)`).
 */
export function carveOutOf(
  project: Project,
  layout: Layout,
  service: ServiceModel,
): string | undefined {
  const files = project.getSourceFiles();
  const named = (file: SourceFile, name: string | undefined): Node[] =>
    name === undefined
      ? []
      : file
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter((identifier) => identifier.getText() === name);
  const mapUses = files
    .filter((file) => isUnder(file, layout.shared.src))
    .flatMap((file) => named(file, service.methodMapName));
  const constructions = files.flatMap((file) =>
    named(file, service.className).filter((identifier) =>
      Node.isNewExpression(identifier.getParent()),
    ),
  );
  return firstRegion(mapUses) ?? firstRegion(constructions);
}
