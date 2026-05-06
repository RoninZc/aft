import * as path from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { Effect } from "effect";

/**
 * Execute a `ctx.ask(...)` result, supporting BOTH the old (Promise-returning)
 * and new (Effect-returning) plugin contracts.
 *
 * Why this exists: OpenCode's plugin TypeScript types declared `ask` as
 * `Promise<void>` in v1.2.x but switched to `Effect.Effect<void>` in
 * v1.14.x (see opencode-source `packages/plugin/src/tool.ts`). When AFT
 * was built against the old typed contract and just used `await`, plain
 * `await effect` resolves silently to the Effect object **without ever
 * executing the effect** — meaning the deny/ask evaluation never ran and
 * the user's `bash: { "*": deny }` (and edit/external_directory) rules
 * were silently ignored.
 *
 * Promise duck-typing (`.then` is callable) reliably distinguishes the
 * two shapes because Effect objects in @effect/io do not implement the
 * thenable protocol. On deny, `Effect.runPromise` rejects with the
 * underlying defect (DeniedError / RejectedError); on the old contract
 * a rejected Promise has the same shape so callers can still rely on
 * `try/catch` for deny handling.
 */
export async function runAsk(maybe: unknown): Promise<void> {
  if (maybe && typeof (maybe as { then?: unknown }).then === "function") {
    // Old contract (1.2.x): Promise<void> — await directly.
    await (maybe as Promise<void>);
    return;
  }
  // New contract (1.14.x+): Effect.Effect<void> — must run via
  // Effect.runPromise for the effect to actually execute.
  await Effect.runPromise(maybe as Effect.Effect<void, unknown, never>);
}

export function resolveAbsolutePath(context: ToolContext, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(context.directory, target);
}

export function resolveRelativePattern(context: ToolContext, target: string): string {
  return path.relative(context.worktree, resolveAbsolutePath(context, target)) || ".";
}

export function resolveRelativePatterns(context: ToolContext, targets: string[]): string[] {
  const seen = new Set<string>();
  const patterns: string[] = [];

  for (const target of targets) {
    if (!target) continue;
    const pattern = resolveRelativePattern(context, target);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }

  return patterns;
}

export function workspacePattern(_context: ToolContext): string {
  return ".";
}

export async function askEditPermission(
  context: ToolContext,
  patterns: string[],
  metadata: Record<string, unknown> = {},
): Promise<string | undefined> {
  try {
    await runAsk(
      context.ask({
        permission: "edit",
        patterns: patterns.length > 0 ? patterns : [workspacePattern(context)],
        always: ["*"],
        metadata,
      }),
    );
    return undefined;
  } catch (error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "Permission denied.";
  }
}

export function permissionDeniedResponse(message: string): string {
  return JSON.stringify({
    success: false,
    code: "permission_denied",
    message,
    error: message,
  });
}
