/// <reference path="../bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import { optionalInt } from "../tools/_shared.js";

describe("optionalInt", () => {
  test("coerces empty sentinels to undefined and accepts integer strings", () => {
    const schema = optionalInt(1, 100);

    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse(null)).toBeUndefined();
    expect(schema.parse("")).toBeUndefined();
    expect(schema.parse(0)).toBeUndefined();
    expect(schema.parse(Number.NaN)).toBeUndefined();
    expect(schema.parse("24")).toBe(24);
    expect(schema.parse(24)).toBe(24);
  });

  test("rejects invalid integers with a bounded message", () => {
    const schema = optionalInt(1, 100);

    expect(() => schema.parse(999)).toThrow("must be between 1 and 100");
    expect(() => schema.parse("abc")).toThrow("must be an integer between 1 and 100");
  });
});
