// Bundle the CLI and the GitHub Action into self-contained files in dist/.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "linked",
  // Some CommonJS dependencies call require(); give ESM bundles a working one.
  banner: {
    js: [
      "import { createRequire as __bsCreateRequire } from 'node:module';",
      "import { fileURLToPath as __bsFileURLToPath } from 'node:url';",
      "import { dirname as __bsDirname } from 'node:path';",
      "const require = __bsCreateRequire(import.meta.url);",
      "const __filename = __bsFileURLToPath(import.meta.url);",
      "const __dirname = __bsDirname(__filename);",
    ].join(" "),
  },
  logLevel: "info",
};
await build({ ...common, entryPoints: ["src/action-entry.ts"], outfile: "dist/action.js" });
await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  // Only used from source to bundle the dashboard client on the fly; dist ships it prebuilt.
  external: ["esbuild"],
  banner: common.banner,
});

// The dashboard's browser code (served by `bumpsmith dashboard`).
await build({
  entryPoints: ["src/dashboard/client/app.ts"],
  outfile: "dist/dashboard-app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "info",
});
