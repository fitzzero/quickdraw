// The access mapping: a 4.x `defineMethod` level, plus whether the method
// names a row, becomes the 5.0 form that admits exactly the callers 4.x
// admitted (`legacy-src/server/BaseService.ts:568-603`):
//
// - `"Public"` admitted everyone: `"public"`.
// - With a row id (`resolveEntryId`, or a payload with `id`, which 4.x read
//   implicitly: `legacy-src/server/ServiceRegistry.ts:313-325`), a service
//   grant at the level passed, and otherwise the row check did:
//   `{ service: L, entry: L, id }`. Never `{ entry: L }`: that would drop the
//   service grant 4.x honored.
// - `"Read"` without a row id admitted every signed-in user:
//   `"authenticated"`, marked, since that was rarely meant.
// - `"Moderate"` or `"Admin"` without a row id needed the service grant:
//   `{ service: L }`.

import type { Node } from "ts-morph";
import type { Category } from "./markers";
import type { Level } from "./model";
import { quote } from "./text";

/** Which row the method names, as 4.x found it. */
export type EntryId =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "function"; readonly text: string }
  | { readonly kind: "optional"; readonly key: string }
  | undefined;

/** A marker to write above the form. */
export interface Note {
  readonly category: Category;
  readonly message: string;
}

/** A method's 5.0 access form. */
export interface AccessForm {
  /** The form as code: `"public"`, `{ service: "Read", entry: "Read", id: "id" }`. */
  readonly code: string;
  /** `"public"` lets anonymous callers in, so the handler's principal may be null. */
  readonly isPublic: boolean;
  /** Whether it is an `entry` form, which needs an access policy on the service. */
  readonly entry: boolean;
  readonly notes: readonly Note[];
}

const READ_OPEN =
  '"Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant';

function form(code: string, notes: Note[] = [], entry = false): AccessForm {
  return { code, isPublic: code === quote("public"), entry, notes };
}

function entryForm(level: Level, id: string, notes: Note[] = []): AccessForm {
  return form(`{ service: ${quote(level)}, entry: ${quote(level)}, id: ${id} }`, notes, true);
}

function withRow(level: Level, entryId: NonNullable<EntryId>, inputType: string): AccessForm {
  // The parameter is annotated: an unannotated `id` function leaves
  // defineService unable to infer the other methods' access forms.
  switch (entryId.kind) {
    case "key":
      return entryForm(level, quote(entryId.key));
    case "function":
      return entryForm(level, `(input: ${inputType}) => (${entryId.text})(input) ?? ""`, [
        {
          category: "access",
          message:
            '4.x\'s resolveEntryId was a function, kept here: where it returns nothing, the "" makes the row check fail, so only the service grant passes (4.x then applied the plain level)',
        },
      ]);
    case "optional":
      return entryForm(level, `(input: ${inputType}) => input.${entryId.key} ?? ""`, [
        {
          category: "access",
          message: `the input's ${entryId.key} is optional: 4.x checked the row when one was sent and the plain level otherwise; this form asks for the service grant when it is missing`,
        },
      ]);
  }
}

/**
 * The 5.0 form for a method of `level`, naming `entryId`. `rows` is false
 * for a service without a model, which cannot use an `entry` form;
 * `inputType` is the method's parsed input type, for an `id` function.
 */
export function accessFor(
  level: Level | undefined,
  levelText: string,
  entryId: EntryId,
  rows: boolean,
  inputType = "unknown",
): AccessForm {
  if (level === undefined) {
    return form(`{ service: "Admin" }`, [
      {
        category: "access",
        message: `the 4.x level \`${levelText}\` is not a literal: this form asks for a service-wide Admin grant until you set it`,
      },
    ]);
  }
  if (level === "Public") {
    return form(quote("public"));
  }
  if (entryId !== undefined && rows) {
    return withRow(level, entryId, inputType);
  }
  if (entryId !== undefined) {
    return form(`{ service: ${quote(level)} }`, [
      {
        category: "access",
        message:
          "4.x checked a row id here, but the service has no rows (no model): only the service grant could pass, as this form keeps",
      },
    ]);
  }
  if (level === "Read") {
    return form(quote("authenticated"), [{ category: "access", message: READ_OPEN }]);
  }
  return form(`{ service: ${quote(level)} }`);
}

/** The name `resolveEntryId: (p) => p.chatId` reads, when it reads one property of its parameter. */
export function entryKeyOf(resolver: Node): string | undefined {
  const text = resolver.getText().replace(/\s+/gu, " ").trim();
  const arrow = /^\(?\s*(\w+)(?:\s*:[^)]*)?\)?\s*=>\s*\1\.(\w+)$/u.exec(text);
  if (arrow !== null) {
    return arrow[2];
  }
  const destructured = /^\(\s*\{\s*(\w+)\s*\}(?:\s*:[^)]*)?\)\s*=>\s*\1$/u.exec(text);
  if (destructured !== null) {
    return destructured[1];
  }
  const fn = /^function\s*\w*\s*\(\s*(\w+)[^)]*\)\s*\{\s*return\s+\1\.(\w+);?\s*\}$/u.exec(text);
  return fn?.[2];
}
