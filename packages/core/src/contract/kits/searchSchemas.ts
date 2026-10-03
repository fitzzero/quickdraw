// The input and output of the search kit's `search` (RFC 0003 section 12.2).
// A call passes the text to look for, `q`, trimmed here; `scope`, one scope
// of the collection the contract's search names (only when it names one);
// and the cursor and page size of `list` (`crudList.ts`): 20 items by
// default, at most 100 (a larger `limit` is clamped). The cursor is opaque
// here and decoded by the server.
//
// A page is `{ items, nextCursor, rev? }`. Its items are checked to be rows
// with an id, not against the item schema: the server strips the fields the
// reader's level does not reach, which the item's own schema may require.

import type { StandardSchemaV1 } from "../standardSchema";
import { itemsIssues, itemsJson, MAX_CURSOR_LENGTH, pagingIssues } from "./crudList";
import {
  isRecord,
  kitSchema,
  objectJson,
  unknownKeys,
  type JsonSchema,
  type KitSchema,
} from "./schemas";

/** `search`'s page size when the caller gives none. */
export const SEARCH_DEFAULT_LIMIT = 20;

/** The largest page `search` returns: a larger `limit` is clamped to it. */
export const SEARCH_MAX_LIMIT = 100;

/** How long a query must be, once trimmed, unless the contract says otherwise. */
export const SEARCH_DEFAULT_MIN_LENGTH = 2;

/** The longest query `search` accepts, in characters. */
export const SEARCH_MAX_QUERY_LENGTH = 256;

/** The longest scope value `search` accepts, as for subscriptions (RFC 0003 section 8.2). */
const MAX_SCOPE_LENGTH = 256;

/** What a `search` call passes; `Scoped` when the contract's search names a collection. */
export type SearchInput<Scoped extends boolean = false> = {
  /** The text to look for. Trimmed; one shorter than the method's `minLength` finds nothing. */
  readonly q: string;
  /** The `nextCursor` of the page before; the first page when absent. */
  readonly cursor?: string;
  /** The page size: default 20, at most 100 (a larger one is clamped). */
  readonly limit?: number;
} & (Scoped extends true
  ? {
      /** One scope of the search's collection (a project id): only its members are searched. */
      readonly scope?: string;
    }
  : unknown);

/** `search`'s input as its handler receives it: `q` trimmed, defaults applied, the limit clamped. */
export interface SearchQuery {
  readonly q: string;
  readonly scope: string | undefined;
  readonly cursor: string | undefined;
  /** At least 1 and at most {@link SEARCH_MAX_LIMIT}. */
  readonly limit: number;
}

/** One page of `search`. */
export interface SearchPage<Item> {
  readonly items: Item[];
  /** Passed back as `cursor` for the next page; `null` on the last page. */
  readonly nextCursor: string | null;
  /**
   * Set when the search ran in a scope and its items are that scope's
   * collection items exactly as the collection's subscribers receive them:
   * the revision they were read at, so a client can keep them in the
   * collection's cache, where the scope's deltas keep them current.
   */
  readonly rev?: number;
}

type Issues = StandardSchemaV1.Issue[];

function queryIssues(q: unknown): Issues {
  if (typeof q !== "string") {
    return [{ message: "Expected the text to search for", path: ["q"] }];
  }
  return q.length > SEARCH_MAX_QUERY_LENGTH
    ? [{ message: `At most ${SEARCH_MAX_QUERY_LENGTH} characters`, path: ["q"] }]
    : [];
}

function scopeIssues(scope: unknown): Issues {
  const valid =
    scope === undefined ||
    (typeof scope === "string" && scope.length > 0 && scope.length <= MAX_SCOPE_LENGTH);
  return valid ? [] : [{ message: "Expected a scope value", path: ["scope"] }];
}

/** The parsed input of a valid `search` call. */
function queryOf(value: Readonly<Record<string, unknown>>): SearchQuery {
  const limit = (value.limit as number | undefined) ?? SEARCH_DEFAULT_LIMIT;
  return {
    q: (value.q as string).trim(),
    scope: value.scope as string | undefined,
    cursor: value.cursor as string | undefined,
    limit: Math.min(limit, SEARCH_MAX_LIMIT),
  };
}

function searchJson(scoped: boolean): JsonSchema {
  return objectJson(
    {
      q: { type: "string", maxLength: SEARCH_MAX_QUERY_LENGTH },
      ...(scoped ? { scope: { type: "string", minLength: 1, maxLength: MAX_SCOPE_LENGTH } } : {}),
      cursor: { type: "string", minLength: 1, maxLength: MAX_CURSOR_LENGTH },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SEARCH_MAX_LIMIT,
        default: SEARCH_DEFAULT_LIMIT,
      },
    },
    ["q"],
  );
}

/**
 * `search`'s input: `{ q, scope?, cursor?, limit? }`, with `scope` only when
 * the contract's search names a collection (`scoped`).
 */
export function searchInput<Scoped extends boolean>(
  scoped: Scoped,
): KitSchema<SearchInput<Scoped>, SearchQuery> {
  const keys = scoped ? ["q", "scope", "cursor", "limit"] : ["q", "cursor", "limit"];
  return kitSchema<SearchInput<Scoped>, SearchQuery>(
    (input) => {
      if (!isRecord(input)) {
        return { issues: [{ message: "Expected { q, ... }", path: [] }] };
      }
      const issues = [
        ...unknownKeys(input, keys),
        ...queryIssues(input.q),
        ...(scoped ? scopeIssues(input.scope) : []),
        ...pagingIssues({ cursor: input.cursor, limit: input.limit }),
      ];
      return issues.length > 0 ? { issues } : { value: queryOf(input) };
    },
    { input: () => searchJson(scoped) },
  );
}

/** One page of `search`: `{ items, nextCursor, rev? }`. */
export function searchPageOutput<Item>(item: StandardSchemaV1): KitSchema<SearchPage<Item>> {
  return kitSchema<SearchPage<Item>>(
    (value) => {
      if (!isRecord(value)) {
        return { issues: [{ message: "Expected a page", path: [] }] };
      }
      const { nextCursor, rev } = value;
      const issues = [...unknownKeys(value, ["items", "nextCursor", "rev"])];
      issues.push(...itemsIssues(value.items));
      if (nextCursor !== null && typeof nextCursor !== "string") {
        issues.push({ message: "Expected a cursor or null", path: ["nextCursor"] });
      }
      if (rev !== undefined && !(typeof rev === "number" && Number.isFinite(rev))) {
        issues.push({ message: "Expected a revision", path: ["rev"] });
      }
      return issues.length > 0 ? { issues } : { value: value as unknown as SearchPage<Item> };
    },
    {
      input: (target) =>
        objectJson(
          {
            items: itemsJson(item, target),
            nextCursor: { type: ["string", "null"] },
            rev: { type: "number" },
          },
          ["items", "nextCursor"],
        ),
    },
  );
}
