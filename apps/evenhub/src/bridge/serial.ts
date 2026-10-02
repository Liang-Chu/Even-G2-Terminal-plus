import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

const instances = new WeakMap<EvenAppBridge, EvenAppBridge>();
const batches = new WeakMap<EvenAppBridge, <T>(action: (bridge: EvenAppBridge) => Promise<T>) => Promise<T>>();
const requests = new Set<PropertyKey>([
  "createStartUpPageContainer", "rebuildPageContainer", "textContainerUpgrade", "updateImageRawData",
  "shutDownPageContainer", "getDeviceInfo", "getLocalStorage", "setLocalStorage", "audioControl",
]);

/** Display, saved settings and microphone controls share one host request queue. */
export function serialBridge(bridge: EvenAppBridge): EvenAppBridge {
  const existing = instances.get(bridge);
  if (existing) return existing;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = tail.then(action);
    // A rejected call must release the queue without swallowing its error.
    tail = pending.catch(() => {});
    return pending;
  };
  const methods = new Map<PropertyKey, unknown>();
  const proxy = new Proxy(bridge, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!methods.has(property)) methods.set(property, requests.has(property)
        ? (...args: unknown[]) => enqueue(() => value.apply(target, args))
        : value.bind(target));
      return methods.get(property);
    },
  });
  instances.set(bridge, proxy); instances.set(proxy, proxy);
  batches.set(proxy, action => enqueue(() => action(bridge)));
  return proxy;
}

/** Keep one two-tile status bar consecutive; callers must await each SDK call. */
export function bridgeBatch<T>(bridge: EvenAppBridge, action: (bridge: EvenAppBridge) => Promise<T>): Promise<T> {
  return batches.get(serialBridge(bridge))!(action);
}
