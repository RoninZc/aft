/**
 * Unit tests for hoisted read/write/edit/grep argument shaping.
 */

/// <reference path="../bun-test.d.ts" />

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReadFooter, registerHoistedTools } from "../tools/hoisted.js";
import { executeTool, makeMockApi, makeMockBridge, makePluginContext } from "./tool-test-utils.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `aft-pi-hoisted-${process.pid}-${roots.length}-${Date.now()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hoisted tool adapters", () => {
  test("read maps offset/limit to inclusive start_line/end_line and appends footer", async () => {
    const { api, tools } = makeMockApi();
    const { bridge, calls } = makeMockBridge(() => ({
      success: true,
      content: "1: a\n2: b",
      truncated: true,
      start_line: 1,
      end_line: 2,
      total_lines: 10,
    }));
    registerHoistedTools(api, makePluginContext(bridge), {
      hoistRead: true,
      hoistWrite: false,
      hoistEdit: false,
      hoistGrep: false,
    });

    const ranged = (await executeTool(tools.get("read")!, {
      path: "src/app.ts",
      offset: 5,
      limit: 3,
    })) as { content: Array<{ text: string }> };

    expect(calls[0].params).toEqual({ file: "src/app.ts", start_line: 5, end_line: 7 });
    expect(ranged.content[0].text).not.toContain("Use offset/limit");

    const unbounded = (await executeTool(tools.get("read")!, { path: "src/app.ts" })) as {
      content: Array<{ text: string }>;
    };
    expect(unbounded.content[0].text).toContain("Showing lines 1-2 of 10");
  });

  test("edit appendContent uses append op instead of match/replacement fields", async () => {
    const { api, tools } = makeMockApi();
    const { bridge, calls } = makeMockBridge(() => ({ success: true, diff: { additions: 1 } }));
    registerHoistedTools(api, makePluginContext(bridge), {
      hoistRead: false,
      hoistWrite: false,
      hoistEdit: true,
      hoistGrep: false,
    });

    await executeTool(tools.get("edit")!, {
      filePath: "README.md",
      oldString: "ignored",
      newString: "ignored",
      appendContent: "\nnext",
    });

    expect(calls[0].command).toBe("edit_match");
    expect(calls[0].params).toEqual({
      op: "append",
      file: "README.md",
      append_content: "\nnext",
      diagnostics: true,
      include_diff: true,
    });
  });

  test("grep resolves existing path args and preserves brace-aware include globs", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "console.log('x');\n");
    const { api, tools } = makeMockApi();
    const { bridge, calls } = makeMockBridge(() => ({ success: true, text: "" }));
    registerHoistedTools(api, makePluginContext(bridge), {
      hoistRead: false,
      hoistWrite: false,
      hoistEdit: false,
      hoistGrep: true,
    });

    await executeTool(
      tools.get("grep")!,
      { pattern: "console", path: "src", include: "*.ts,**/*.{tsx,jsx}", contextLines: 2 },
      { cwd: root } as never,
    );

    expect(calls[0].command).toBe("grep");
    expect(calls[0].params).toEqual({
      pattern: "console",
      path: join(root, "src"),
      include: ["*.ts", "**/*.{tsx,jsx}"],
      context_lines: 2,
    });
  });

  test("write always asks Rust for diagnostics and a diff", async () => {
    const { api, tools } = makeMockApi();
    const { bridge, calls } = makeMockBridge(() => ({ success: true, diff: { additions: 1 } }));
    registerHoistedTools(api, makePluginContext(bridge), {
      hoistRead: false,
      hoistWrite: true,
      hoistEdit: false,
      hoistGrep: false,
    });

    await executeTool(tools.get("write")!, { filePath: "src/app.ts", content: "export {};\n" });

    expect(calls[0].command).toBe("write");
    expect(calls[0].params).toEqual({
      file: "src/app.ts",
      content: "export {};\n",
      diagnostics: true,
      include_diff: true,
    });
  });

  test("formatReadFooter only hints when Rust clamped an unbounded read", () => {
    expect(
      formatReadFooter(false, { truncated: true, start_line: 1, end_line: 100, total_lines: 500 }),
    ).toBe("\n(Showing lines 1-100 of 500. Use offset/limit to read other sections.)");
    expect(
      formatReadFooter(true, { truncated: true, start_line: 1, end_line: 100, total_lines: 500 }),
    ).toBe("");
    expect(formatReadFooter(false, { truncated: true })).toBe("");
  });
});
