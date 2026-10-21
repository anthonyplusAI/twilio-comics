// sharp@0.35 ships its declarations but omits a `types` condition from its
// package exports. Point TypeScript at the package's own declarations without
// changing the runtime import used by Next.js and Node.
declare module "sharp" {
  const sharp: typeof import("../node_modules/sharp/lib/index");
  export = sharp;
}
