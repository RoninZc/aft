export interface PipeStripResult {
  command: string;
  stripped: boolean;
  note?: string;
}

// Filters that only *view* or *reshape* a command's output for human reading.
// When a test/build runner is piped entirely through these, we can drop the
// pipeline and run the bare command — the output compressor reduces the full
// output while preserving failures/summaries, which these filters routinely
// strip away. Two families:
//   - viewing:   grep, rg, head, tail, cat, less, more
//   - transform: sed, awk, cut, sort, uniq, tr, column, fold
// `wc` is deliberately excluded below: it collapses output to a scalar count
// the agent explicitly asked for, so stripping it would be surprising.
const NOISE_FILTERS = new Set([
  "grep",
  "rg",
  "head",
  "tail",
  "cat",
  "less",
  "more",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
  "column",
  "fold",
]);
const GREP_GUARD_FLAGS = new Set([
  "c",
  "count",
  "q",
  "quiet",
  "o",
  "only-matching",
  "l",
  "files-with-matches",
]);

export function maybeStripCompressorPipe(
  command: string,
  compressionEnabled: boolean,
): PipeStripResult {
  if (!compressionEnabled) return { command, stripped: false };

  // Peel a leading `cmd && ... &&` prefix (e.g. `cd dir && bun test | grep`).
  // Since `&&` binds looser than `|`, `A && B | C` means `A && (B | C)`, so the
  // pipeline to strip is the LAST `&&`-segment and the earlier segments are a
  // verbatim prefix to reattach. Bail on top-level `||`/`;` (ambiguous/risky).
  const chain = splitTopLevelAndChain(command);
  if (chain === null) return { command, stripped: false };
  const prefix = chain
    .slice(0, -1)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const pipeline = chain[chain.length - 1] ?? "";

  const stages = splitTopLevelPipeline(pipeline);
  if (stages.length < 2) return { command, stripped: false };

  const firstStage = stages[0]?.trim() ?? "";
  if (!isCompressorHandledRunner(firstStage)) return { command, stripped: false };

  const filterStages = stages.slice(1).map((stage) => stage.trim());
  for (const stage of filterStages) {
    if (!isPlainNoiseFilter(stage)) return { command, stripped: false };
  }

  const filters = filterStages.join(" | ");
  const rebuilt = [...prefix, firstStage].join(" && ");
  return {
    command: rebuilt,
    stripped: true,
    note: `[AFT dropped \`| ${filters}\` (compressed:false to keep)]`,
  };
}

/**
 * Split a command into its top-level `&&`-joined segments, respecting quotes
 * and escapes. Returns `null` if the command contains a top-level `||` or `;`,
 * which make prefix-peeling ambiguous, so the caller bails. Single `&`
 * (redirects like `2>&1`, background) is left intact inside a segment.
 */
function splitTopLevelAndChain(command: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "&" && next === "&") {
      segments.push(command.slice(start, index));
      start = index + 2;
      index++;
      continue;
    }
    if (char === "|" && next === "|") return null;
    if (char === ";") return null;
  }

  segments.push(command.slice(start));
  return segments;
}

function splitTopLevelPipeline(command: string): string[] {
  const stages: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    const previous = command[index - 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "|" && previous !== "|" && next !== "|") {
      stages.push(command.slice(start, index));
      start = index + 1;
    }
  }

  stages.push(command.slice(start));
  return stages;
}

/**
 * Is the first stage a test/build/lint/typecheck runner whose full output the
 * agent actually needs (i.e. failures)? Those are the commands where a
 * downstream viewing filter silently hides failures, so stripping the filter
 * and letting the compressor reduce the bare output is strictly better.
 *
 * IMPORTANT — this list is intentionally NARROW. It must only contain commands
 * you run to learn "did it pass / build / typecheck cleanly". It must NOT
 * include log-emitting or search tools (git, docker, kubectl, ls, find, cat,
 * journalctl, …) where a downstream `| grep`/`| tail` is the agent's GENUINE
 * intent (e.g. `git log | grep fix`, `docker logs app | tail`). Stripping those
 * would change behavior and surprise the agent. When in doubt, leave it out.
 */
