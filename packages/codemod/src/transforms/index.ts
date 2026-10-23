// The transforms, in the order a run applies them (see ../migrate.ts).

export { deleteEmptied, findAggregators, removeAggregators } from "./aggregators";
export { deleteWrappers, migrateClient, queriedMethods } from "./client";
export { writeContracts } from "./contracts";
export { typeHelperClients } from "./helperClients";
export { writeClientInfra, writeServerInfra } from "./infra";
export { markLeftovers } from "./leftovers";
export { freeMemberNames } from "./memberNames";
export { freeMethodNames } from "./methodNames";
export { rewriteReferences } from "./references";
export { markTestClasses, migrateServices } from "./services";
