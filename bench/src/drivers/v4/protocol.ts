/**
 * The 4.1 event names the benchmark app exposes, spelled the way the 4.1
 * client hooks build them.
 */

export const SERVICE = "taskService";
export const COLLECTION = "cardsByProject";

export const EVENTS = {
  getTasksByStatus: `${SERVICE}:getTasksByStatus`,
  updateTask: `${SERVICE}:updateTask`,
  batchSubscribe: `${SERVICE}:batchSubscribe`,
  unsubscribe: `${SERVICE}:unsubscribe`,
  collectionSubscribe: `${SERVICE}:collection:subscribe`,
  collectionUnsubscribe: `${SERVICE}:collection:unsubscribe`,
} as const;

/** `{service}:collection:{name}:{scopeId}`: the delta event and the room name. */
export function collectionEvent(scopeId: string): string {
  return `${SERVICE}:collection:${COLLECTION}:${scopeId}`;
}

/** `{service}:update:{id}`: an entity update for one subscribed row. */
export function entityUpdateEvent(entryId: string): string {
  return `${SERVICE}:update:${entryId}`;
}

/** Timeouts the 4.1 hooks apply (useServiceQuery, useService, useCollection). */
export const CLIENT_TIMEOUT_MS = 10_000;
/** useServiceQuery: TanStack's default single retry after 1 s. */
export const QUERY_RETRIES = 1;
export const QUERY_RETRY_DELAY_MS = 1_000;
/** useServiceQuery's invalidateOn debounce. */
export const INVALIDATE_DEBOUNCE_MS = 100;
