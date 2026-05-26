/// <reference path="../bun-test.d.ts" />
/**
 * Unit tests for aft_outline/aft_zoom argument shaping.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgePool } from "@cortexkit/aft-bridge";
import type { ToolContext } from "@opencode-ai/plugin";
import { readingTools } from "../tools/reading.js";
import type { PluginContext } from "../types.js";
import { noopAsk } from "./test-helpers";

type BridgeResponse = Record<string, unknown>;
type SendCall = { command: string; params: Record<string, unknown> };
type AskCall = {
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
};

const tempRoots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aft-opencode-reading-"));
  tempRoots.push(root);
  return root;
}

function createMockClient(): any {
  return {
    lsp: {
      status: async () => ({ data: [] }),
    },
    find: {
      symbols: async () => ({ data: [] }),
    },
  };
}

function createPluginContext(pool: BridgePool): PluginContext {
  return {
    pool,
    client: createMockClient(),
    config: {} as PluginContext["config"],
    storageDir: "/tmp/aft-reading-test",
  };
}

function createMockSdkContext(directory: string, ask: ToolContext["ask"] = noopAsk): ToolContext {
  return {
    sessionID: "reading-session",
    messageID: "message-id",
    agent: "test",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask,
  };
}

function recordingAsk(calls: AskCall[]): ToolContext["ask"] {
  return (async (input: AskCall) => {
    calls.push(input);
  }) as unknown as ToolContext["ask"];
}

function createMockReadingHarness(
  sendImpl: (
    command: string,
    params: Record<string, unknown>,
  ) => Promise<BridgeResponse> | BridgeResponse,
) {
  const sendCalls: SendCall[] = [];
  const bridge = {
    send: async (command: string, params: Record<string, unknown>) => {
      sendCalls.push({ command, params });
      return await sendImpl(command, params);
    },
  };
  const pool = {
    getBridge: () => bridge,
  } as unknown as BridgePool;

  return {
    sendCalls,
    tools: readingTools(createPluginContext(pool)),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("reading tool adapters", () => {
  test("aft_outline files:true appends a walk-cap footer after the file table", async () => {
    const root = await tempProject();
    await mkdir(join(root, "src"));
    const uncheckedFiles = Array.from({ length: 12 }, (_, index) => `src/overflow-${index + 1}.ts`);
    const { sendCalls, tools } = createMockReadingHarness(() => ({
      success: true,
      text: "path | language | symbols",
      complete: false,
      walk_truncated: true,
      unchecked_files: uncheckedFiles,
    }));

    const output = await tools.aft_outline.execute(
      { target: "src", files: true },
      createMockSdkContext(root),
    );

    expect(sendCalls[0]?.params).toMatchObject({ directory: join(root, "src"), files: true });
    expect(output).toContain("path | language | symbols");
    expect(output).toContain(
      "⚠ Partial result: walk truncated at 200 files. 12 additional files in this directory were not indexed.",
    );
    expect(output).toContain("Unchecked files:");
    expect(output).toContain("src/overflow-1.ts");
    expect(output).toContain("src/overflow-10.ts");
    expect(output).not.toContain("src/overflow-11.ts");
    expect(output).toContain("... +2 more");
  });

  test("aft_outline files:true asks external_directory for an out-of-project directory", async () => {
    const tmpRoot = await tempProject();
    const project = join(tmpRoot, "project");
    const external = join(tmpRoot, "external");
    await mkdir(project, { recursive: true });
    await mkdir(external, { recursive: true });
    const askCalls: AskCall[] = [];
    const { sendCalls, tools } = createMockReadingHarness(() => ({
      success: true,
      text: "external files",
    }));

    await tools.aft_outline.execute(
      { target: external, files: true },
      createMockSdkContext(project, recordingAsk(askCalls)),
    );

    const externalAsks = askCalls.filter((call) => call.permission === "external_directory");
    expect(externalAsks).toHaveLength(1);
    expect(externalAsks[0]?.patterns).toEqual([join(tmpRoot, "*").replaceAll("\\", "/")]);
    expect(externalAsks[0]?.metadata?.filepath).toBe(external);
    expect(sendCalls[0]?.params).toMatchObject({ directory: external, files: true });
  });

  test("aft_outline files:true target arrays ask once per unique external parent", async () => {
    const tmpRoot = await tempProject();
    const project = join(tmpRoot, "project");
    const externalRoot = join(tmpRoot, "external");
    const first = join(externalRoot, "first");
    const second = join(externalRoot, "second");
    await mkdir(project, { recursive: true });
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const askCalls: AskCall[] = [];
    const { sendCalls, tools } = createMockReadingHarness(() => ({
      success: true,
      text: "external files",
    }));

    await tools.aft_outline.execute(
      { target: [first, second], files: true },
      createMockSdkContext(project, recordingAsk(askCalls)),
    );

    const externalAsks = askCalls.filter((call) => call.permission === "external_directory");
    expect(externalAsks).toHaveLength(1);
    expect(externalAsks[0]?.patterns).toEqual([join(externalRoot, "*").replaceAll("\\", "/")]);
    expect(sendCalls[0]?.params).toMatchObject({ target: [first, second], files: true });
  });
});
