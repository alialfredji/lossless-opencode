import { describe, expect, it } from "bun:test";
import { countTokens, estimateTokens, isOverBudget, splitByTokenBudget } from "../../src/utils/tokens";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns reasonable count for 'Hello, world!'", () => {
    const count = countTokens("Hello, world!");
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(6);
  });

  it("returns higher count for longer text", () => {
    expect(countTokens("hello")).toBeLessThan(countTokens("hello hello hello hello"));
  });

  it("uses singleton encoder (calling twice returns same result)", () => {
    const first = countTokens("singleton check");
    const second = countTokens("singleton check");
    expect(first).toBe(second);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is within 30% of countTokens for typical text", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const exact = countTokens(text);
    const estimate = estimateTokens(text);
    const diff = Math.abs(exact - estimate) / exact;
    expect(diff).toBeLessThan(0.3);
  });
});

describe("isOverBudget", () => {
  it("returns false when under budget", () => {
    expect(isOverBudget(5, 10)).toBe(false);
  });

  it("returns false when exactly at budget", () => {
    expect(isOverBudget(10, 10)).toBe(false);
  });

  it("returns true when over budget", () => {
    expect(isOverBudget(11, 10)).toBe(true);
  });
});

describe("splitByTokenBudget", () => {
  it("returns full text as head when within budget", () => {
    const text = "short text";
    const result = splitByTokenBudget(text, 100);
    expect(result.head).toBe(text);
    expect(result.tail).toBe("");
  });

  it("returns empty tail when within budget", () => {
    const result = splitByTokenBudget("just enough", 100);
    expect(result.tail).toBe("");
  });

  it("head stays within budget", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const { head, tail } = splitByTokenBudget(text, 50);
    expect(countTokens(head)).toBeLessThanOrEqual(50);
    expect(tail.length).toBeGreaterThan(0);
  });

  it("head + tail reconstructs original text", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const { head, tail } = splitByTokenBudget(text, 10);
    expect(head + tail).toBe(text);
  });

  it("handles empty string", () => {
    expect(splitByTokenBudget("", 10)).toEqual({ head: "", tail: "" });
  });
});
