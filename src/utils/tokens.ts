import { getEncoding } from "js-tiktoken";

let _encoder: ReturnType<typeof getEncoding> | null = null;

function getEncoder(): ReturnType<typeof getEncoding> {
  if (!_encoder) {
    _encoder = getEncoding("cl100k_base");
  }
  return _encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function isOverBudget(tokens: number, budget: number): boolean {
  return tokens > budget;
}

export function splitByTokenBudget(text: string, budget: number): { head: string; tail: string } {
  if (countTokens(text) <= budget) {
    return { head: text, tail: "" };
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (countTokens(text.slice(0, mid)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return {
    head: text.slice(0, low),
    tail: text.slice(low),
  };
}
