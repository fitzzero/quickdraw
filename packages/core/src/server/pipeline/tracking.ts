// Tracked writes in the dispatcher (RFC 0003 sections 5.1 and 5.3): the
// units of work handler runs open, where they flush, and `ctx.touch`. A
// tracked database client (`trackPrisma` on `./prisma`) carries its storage
// adapter, so passing it as `db` is all an app does:
//
//   export const db = trackPrisma(new PrismaClient({ adapter }));
//   qd.createServer({ app, services, db });
//
// Without one, units of work record nothing and `ctx.touch` does nothing.

import type { AnyContract } from "../../contract/defineContract";
import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import type { BaseContext } from "../context";
import type { Registry } from "../registry";
import { modelKey, storageOf, type StorageAdapter } from "../storage";
import { combineSinks } from "../uow/flush";
import type { FlushSink } from "../uow/flushSink";
import type { UnitOfWorkFactory } from "../uow/types";
import { untrackedUnitOfWork } from "../uow/untracked";

/** The dispatcher's tracked-writes options. */
export interface TrackingOptions {
  /**
   * How the server reads the database and learns of writes. Default: the
   * adapter a tracked `db` carries (`storageOf(db)`), or none.
   */
  readonly storage?: StorageAdapter;
  /** Opens the unit of work of each handler run. Default: the storage adapter's, or units that track nothing. */
  readonly unitOfWork?: UnitOfWorkFactory;
  /**
   * Where units of work flush their writes, in order: each flush goes to
   * every sink, and a sink that throws is logged and reported to the others
   * (`FlushSink.onFlushError`). Default: nowhere.
   */
  readonly flushSink?: FlushSink | readonly FlushSink[];
}

/** The tracked-writes part of the pipeline's settings. */
export interface Tracking {
  readonly storage: StorageAdapter | undefined;
  readonly unitOfWork: UnitOfWorkFactory;
  /** The sinks, combined into one. */
  readonly flushSink: FlushSink;
  /** Every call's `ctx.touch`. */
  readonly touch: BaseContext["touch"];
}

function sinksOf(option: TrackingOptions["flushSink"]): readonly FlushSink[] {
  if (option === undefined) {
    return [];
  }
  const sinks: readonly unknown[] = Array.isArray(option) ? option : [option];
  for (const sink of sinks) {
    if (typeof (sink as Partial<FlushSink> | null)?.flush !== "function") {
      throw new TypeError("createDispatcher: flushSink must be a flush sink or an array of them");
    }
  }
  return sinks as readonly FlushSink[];
}

/**
 * The model `ctx.touch` names: a model name as is, or a contract's model,
 * which its service declares with `model` (RFC 0003 section 3).
 */
function modelOf(registry: Registry, target: string | AnyContract): string {
  if (typeof target === "string" && target.length > 0) {
    return modelKey(target);
  }
  if (typeof target !== "object" || target === null) {
    throw new TypeError('ctx.touch: name the model, as in ctx.touch("task", ids)');
  }
  for (const service of registry.services.values()) {
    if (service.contract === target && service.model !== undefined) {
      return modelKey(service.model);
    }
  }
  throw new QuickdrawError(
    "INTERNAL",
    `ctx.touch: no service of this dispatcher declares the database model of ${target.name}; pass the model name, as in ctx.touch("task", ids)`,
  );
}

function idsOf(ids: string | readonly string[]): readonly string[] {
  const list: unknown = typeof ids === "string" ? [ids] : ids;
  if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("ctx.touch: ids must be a row id or an array of row ids");
  }
  return list as readonly string[];
}

/**
 * Resolves the dispatcher's tracked-writes options. The framework's own
 * sinks go first on the sink list, in the order given (the live data's
 * intake, the access cache's evictions and access-change events, the entity
 * frames), so the app's sinks after them read access afresh.
 */
export function resolveTracking(
  options: TrackingOptions,
  registry: Registry,
  db: unknown,
  logger: Logger,
  framework: readonly (FlushSink | undefined)[] = [],
): Tracking {
  const storage = options.storage ?? storageOf(db);
  const unitOfWork = options.unitOfWork ?? storage?.unitOfWork ?? untrackedUnitOfWork;
  const touch: BaseContext["touch"] = (target, ids, touchOptions) => {
    const model = modelOf(registry, target);
    const rows = idsOf(ids);
    unitOfWork.touch?.(model, rows, touchOptions);
  };
  const own = framework.filter((sink): sink is FlushSink => sink !== undefined);
  return {
    storage,
    unitOfWork,
    flushSink: combineSinks([...own, ...sinksOf(options.flushSink)], logger),
    touch,
  };
}
