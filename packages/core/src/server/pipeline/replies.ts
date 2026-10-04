// Each caller's reply after the run (RFC 0003 sections 6 and 9): a projection
// output's rows without the fields the caller's level on each row does not
// reach. It runs on each caller's copy, never inside the run, so a shared
// run's `Admin` result is never handed to a `Read` joiner whole.
//
// Every caller of a shared run reads its own levels, but callers whose levels
// hide the same fields on every row get one copy, stripped once, and its JSON
// text is written once for all of them: a transport that writes JSON sends
// the same text to each. Encoded per caller instead, a board query shared by
// twenty viewers is encoded twenty times back to back, holding the event loop
// for the whole stretch (the 5.0 benchmark, `bench/reports/5.0.0.md`).

import { serviceGrant } from "../access/levels";
import type { RowLevels } from "../access/policy";
import { readerView, wholeView, type ReaderView } from "../emit/projection";
import type { RegisteredMethod } from "../registry";
import type { Principal } from "../types";
import type { SharedData } from "./request";
import type { Run } from "./run";
import type { PipelineSettings } from "./settings";
import { deepFreeze } from "./share";

/** A caller's result, with its group's shared JSON text when it came from a shared run. */
export interface CallerReply {
  readonly data: unknown;
  readonly shared: SharedData | undefined;
}

/** A group's copy of a run's result; its JSON text is written on first use. */
function variant(data: unknown): SharedData {
  let written = false;
  let text: string | undefined;
  return {
    data,
    json() {
      if (!written) {
        // `JSON.stringify` returns `undefined` for `undefined` and functions, whatever its type says.
        text = JSON.stringify(data) as string | undefined;
        written = true;
      }
      return text;
    },
  };
}

/** The copies of each shared run's result, by reader view key, for as long as the run is kept. */
const variants = new WeakMap<Run, Map<string, SharedData>>();

/**
 * The reply of a caller who took its result from `run` and sees it as `view`
 * shows: the copy made for the first caller with the same view, or a new one.
 * Views are equal only when they hide the same fields on every row, so a
 * caller never gets a copy made for a level above its own. Copies are frozen
 * when shared results are (`freezeSharedResults`), since callers share them.
 */
function sharedReply(run: Run, view: ReaderView, freeze: boolean): CallerReply {
  let copies = variants.get(run);
  if (copies === undefined) {
    copies = new Map();
    variants.set(run, copies);
  }
  let copy = copies.get(view.key);
  if (copy === undefined) {
    const data = view.strip();
    copy = variant(freeze ? deepFreeze(data) : data);
    copies.set(view.key, copy);
  }
  return { data: copy.data, shared: copy };
}

/**
 * The caller's level on each row: the one `dispatcher.access.levelsFor`
 * gives; without a policy, only a service-wide `Admin` grant (with
 * `adminBypass`) reaches tiered fields.
 */
function levelsReader(
  settings: PipelineSettings,
  target: RegisteredMethod,
  principal: Principal | null,
): (ids: readonly string[]) => Promise<RowLevels> {
  const { service } = target;
  return async (ids) => {
    if (principal === null) {
      return new Map();
    }
    if (service.access !== undefined && service.model !== undefined) {
      return await settings.policies.levelsFor(service.name, principal, ids);
    }
    const bypass = service.adminBypass && serviceGrant(principal, service.name) === "Admin";
    return new Map(ids.map((id) => [id, bypass ? "Admin" : null]));
  };
}

/**
 * The caller's result: the run's value as the caller's levels let it see it,
 * shared with the other callers of `call.source` (the shared run the call
 * started or joined) who see the same fields.
 */
export async function forCaller(
  settings: PipelineSettings,
  target: RegisteredMethod,
  call: { readonly principal: Principal | null; readonly source: Run | undefined },
  value: unknown,
): Promise<CallerReply> {
  const { projection } = target.method;
  const view =
    projection === undefined
      ? wholeView(value)
      : await readerView(projection, value, levelsReader(settings, target, call.principal));
  return call.source === undefined
    ? { data: view.strip(), shared: undefined }
    : sharedReply(call.source, view, settings.freezeSharedResults);
}