function isCompressorHandledRunner(stage: string): boolean {
  const tokens = tokenizeStage(stage);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => token === "&&" || token === "||" || token.includes(";"))) {
    return false;
  }

  // Basename the launcher so `./gradlew`, `./mvnw`, `node_modules/.bin/jest`,
  // and `./vendor/bin/phpunit` resolve to their tool name.
  const first = runnerName(tokens[0]);
  const second = tokens[1];
  const third = tokens[2];
  const rest = tokens.slice(1);
  if (!first) return false;

  // --- JavaScript / TypeScript ---
  if (first === "bun") return second === "test" || (second === "run" && startsWithTest(third));
  if (first === "npm" || first === "pnpm") {
    return second === "test" || (second === "run" && startsWithTest(third));
  }
  if (first === "yarn") {
    // yarn berry runs a script by name directly (`yarn test:unit`) and also
    // supports `yarn run <script>`.
    return startsWithTest(second) || (second === "run" && startsWithTest(third));
  }
  if (first === "deno") return ["test", "lint", "check", "bench"].includes(second ?? "");
  if (first === "npx") {
    return ["tsc", "eslint", "vitest", "jest", "playwright", "biome"].includes(second ?? "");
  }
  if (first === "playwright") return second === "test";

  // --- Rust ---
  if (first === "cargo") {
    return ["test", "build", "check", "clippy", "nextest"].includes(second ?? "");
  }

  // --- Go ---
  if (first === "go") return ["test", "build", "vet"].includes(second ?? "");

  // --- Java / JVM (tasks can appear anywhere: `gradle clean test`) ---
  if (first === "gradle" || first === "gradlew") {
    return hasBuildTask(rest, ["test", "check", "build", "assemble"]);
  }
  if (first === "mvn" || first === "mvnw") {
    return hasBuildTask(rest, ["test", "verify", "package", "install"]);
  }

  // --- .NET ---
  if (first === "dotnet") return ["test", "build"].includes(second ?? "");

  // --- Ruby ---
  if (first === "rspec") return true;
  if (first === "rake") return startsWithTest(second) || second === "spec";

  // --- PHP ---
  if (first === "phpunit" || first === "pest") return true;

  // --- Apple / Swift ---
  if (first === "xcodebuild") return true;
  if (first === "swift") return second === "test" || second === "build";

  // --- Make (require an explicit test/lint target — bare `make` is a generic
  //     build that may legitimately be grepped for errors) ---
  if (first === "make" || first === "gmake") {
    return hasBuildTask(rest, ["test", "check", "lint"]);
  }

  // --- Bare test / lint / typecheck runners ---
  return [
    "vitest",
    "jest",
    "pytest",
    "tsc",
    "eslint",
    "biome",
    "ruff",
    "mypy",
    "tox",
    "nox",
  ].includes(first);
}

/** Last path segment of a launcher token (`./gradlew` → `gradlew`, `jest` → `jest`). */
function runnerName(token: string | undefined): string {
  if (!token) return "";
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * Does any argument name one of the given build/test tasks? Matches the bare
 * task (`test`) and qualified Gradle forms (`:app:test`), but not substrings
 * (`my-test-module` does not match `test`).
 */
function hasBuildTask(args: string[], tasks: string[]): boolean {
  return args.some((arg) => tasks.some((task) => arg === task || arg.endsWith(`:${task}`)));
}

function startsWithTest(token: string | undefined): boolean {
  return token?.startsWith("test") === true;
}

function isPlainNoiseFilter(stage: string): boolean {
  const tokens = tokenizeStage(stage);
  const head = tokens[0];
  if (!head) return false;
  if (head === "wc") return false;
  if (!NOISE_FILTERS.has(head)) return false;
  if ((head === "grep" || head === "rg") && hasIntentChangingGrepFlag(tokens.slice(1)))
    return false;
  return true;
}

function hasIntentChangingGrepFlag(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) {
      const flag = arg.slice(2).split("=", 1)[0];
      if (GREP_GUARD_FLAGS.has(flag)) return true;
      continue;
    }
    for (const flag of arg.slice(1)) {
      if (GREP_GUARD_FLAGS.has(flag)) return true;
    }
  }
  return false;
}

function tokenizeStage(stage: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < stage.length; index++) {
    const char = stage[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
