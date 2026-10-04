// The marker each overridden 4.x hook gets when its class is hoisted
// (`hoist.ts`): what replaces it in 5.0, and which report section lists it.

import type { Category } from "./markers";

/** The marker each overridden 4.x hook gets, by name. */
export const HOOK_NOTES: Readonly<Record<string, { category: Category; message: string }>> = {
  checkAccess: {
    category: "access-override",
    message:
      "4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function",
  },
  checkEntryACL: {
    category: "access-override",
    message:
      "4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function",
  },
  checkSubscriptionAccess: {
    category: "access-override",
    message:
      "4.x subscription access override: subscriptions use the service's policy in 5.0; port it there, then delete this function",
  },
  checkBatchSubscriptionAccess: {
    category: "access-override",
    message:
      "4.x subscription access override: subscriptions use the service's policy in 5.0; port it there, then delete this function",
  },
  hasServiceAccess: {
    category: "access-override",
    message:
      "4.x service-grant override: 5.0 reads grants from principal.serviceAccess; port it to the policy or the method forms, then delete this function",
  },
  toDto: {
    category: "projection",
    message:
      "4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function",
  },
  getProtectedFields: {
    category: "projection",
    message:
      'protected fields: declare them in the contract\'s fields with the level that may read each one (fields: { email: "Admin" }), then delete this function',
  },
  hasElevatedAccess: {
    category: "projection",
    message:
      "who saw protected fields: in 5.0 the contract's fields levels decide it per row; delete this function once they are declared",
  },
  beforeCreate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows, then delete it",
  },
  afterCreate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows (or affects, for rows of other services), then delete it",
  },
  beforeUpdate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.update: move what it does into the methods that update rows, then delete it",
  },
  afterUpdate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.update: move what it does into the methods that update rows (or affects), then delete it",
  },
  beforeDelete: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.delete: move what it does into the methods that delete rows, then delete it",
  },
  afterDelete: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.delete: move what it does into the methods that delete rows (or affects), then delete it",
  },
};
