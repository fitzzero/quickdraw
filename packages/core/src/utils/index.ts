// Isomorphic exports for @fitzzero/quickdraw-core/utils: code that runs the
// same in the browser, in React Native and on the server, React server
// components included. Nothing here touches the DOM or imports React or a
// dependency, and the entry carries no "use client" directive
// (scripts/dist-smoke.mjs checks both).
//
// In 4.1 these helpers came from `./client` only, which carried no directive
// then. 5.0's `./client` begins with "use client", so a server component can
// no longer call into it; it still re-exports everything here for client code.

export {
  formatCurrency,
  formatNumber,
  formatDate,
  formatDateTime,
  truncate,
  formatPercent,
} from "./formatting";

export {
  findNavItemByHref,
  findParentNavItem,
  buildBreadcrumbs,
  routeRequiresAuth,
  type NavItem,
  type BreadcrumbItem,
} from "./navigation";

export { parseJWTPayload, type JWTPayload } from "./jwt";

// Calls over HTTP and the cache keys they share with the client's hooks: what
// a server component needs to prefetch for hydration.
export {
  KEY_ROOT,
  collectionKey,
  entityKey,
  methodKey,
  methodKeyPrefix,
  serviceKeyPrefix,
  type CollectionQueryKey,
  type EntityQueryKey,
  type MethodKeyPrefix,
  type MethodQueryKey,
  type ServiceKeyPrefix,
} from "../client/keys";
export {
  createServerCaller,
  type ServerCallOptions,
  type ServerCaller,
  type ServerCallerHeaders,
  type ServerCallerOptions,
  type ServerMethod,
  type ServerMutation,
  type ServerQuery,
} from "../client/serverCaller";
