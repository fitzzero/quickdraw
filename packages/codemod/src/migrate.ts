// The order of a run: contracts first (they decide each method's kind and
// moved schemas), then the services and every file that used their classes,
// then the web app's hooks, all applied at once; then the wrapper hooks no
// call uses any more go, and the 4.x API left over is marked.

import type { SourceFile } from "ts-morph";
import { Work } from "./apply";
import type { RunContext } from "./context";
import { findServices } from "./model";
import { planService } from "./plan";
import { isUnder } from "./project";
import {
  deleteWrappers,
  markLeftovers,
  migrateClient,
  migrateServices,
  queriedMethods,
  rewriteReferences,
  writeClientInfra,
  writeContracts,
  writeServerInfra,
} from "./transforms";

function jsFor(ctx: RunContext): (file: SourceFile) => boolean {
  return (file) => {
    if (isUnder(file, ctx.layout.shared.src)) {
      return ctx.js.shared;
    }
    return isUnder(file, ctx.layout.api.src) ? ctx.js.api : ctx.js.web;
  };
}

/** Runs every transform on the project of `ctx`, in memory. */
export function migrate(ctx: RunContext): void {
  const services = findServices(ctx.project, ctx.layout);
  const queried = queriedMethods(ctx);
  const plans = writeContracts(
    ctx,
    services.map((service) => planService(ctx, service, queried)),
  );
  if (plans.length > 0) {
    writeServerInfra(ctx);
  }
  const work = new Work();
  migrateServices(ctx, plans, work);
  rewriteReferences(ctx, plans, work);
  const wrappers = migrateClient(ctx, plans, work);
  if (ctx.stats.clientCalls > 0) {
    writeClientInfra(ctx);
  }
  work.apply(jsFor(ctx));
  deleteWrappers(ctx, wrappers);
  const leftovers = new Work();
  markLeftovers(ctx, leftovers);
  leftovers.apply(jsFor(ctx));
}
