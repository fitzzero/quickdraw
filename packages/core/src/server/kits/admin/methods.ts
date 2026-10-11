// The handler of each admin method (RFC 0003 section 12.4), and the form each
// runs under unless `admin.handlers` is given another: a service-wide `Admin`
// grant. 4.1 apps repeated a nine-key block of `"Admin"` levels for this
// (4.1 `src/server/BaseService.ts:1167-1183`).

import type { AdminMethodName } from "../../../contract/kits/admin";
import { kitRuntimeOf } from "../../context";
import { relationKeysOf } from "../columns";
import type { KitHandler, KitHandlerArgs } from "../crud/runtime";
import { adminListHandler } from "./list";
import { adminReemitHandler, adminSubscribersHandler } from "./live";
import { grantsColumnFor, withReadOnlyFields } from "./meta";
import {
  adminCreateHandler,
  adminDeleteHandler,
  adminGetHandler,
  adminUpdateHandler,
} from "./rows";
import type { AdminContext, AdminDefaultAccess } from "./types";

/** The form every admin method runs under when `access` gives none. */
export const ADMIN_DEFAULT_ACCESS: AdminDefaultAccess = Object.freeze({ service: "Admin" });

const MAKERS: Readonly<
  Record<Exclude<AdminMethodName, "adminMeta">, (context: AdminContext) => KitHandler>
> = Object.freeze({
  adminList: adminListHandler,
  adminGet: adminGetHandler,
  adminCreate: adminCreateHandler,
  adminUpdate: adminUpdateHandler,
  adminDelete: adminDeleteHandler,
  adminSubscribers: adminSubscribersHandler,
  adminReemit: adminReemitHandler,
});

type Meta = ReturnType<AdminContext["fieldsFor"]>["meta"];

/**
 * `adminMeta`'s handler: the answer worked out for the server's grants
 * column on the service's model (`grantsColumnFor`), with the relations of
 * the service's model (which only the service knows, from its projections)
 * shown as not editable, once per service and column.
 */
function adminMetaHandler(context: AdminContext): KitHandler {
  const byService = new WeakMap<object, Map<string, Meta>>();
  const handler = (args: KitHandlerArgs): Promise<Meta> => {
    const runtime = kitRuntimeOf(args.ctx);
    if (runtime === undefined) {
      return Promise.resolve(context.fieldsFor(undefined).meta);
    }
    const { service } = runtime;
    const column = grantsColumnFor(service.model, runtime.grantsSource);
    const answers = byService.get(service) ?? new Map<string, Meta>();
    byService.set(service, answers);
    let answer = answers.get(column ?? "");
    if (answer === undefined) {
      answer = withReadOnlyFields(context.fieldsFor(column).meta, relationKeysOf(service));
      answers.set(column ?? "", answer);
    }
    return Promise.resolve(answer);
  };
  return handler as KitHandler;
}

/** The handler of one admin method: a new function for each, which `defineService` checks. */
export function handlerOf(context: AdminContext): KitHandler {
  const { method } = context.spec;
  return method === "adminMeta" ? adminMetaHandler(context) : MAKERS[method](context);
}
