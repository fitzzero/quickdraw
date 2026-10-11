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

import { Node, type Project, SyntaxKind } from "ts-morph";
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

/** The first carve-out each name is used in, by kind of use. */
interface CarveOutUses {
  /** Identifiers in the shared package (a 4.x method map's entry and its import). */
  readonly shared: Map<string, string>;
  /** Identifiers a `new` expression holds (`new GameService(...)`). */
  readonly constructions: Map<string, string>;
}

const usesByProject = new WeakMap<Project, CarveOutUses>();

/**
 * The names used inside carve-out regions, read once per project from the
 * files that hold a region marker (the regions as the project stood when the
 * services were planned, before any edit).
 */
function carveOutUses(project: Project, layout: Layout): CarveOutUses {
  const cached = usesByProject.get(project);
  if (cached !== undefined) {
    return cached;
  }
  const uses: CarveOutUses = { shared: new Map(), constructions: new Map() };
  for (const file of project.getSourceFiles()) {
    const text = file.getFullText();
    if (!START.test(text)) {
      continue;
    }
    const regions = regionsOf(text);
    const shared = isUnder(file, layout.shared.src);
    for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const position = identifier.getStart();
      const region = regions.find(
        (candidate) => candidate.start <= position && position <= candidate.end,
      )?.name;
      if (region === undefined) {
        continue;
      }
      const name = identifier.getText();
      if (shared && !uses.shared.has(name)) {
        uses.shared.set(name, region);
      }
      if (Node.isNewExpression(identifier.getParent()) && !uses.constructions.has(name)) {
        uses.constructions.set(name, region);
      }
    }
  }
  usesByProject.set(project, uses);
  return uses;
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
  const uses = carveOutUses(project, layout);
  return (
    (service.methodMapName === undefined ? undefined : uses.shared.get(service.methodMapName)) ??
    uses.constructions.get(service.className)
  );
}
