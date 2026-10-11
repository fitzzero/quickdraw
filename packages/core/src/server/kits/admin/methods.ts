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
import { withReadOnlyFields } from "./meta";
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

/**
 * `adminMeta`'s handler: the answer worked out when the handlers were made,
 * with the relations of the service's model (which only the service knows,
 * from its projections) shown as not editable, once per service.
 */
function adminMetaHandler(context: AdminContext): KitHandler {
  const { meta } = context.fields;
  const byService = new WeakMap<object, typeof meta>();
  const handler = (args: KitHandlerArgs): Promise<typeof meta> => {
    const service = kitRuntimeOf(args.ctx)?.service;
    if (service === undefined) {
      return Promise.resolve(meta);
    }
    let answer = byService.get(service);
    if (answer === undefined) {
      answer = withReadOnlyFields(meta, relationKeysOf(service));
      byService.set(service, answer);
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
