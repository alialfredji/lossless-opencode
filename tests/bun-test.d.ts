declare module "bun:test" {
  export const describe: typeof globalThis.describe;
  export const it: typeof globalThis.it;
  export const expect: typeof globalThis.expect;
}
