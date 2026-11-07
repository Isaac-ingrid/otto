/**
 * A Durable Object namespace binding, keyed by id name.
 *
 * A personal deployment has a single steward (`owner`), so `env.Steward` is a namespace in name
 * only: `getAgentByName(env.Steward, "owner")` and `routeAgentRequest()` are resolved by the
 * real Agents SDK against `idFromName`/`get`, and both land on the same object. The factory is
 * keyed by id name so the test harness can hand out independent instances (workerd gives every
 * `idFromName` its own storage; several suites rely on that to build "old" Durable Objects).
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

/** Property the harness reads back off a stub to find out which instance it talks to. */
export const INSTANCE_NAME = "__sigInstanceName";

export function createStub<T extends object>(getName: () => string, getInstance: () => T): T {
  const target = Object.create(null) as T;
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") return undefined;
      if (property === INSTANCE_NAME) return getName();
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

export function createNamespace<T extends object>(
  name: string,
  getInstance: (idName: string) => T,
): DurableObjectNamespaceLike<T> {
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
    get(id?: DurableObjectIdLike) {
      const idName = id?.name ?? name;
      return createStub(() => idName, () => getInstance(idName));
    },
    jurisdiction() {
      return namespace;
    },
  };
  return namespace;
}
