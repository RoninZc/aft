import { realpathSync } from "node:fs";

type BridgeLike = {
  getBridge: (
    directory: string,
    sessionID: string,
  ) => {
    send: (command: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

const GLOBAL_KEY = "__AFT_SHARED_BRIDGE_POOL__";

function getGlobalState(): { [GLOBAL_KEY]?: BridgeLike | null } {
  return globalThis as { [GLOBAL_KEY]?: BridgeLike | null };
}

export function setSharedBridgePool(pool: BridgeLike): void {
  getGlobalState()[GLOBAL_KEY] = pool;
}

export function getSharedBridgePool(): BridgeLike | null {
  return getGlobalState()[GLOBAL_KEY] ?? null;
}

export function clearSharedBridgePool(): void {
  getGlobalState()[GLOBAL_KEY] = null;
}

// ─────────────────────────── duplicate-init defense ─────────────────────────
//
// OpenCode currently calls our server-plugin function twice per process (see
// the "duplicate bridge per OpenCode" investigation in commits since v0.21.0).
// Each call would otherwise spawn its own BridgePool (= aft binary subprocess),
// AftRpcServer (= HTTP listener fighting for the port file), and run the eager
// `bridge.send("status")` warmup again.
//
// We dedupe by canonicalized project directory using a process-global Map. The
// first invocation runs full init and stores the result; later invocations
// resolve to the SAME init result. Callers detect the cache hit and return an
// empty hooks object so OpenCode's `for (const hook of hooks)` iteration
// doesn't fire the same tool.execute.after / event / config callbacks twice.
//
// Stored on globalThis with a Symbol key so multiple ESM module instances of
// this file (which IS the underlying cause — same plugin imported twice as
// distinct module graphs) all share the same Map.

const INIT_CACHE_KEY = Symbol.for("@cortexkit/aft-opencode/plugin-init-cache-v1");

type InitCacheEntry<T> = Promise<T>;
type InitCache = Map<string, InitCacheEntry<unknown>>;

function getInitCache(): InitCache {
  const g = globalThis as { [INIT_CACHE_KEY]?: InitCache };
  if (!g[INIT_CACHE_KEY]) {
    g[INIT_CACHE_KEY] = new Map();
  }
  return g[INIT_CACHE_KEY];
}

function canonicalDir(directory: string): string {
  // Falls back to the input on ENOENT / permission errors — the watcher fix
  // already uses this same pattern. Canonicalizing matters here because
  // macOS surfaces /var/folders/... and /private/var/folders/... for the
  // same path, and we don't want to treat them as different cache keys.
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Returns the cached init result for `directory` if one exists, otherwise
 * runs `factory()` and stores the resulting Promise. Concurrent callers
 * with the same canonical directory share the same Promise.
 *
 * Returns `{ value, isFirst }` so callers can branch on first vs duplicate
 * invocation (first runs full hook registration; duplicate returns empty
 * hooks to avoid OpenCode firing the same callbacks twice).
 */
export async function getOrInitPluginState<T>(
  directory: string,
  factory: () => Promise<T>,
): Promise<{ value: T; isFirst: boolean }> {
  const cache = getInitCache();
  const key = canonicalDir(directory);
  const existing = cache.get(key) as InitCacheEntry<T> | undefined;
  if (existing) {
    return { value: await existing, isFirst: false };
  }
  const created = factory();
  cache.set(key, created);
  try {
    return { value: await created, isFirst: true };
  } catch (err) {
    // Failed init: clear the cache entry so a retry (e.g. the duplicate
    // invocation OpenCode is about to make) can try again rather than
    // permanently failing.
    cache.delete(key);
    throw err;
  }
}

/**
 * Test-only: clears the per-directory init cache. Production code should
 * never call this — process lifetime owns the cache.
 */
export function __clearPluginInitCacheForTests(): void {
  getInitCache().clear();
}
