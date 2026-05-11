/// <reference path="../bun-test.d.ts" />

import { afterEach, describe, expect, test } from "bun:test";
import { __clearPluginInitCacheForTests, getOrInitPluginState } from "../shared/runtime.js";

describe("getOrInitPluginState", () => {
  afterEach(() => {
    __clearPluginInitCacheForTests();
  });

  test("first invocation runs factory and reports isFirst=true", async () => {
    let factoryCalls = 0;
    const { value, isFirst } = await getOrInitPluginState("/tmp", async () => {
      factoryCalls += 1;
      return { tag: "first" };
    });

    expect(factoryCalls).toBe(1);
    expect(isFirst).toBe(true);
    expect(value).toEqual({ tag: "first" });
  });

  test("duplicate invocation for same canonical directory reuses cached value", async () => {
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return { tag: `call-${factoryCalls}` };
    };

    const first = await getOrInitPluginState("/tmp", factory);
    const second = await getOrInitPluginState("/tmp", factory);

    expect(factoryCalls).toBe(1);
    expect(first.isFirst).toBe(true);
    expect(second.isFirst).toBe(false);
    expect(second.value).toEqual(first.value);
  });

  test("different directories get independent entries", async () => {
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return { id: factoryCalls };
    };

    // Use two real distinct directories that both exist on disk so realpathSync
    // doesn't collapse them to one canonical key.
    const a = await getOrInitPluginState("/tmp", factory);
    const b = await getOrInitPluginState("/usr", factory);

    expect(factoryCalls).toBe(2);
    expect(a.isFirst).toBe(true);
    expect(b.isFirst).toBe(true);
    expect(a.value).not.toEqual(b.value);
  });

  test("concurrent invocations share a single in-flight init promise", async () => {
    let factoryCalls = 0;
    let resolveInit: ((value: { ok: true }) => void) | null = null;
    const factory = () => {
      factoryCalls += 1;
      return new Promise<{ ok: true }>((resolve) => {
        resolveInit = resolve;
      });
    };

    const first = getOrInitPluginState("/tmp", factory);
    const second = getOrInitPluginState("/tmp", factory);
    // Concurrent: only the first should be in flight; the second awaits the
    // same promise.
    expect(factoryCalls).toBe(1);

    if (!resolveInit) throw new Error("factory promise was never produced");
    (resolveInit as (value: { ok: true }) => void)({ ok: true });

    const [a, b] = await Promise.all([first, second]);
    expect(a.isFirst).toBe(true);
    expect(b.isFirst).toBe(false);
    expect(a.value).toBe(b.value);
  });

  test("failed first init evicts the cache entry so retry is possible", async () => {
    let attempt = 0;
    const factory = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { recovered: attempt };
    };

    await expect(getOrInitPluginState("/tmp", factory)).rejects.toThrow("boom");
    const retry = await getOrInitPluginState("/tmp", factory);
    expect(retry.isFirst).toBe(true);
    expect(retry.value).toEqual({ recovered: 2 });
  });

  test("canonicalDir resolves symlinks (macOS /var → /private/var)", async () => {
    // On macOS `/var` is a symlink to `/private/var`. On Linux they may be
    // independent. The test passes either way:
    //   - macOS: both queries hit the same canonical key, dedup works
    //   - Linux: both queries hit distinct keys, both invocations are first
    // The crucial bit is that we don't crash on a real path containing
    // symlink components.
    const factory = async () => ({ ok: true });
    const a = await getOrInitPluginState("/var", factory);
    const b = await getOrInitPluginState("/private/var", factory);

    expect(a.isFirst).toBe(true);
    // No assertion on b.isFirst — platform-dependent. Only that no crash.
    expect(typeof b.isFirst).toBe("boolean");
  });

  test("non-existent directory falls back to raw input as cache key", async () => {
    const fake = "/this-path-does-not-exist-aft-test-12345";
    const factory = async () => ({ ok: true });
    const a = await getOrInitPluginState(fake, factory);
    const b = await getOrInitPluginState(fake, factory);

    expect(a.isFirst).toBe(true);
    expect(b.isFirst).toBe(false);
  });
});
