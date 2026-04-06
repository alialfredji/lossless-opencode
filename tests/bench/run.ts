import { runAllBenchmarks, type BenchResult } from "./performance";

function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  if (align === "right") {
    return str.padStart(width);
  }
  return str.padEnd(width);
}

function formatNum(n: number): string {
  return n.toFixed(3);
}

function printTable(results: BenchResult[]): void {
  const colWidths = {
    name: Math.max(12, ...results.map((r) => r.name.length)) + 2,
    min: 10,
    max: 10,
    avg: 10,
    p95: 10,
    unit: 6,
  };

  const border = {
    tl: "┌",
    tr: "┐",
    bl: "└",
    br: "┘",
    h: "─",
    v: "│",
    tm: "┬",
    bm: "┴",
    ml: "├",
    mr: "┤",
    mm: "┼",
  };

  function hLine(left: string, mid: string, right: string): string {
    return (
      left +
      border.h.repeat(colWidths.name + 2) +
      mid +
      border.h.repeat(colWidths.min + 2) +
      mid +
      border.h.repeat(colWidths.max + 2) +
      mid +
      border.h.repeat(colWidths.avg + 2) +
      mid +
      border.h.repeat(colWidths.p95 + 2) +
      mid +
      border.h.repeat(colWidths.unit + 2) +
      right
    );
  }

  function row(name: string, min: string, max: string, avg: string, p95: string, unit: string): string {
    return (
      border.v +
      " " + pad(name, colWidths.name) + " " +
      border.v +
      " " + pad(min, colWidths.min, "right") + " " +
      border.v +
      " " + pad(max, colWidths.max, "right") + " " +
      border.v +
      " " + pad(avg, colWidths.avg, "right") + " " +
      border.v +
      " " + pad(p95, colWidths.p95, "right") + " " +
      border.v +
      " " + pad(unit, colWidths.unit) + " " +
      border.v
    );
  }

  console.log(hLine(border.tl, border.tm, border.tr));
  console.log(row("Benchmark", "Min", "Max", "Avg", "P95", "Unit"));
  console.log(hLine(border.ml, border.mm, border.mr));

  for (const r of results) {
    console.log(row(r.name, formatNum(r.min), formatNum(r.max), formatNum(r.avg), formatNum(r.p95), r.unit));
  }

  console.log(hLine(border.bl, border.bm, border.br));
}

const startTime = performance.now();
const results = await runAllBenchmarks();
const totalMs = performance.now() - startTime;

console.log();
printTable(results);
console.log();
console.log(`Total runtime: ${(totalMs / 1000).toFixed(2)}s`);
