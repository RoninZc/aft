import { describe, expect, test } from "bun:test";
import { maybeStripCompressorPipe } from "../pipe-strip.js";

describe("maybeStripCompressorPipe", () => {
  test("strips bun test piped through grep", () => {
    const result = maybeStripCompressorPipe("bun test | grep fail", true);
    expect(result).toEqual({
      command: "bun test",
      stripped: true,
      note: "[AFT dropped `| grep fail` (compressed:false to keep)]",
    });
  });

  test("strips multi-filter cargo test pipeline", () => {
    const result = maybeStripCompressorPipe("cargo test | grep -A3 FAILED | head", true);
    expect(result.command).toBe("cargo test");
    expect(result.stripped).toBe(true);
    expect(result.note).toContain("| grep -A3 FAILED | head");
  });

  test("does not strip when compression is disabled", () => {
    expect(maybeStripCompressorPipe("bun test | grep fail", false)).toEqual({
      command: "bun test | grep fail",
      stripped: false,
    });
  });

  test("does not strip count grep", () => {
    expect(maybeStripCompressorPipe("bun test | grep -c fail", true)).toEqual({
      command: "bun test | grep -c fail",
      stripped: false,
    });
  });

  test("does not strip when first stage is not a runner", () => {
    expect(maybeStripCompressorPipe("ls | grep foo", true)).toEqual({
      command: "ls | grep foo",
      stripped: false,
    });
  });

  test("strips text-transform filters (sed/awk/cut/sort/uniq/tr)", () => {
    // These reshape output for human reading and routinely hide test
    // failures/summaries — strip them so the bare runner output reaches the
    // compressor (which preserves failures). Previously only viewing filters
    // (grep/head/tail/...) were recognized, so one `sed` made pipe-strip bail
    // on the whole pipeline, leaking the failure-hiding `grep`.
    expect(maybeStripCompressorPipe("bun test | sed 's/x/y/'", true).command).toBe("bun test");
    expect(maybeStripCompressorPipe("cargo test | awk '{print $1}'", true).command).toBe(
      "cargo test",
    );
    expect(maybeStripCompressorPipe("npm test | sort | uniq", true).command).toBe("npm test");
  });

  test("strips a mixed view+transform chain — the real 'bun test | grep | sed | head' footgun", () => {
    // The exact shape that slipped through before: an unrecognized transform
    // stage in the middle of a chain made the whole pipeline non-strippable,
    // so the leading `grep` survived and hid the failures.
    const result = maybeStripCompressorPipe(
      'bun test 2>&1 | grep -E "fail" | sed -E "s/ ms//" | head -20',
      true,
    );
    expect(result.stripped).toBe(true);
    expect(result.command).toBe("bun test 2>&1");
    expect(result.note).toContain("| grep");
    expect(result.note).toContain("| sed");
    expect(result.note).toContain("| head");
  });

  test("still does not strip wc (collapses to a count the agent asked for)", () => {
    expect(maybeStripCompressorPipe("bun test | wc -l", true).stripped).toBe(false);
  });

  test("does not split on pipes inside quotes", () => {
    expect(maybeStripCompressorPipe('bun test --name "a|b"', true)).toEqual({
      command: 'bun test --name "a|b"',
      stripped: false,
    });
  });

  test("strips known runner forms", () => {
    expect(maybeStripCompressorPipe("npm run test:unit | tail -20", true).command).toBe(
      "npm run test:unit",
    );
    expect(maybeStripCompressorPipe("npx eslint src | head", true).command).toBe("npx eslint src");
  });

  test("peels a leading cd && prefix and strips the pipeline (#102 dogfood)", () => {
    // `cd dir && bun test | grep fail` is `cd dir && (bun test | grep fail)`
    // because `&&` binds looser than `|`. The prefix is reattached verbatim.
    const result = maybeStripCompressorPipe("cd packages/a && bun test | grep fail", true);
    expect(result.stripped).toBe(true);
    expect(result.command).toBe("cd packages/a && bun test");
    expect(result.note).toContain("| grep fail");
  });

  test("peels a multi-segment && prefix", () => {
    const result = maybeStripCompressorPipe(
      "cd packages/a && export CI=1 && cargo test | grep -A2 FAILED",
      true,
    );
    expect(result.stripped).toBe(true);
    expect(result.command).toBe("cd packages/a && export CI=1 && cargo test");
    expect(result.note).toContain("| grep -A2 FAILED");
  });

  test("does not strip when the &&-prefixed command is not a runner", () => {
    expect(maybeStripCompressorPipe("cd packages/a && ls | grep foo", true).stripped).toBe(false);
  });

  test("bails on top-level semicolon or || in the chain", () => {
    expect(maybeStripCompressorPipe("cd a; bun test | grep fail", true).stripped).toBe(false);
    expect(maybeStripCompressorPipe("cd a || exit && bun test | grep fail", true).stripped).toBe(
      false,
    );
  });

  test("does not strip wc or intent-changing grep flags", () => {
    expect(maybeStripCompressorPipe("bun test | wc -l", true).stripped).toBe(false);
    expect(maybeStripCompressorPipe("bun test | rg --quiet fail", true).stripped).toBe(false);
    expect(maybeStripCompressorPipe("bun test | grep -n fail", true).stripped).toBe(true);
  });

  test("does not treat || as a pipe", () => {
    expect(maybeStripCompressorPipe("bun test || true | grep fail", true).stripped).toBe(false);
  });

  test("strips test/build runners across ecosystems (JS/Rust/Go/JVM/.NET/Ruby/PHP/Swift/Deno)", () => {
    const runners = [
      "yarn test:unit | grep FAIL",
      "deno test | grep fail",
      "gradle test | grep FAILED",
      "./gradlew clean test | tail -20",
      "mvn verify | grep ERROR",
      "./mvnw test | head",
      "dotnet test | grep Failed",
      "rspec | grep fail",
      "rake test | tail",
      "phpunit | tail",
      "./vendor/bin/phpunit | grep FAIL",
      "swift test | grep fail",
      "xcodebuild test | tail -5",
      "make test | grep Error",
      "tox | tail",
      "node_modules/.bin/jest | grep fail",
    ];
    for (const cmd of runners) {
      expect(maybeStripCompressorPipe(cmd, true).stripped).toBe(true);
    }
  });

  test("does NOT strip log/search tools where the downstream filter is the intent", () => {
    // These are the false-positive guard: stripping them would change behavior.
    const keep = [
      "git log | grep fix",
      "docker logs app | tail -100",
      "kubectl logs pod | grep error",
      "make | grep error", // bare make = generic build, no test/lint target
      "cat app.log | grep ERROR",
      "journalctl -u svc | tail",
    ];
    for (const cmd of keep) {
      expect(maybeStripCompressorPipe(cmd, true).stripped).toBe(false);
    }
  });
});
