// The 4.x API the transforms leave for a person: imports that still name a
// removed or moved export (the server's ServiceRegistry, room helpers, the
// collection types), the `QuickdrawEventMap` augmentation, and 4.x props of
// `QuickdrawProvider`. Each gets a marker; `@fitzzero/quickdraw-lint`'s
// `no-v4-api` names the replacement of every one.

import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { MarkerSet } from "../markers";
import { MOVED_NAMES, PROVIDER_PROPS, REMOVED_ENTRIES, REMOVED_NAMES } from "../v4names";

const CORE = /^@fitzzero\/quickdraw-core(?:\/.*)?$/u;

function markImports(file: SourceFile, markers: MarkerSet): void {
  const declarations = [...file.getImportDeclarations(), ...file.getExportDeclarations()];
  for (const declaration of declarations) {
    const source = declaration.getModuleSpecifierValue() ?? "";
    if (!CORE.test(source)) {
      continue;
    }
    if (REMOVED_ENTRIES.has(source)) {
      markers.addAbove(
        declaration,
        "v4-api",
        `"${source}" was removed in 5.0; lint's no-v4-api names what replaces it`,
      );
      continue;
    }
    const names = Node.isImportDeclaration(declaration)
      ? declaration.getNamedImports().map((specifier) => specifier.getName())
      : declaration.getNamedExports().map((specifier) => specifier.getName());
    const removed = names.filter((name) => REMOVED_NAMES.has(name));
    const moved = names.filter((name) => MOVED_NAMES[source]?.has(name) === true);
    if (removed.length > 0 || moved.length > 0) {
      const parts = [
        removed.length > 0 ? `${removed.join(", ")} (removed)` : "",
        moved.length > 0 ? `${moved.join(", ")} (moved)` : "",
      ].filter((part) => part !== "");
      markers.addAbove(
        declaration,
        "v4-api",
        `4.x API ${parts.join(" and ")}: lint's no-v4-api names each replacement`,
      );
    }
  }
}

function markEventMap(file: SourceFile, markers: MarkerSet): void {
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.ModuleDeclaration)) {
    const augmentsCore = CORE.test(declaration.getName().replace(/["']/gu, ""));
    if (
      augmentsCore &&
      declaration
        .getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)
        .some((item) => item.getName() === "QuickdrawEventMap")
    ) {
      markers.addAbove(
        declaration,
        "v4-api",
        "QuickdrawEventMap typed 4.x room events: declare each event in its contract (events: { name: { payload } }), send it with ctx.rooms.emit and listen with qd.<service>.<event>.useEvent, then delete this augmentation",
      );
    }
  }
}

function markProviders(file: SourceFile, markers: MarkerSet): void {
  const elements = [
    ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const element of elements) {
    if (element.getTagNameNode().getText() !== "QuickdrawProvider") {
      continue;
    }
    const props = element
      .getAttributes()
      .map((attribute) => (Node.isJsxAttribute(attribute) ? attribute.getNameNode().getText() : ""))
      .filter((name) => PROVIDER_PROPS.has(name));
    if (props.length > 0) {
      markers.add(
        element,
        "client",
        `4.x QuickdrawProvider props (${props.join(", ")}): 5.0 takes client={qd} (lib/quickdraw), url, auth and socketOptions`,
      );
    }
  }
}

/** Marks what is left of the 4.x API in every file. */
export function markLeftovers(ctx: RunContext, work: Work): void {
  for (const file of ctx.project.getSourceFiles()) {
    const markers = new MarkerSet(file);
    markImports(file, markers);
    markEventMap(file, markers);
    markProviders(file, markers);
    if (markers.edits.length > 0) {
      work.for(file).edits.push(...markers.edits);
    }
  }
}
