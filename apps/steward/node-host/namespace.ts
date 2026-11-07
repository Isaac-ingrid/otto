/**
 * A Durable Object namespace binding, backed by one live instance.
 *
 * A personal deployment has a single steward (`owner`), so the binding is a namespace in name
 * only: `getAgentByName(env.Steward, "owner")` and `routeAgentRequest()` are resolved by the
 * real Agents SDK against `idFromName`/`get`, and all of it lands on the same object.
 *
 * The stub is a `Proxy` because callers use both halves of the DO surface — `stub.fetch()`
 * and RPC methods such as `stub.pair(...)`.
 */
import { NodeDurableObjectId, type DurableObjectIdLike } from "./state.ts";

export interface DurableObjectNamespaceLike<T extends object> {
  idFromName(name: string): DurableObjectIdLike;
  idFromString(id: string): DurableObjectIdLike;
  newUniqueId(): DurableObjectIdLike;
  get(id: DurableObjectIdLike): T;
  jurisdiction(name: string): DurableObjectNamespaceLike<T>;
}

export function createStub<T extends object>(getName: () => string, getInstance: () => T): T {
  const target = Object.create(null) as T;
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") return undefined;
      const instance = getInstance();
      const value = Reflect.get(instance as object, property, instance);
      if (typeof value === "function") return (value as (...args: unknown[]) => unknown).bind(instance);
      return value;
    },
    has(_target, property) {
      return typeof property === "string" && property in (getInstance() as object);
    },
    ownKeys() {
      return Reflect.ownKeys(getInstance() as object);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(getInstance() as object, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

export function createNamespace<T extends object>(name: string, getInstance: () => T): DurableObjectNamespaceLike<T> {
  const namespace: DurableObjectNamespaceLike<T> = {
    idFromName(candidate: string) {
      return new NodeDurableObjectId(candidate);
    },
    idFromString(candidate: string) {
      return new NodeDurableObjectId(candidate);
    },
    newUniqueId() {
      return new NodeDurableObjectId(name);
    },
    get() {
      return createStub(() => name, getInstance);
    },
    jurisdiction() {
      return namespace;
    },
  };
  return namespace;
}
