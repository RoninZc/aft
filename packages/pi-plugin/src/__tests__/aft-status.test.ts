/**
 * Unit tests for the /aft-status command adapter.
 */

/// <reference path="../bun-test.d.ts" />

import { describe, expect, test } from "bun:test";
import { registerStatusCommand } from "../commands/aft-status.js";
import { makeMockApi, makeMockBridge, makePluginContext } from "./tool-test-utils.js";

describe("aft-status command", () => {
  test("opens the formatted status in the UI when UI is available", async () => {
    const { api, commands } = makeMockApi();
    const { bridge, calls } = makeMockBridge(() => ({
      success: true,
      version: "0.19.0",
      project_root: "/repo",
      features: { format_on_edit: true, search_index: true, semantic_search: false },
      search_index: { status: "ready", files: 12, trigrams: 34 },
      semantic_index: { status: "disabled", entries: null },
      disk: { trigram_disk_bytes: 1024, semantic_disk_bytes: 0 },
      lsp_servers: 2,
      symbol_cache: { local_entries: 3, warm_entries: 4 },
    }));
    const inputCalls: Array<{ title: string; text: string }> = [];
    registerStatusCommand(api, makePluginContext(bridge));

    await commands.get("aft-status")!.handler("", {
      cwd: "/repo",
      hasUI: true,
      ui: {
        input: async (title: string, text: string) => inputCalls.push({ title, text }),
        notify: () => undefined,
      },
    });

    expect(calls[0].command).toBe("status");
    expect(inputCalls).toHaveLength(1);
    expect(inputCalls[0].title).toBe("AFT Status");
    expect(inputCalls[0].text).toContain("AFT version: 0.19.0");
    expect(inputCalls[0].text).toContain("LSP servers: 2");
  });

  test("falls back to notify in non-UI mode", async () => {
    const { api, commands } = makeMockApi();
    const { bridge } = makeMockBridge(() => ({ success: true, version: "0.19.0" }));
    const notifications: Array<{ message: string; level: string }> = [];
    registerStatusCommand(api, makePluginContext(bridge));

    await commands.get("aft-status")!.handler("", {
      cwd: "/repo",
      hasUI: false,
      ui: {
        input: async () => undefined,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ level: "info" });
    expect(notifications[0].message).toContain("AFT version: 0.19.0");
  });

  test("reports bridge failures as UI errors without throwing", async () => {
    const { api, commands } = makeMockApi();
    const { bridge } = makeMockBridge(() => ({ success: false, message: "bridge down" }));
    const notifications: Array<{ message: string; level: string }> = [];
    registerStatusCommand(api, makePluginContext(bridge));

    await commands.get("aft-status")!.handler("", {
      cwd: "/repo",
      hasUI: true,
      ui: {
        input: async () => undefined,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    expect(notifications).toEqual([{ message: "AFT status failed: bridge down", level: "error" }]);
  });
});
