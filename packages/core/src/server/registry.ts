// The services a dispatcher serves, by name. 4.1's `ServiceRegistry` also
// wired one Socket.IO listener per method per socket
// (4.1 `src/server/ServiceRegistry.ts:118-136`); in 5.0 the registry only
// resolves names, and the transports keep a fixed listener set.

import { runtimeOf, type AnyService, type ServiceMethod } from "./service";

/** A method found by name, with the service it belongs to. */
export interface RegisteredMethod {
  readonly service: AnyService;
  readonly method: ServiceMethod;
}

/** The services of one dispatcher, by service name. */
export interface Registry {
  /** Every service, by name. */
  readonly services: ReadonlyMap<string, AnyService>;
  /** The method `method` of service `service`, or `undefined` when either is unknown. */
  find(service: string, method: string): RegisteredMethod | undefined;
}

/**
 * Indexes services by name. Throws when two services share a name, or when
 * a value is not a service `defineService` returned.
 */
export function createRegistry(services: readonly AnyService[]): Registry {
  if (!Array.isArray(services)) {
    throw new TypeError("createRegistry: services must be an array of services");
  }
  const byName = new Map<string, AnyService>();
  for (const service of services) {
    if (runtimeOf(service) === undefined) {
      throw new TypeError("createRegistry: every service must come from qd.defineService");
    }
    if (byName.has(service.name)) {
      throw new TypeError(`createRegistry: two services are named "${service.name}"`);
    }
    byName.set(service.name, service);
  }
  return Object.freeze({
    services: byName,
    find(serviceName: string, methodName: string): RegisteredMethod | undefined {
      const service = byName.get(serviceName);
      if (service === undefined || !Object.hasOwn(service.methods, methodName)) {
        return undefined;
      }
      const method = service.methods[methodName];
      return method === undefined ? undefined : { service, method };
    },
  });
}
