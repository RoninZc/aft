import type { ToolDefinition } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { PluginContext } from "../types.js";
import { callBridge, optionalInt } from "./_shared.js";
import { askGrepPermission, permissionDeniedResponse } from "./permissions.js";

const z = tool.schema;

type ToolArg = ToolDefinition["args"][string];

function arg(schema: unknown): ToolArg {
  return schema as ToolArg;
}

export function semanticTools(ctx: PluginContext): Record<string, ToolDefinition> {
  const searchTool: ToolDefinition = {
    description: [
      "Find code with unified semantic, lexical, literal, and regex search. Returns ranked symbol/file results or exact matching lines, with routing metadata.",
      "",
      "When to reach for it:",
      "- Exploring an unfamiliar area: 'where is rate limiting handled', 'how does auth flow work'",
      "- Concept doesn't appear as a literal string: 'retry logic', 'cache invalidation', 'graceful shutdown'",
      "- Filename-shaped concepts: 'the bridge spawn helper', 'the session detection module'",
      "- Regex-shaped or exact text queries when you want AFT to classify and route automatically",
      "- You know roughly what the function does but not what it's named",
      "",
      "When NOT to use:",
      "- You need exhaustive literal enumeration → use grep directly",
      "- You want the file/module structure → use aft_outline",
      "- You're following a call chain → use aft_navigate",
      "",
      "Set hint to 'regex', 'literal', 'semantic', or 'auto' to override or document routing intent.",
    ].join("\n"),
    args: {
      query: arg(
        z
          .string()
          .describe(
            "Concept, regex, literal text, filename, or capability to find. Examples: 'fuzzy match with whitespace tolerance', '^export', 'Cargo.lock'.",
          ),
      ),
      topK: arg(optionalInt(1, 100).describe("Number of results (default: 10, max: 100)")),
      hint: arg(
        z
          .enum(["regex", "literal", "semantic", "auto"])
          .optional()
          .describe("Optional routing hint. Defaults to 'auto'."),
      ),
    },
    execute: async (args, context): Promise<string> => {
      if (typeof args.query !== "string" || args.query.length === 0) {
        throw new Error("semantic_search: invalid params: missing field `query`");
      }
      const query = args.query;
      const hint = typeof args.hint === "string" ? args.hint : undefined;

      // Match grep permission behavior for every mode that might inspect file contents.
      // This intentionally over-asks for auto/NL queries but never under-asks for regex/literal.
      if (hint !== "semantic") {
        const denied = await askGrepPermission(context, query);
        if (denied) return permissionDeniedResponse(denied);
      }

      const bridgeParams: Record<string, unknown> = {
        query,
        top_k: args.topK ?? 10,
      };
      if (hint) bridgeParams.hint = hint;
      const response = await callBridge(ctx, context, "semantic_search", bridgeParams);

      if (response.success === false) {
        if (
          response.code === "semantic_search_unavailable" &&
          typeof response.message === "string"
        ) {
          return response.message;
        }

        throw new Error((response.message as string) || "semantic_search failed");
      }

      if (typeof response.text === "string") {
        return response.text;
      }

      return JSON.stringify(response);
    },
  };

  return {
    aft_search: searchTool,
  };
}
