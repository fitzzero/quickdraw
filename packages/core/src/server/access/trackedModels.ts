// The models access depends on must be tracked (the 5.1 audit's DATA-3). The
// write tracker keys rows by a string `id`, so a table keyed by a composite
// `@@id([projectId, userId])` with no `id` column is never tracked: its first
// write stops tracking it for the life of the process, with one warning. A
// membership table of that shape (`members()` read it, `bindings.ts`
// registered interest in it) then never revoked anything: removing a member
// left them the live rows, collection scopes, change topics and stream feeds
// it had let them subscribe to.
//
// `createServer` asks the storage adapter, at start, whether it can track
// each model an access policy, a membership table or a `via` junction
// depends on (`StorageAdapter.trackable`), in the background since it
// starts synchronously. Each it cannot is named with
// `[quickdraw:untracked-access-model]`, logged as an error in every
// environment; a test app made with `strictWarnings` fails to start instead.
// A probe that fails (the database down) is logged as a warning and never
// fails the server.

import type { Logger } from "../../contract/logger";
import {
  DevWarningError,
  formatDevWarning,
  strictWarningsOf,
  type DevWarning,
} from "../devWarnings";
import { describeError } from "../pipeline/metrics";
import { storageFor, type TrackingOptions } from "../pipeline/tracking";
import type { Registry } from "../registry";
import { modelKey, type StorageAdapter } from "../storage";

/**
 * The models access depends on, as `modelKey` spells them, each with who
 * reads it: every policed service's own model, every membership table a
 * policy reads, and every `via` collection's junction table.
 */
export function accessModels(registry: Registry): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const add = (model: string, reader: string): void => {
    const key = modelKey(model);
    const readers = models.get(key) ?? [];
    if (!readers.includes(reader)) {
      readers.push(reader);
    }
    models.set(key, readers);
  };
  for (const service of registry.services.values()) {
    const { access, model } = service;
    if (access !== undefined && model !== undefined) {
      add(model, `${service.name}'s access policy`);
    }
    for (const membership of access?.reads.memberships ?? []) {
      add(membership.model, `${service.name}'s access policy`);
    }
    for (const collection of service.collections.values()) {
      if (collection.scope.kind === "via") {
        add(collection.scope.model, `${service.name}'s ${collection.name} collection`);
      }
    }
  }
  return models;
}

/** The warning for a model access depends on that the tracker cannot key. */
function untrackedWarning(model: string, readBy: readonly string[]): DevWarning {
  return {
    kind: "untracked-access-model",
    subject: model,
    message:
      `${model} has no id column the write tracker can key its rows by, so none of its writes are tracked, ` +
      `yet ${readBy.join(" and ")} read it: removing a row from it never revokes the live rows, collection ` +
      `scopes, change topics and stream feeds it let someone subscribe to. Give it an id ` +
      `(id String @id @default(cuid())) and keep its pair unique with @@unique([...]) instead of a composite @@id`,
    meta: { model, readBy: [...readBy] },
  };
}

/**
 * Names each model access depends on that `storage` cannot track: logged as
 * an error, or, when `strict`, thrown as a `DevWarningError` for the first.
 * Nothing when the adapter cannot say (`trackable` is optional). A probe
 * that fails is logged as a warning; the check never rejects otherwise.
 */
export async function checkTrackedModels(
  registry: Registry,
  storage: StorageAdapter | undefined,
  options: { readonly logger: Logger; readonly strict: boolean },
): Promise<void> {
  const trackable = storage?.trackable;
  if (trackable === undefined) {
    return;
  }
  const { logger, strict } = options;
  const models = [...accessModels(registry)];
  const answers = await Promise.all(
    models.map(async ([model]) => {
      try {
        return await trackable.call(storage, model);
      } catch (error) {
        logger.warn(`createServer: could not check whether ${model} is tracked`, {
          category: "quickdraw.access",
          model,
          error: describeError(error),
        });
        return true;
      }
    }),
  );
  for (const [index, [model, readBy]] of models.entries()) {
    if (answers[index] !== false) {
      continue;
    }
    const warning = untrackedWarning(model, readBy);
    if (strict) {
      throw new DevWarningError(warning);
    }
    logger.error(formatDevWarning(warning), {
      category: "quickdraw.access",
      warning: warning.kind,
      model,
      readBy: [...readBy],
    });
  }
}

/**
 * Starts `createServer`'s check of the models access depends on, in the
 * background: strict for a test app made with `strictWarnings`. The promise
 * is handled, so nothing is left unhandled when only a test awaits it.
 */
export function startTrackedModelsCheck(
  registry: Registry,
  options: TrackingOptions & { readonly db?: unknown },
  logger: Logger,
): Promise<void> {
  const check = checkTrackedModels(registry, storageFor(options, options.db), {
    logger,
    strict: strictWarningsOf(options),
  });
  check.catch(() => undefined);
  return check;
}
