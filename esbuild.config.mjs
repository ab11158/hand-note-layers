import esbuild from "esbuild";
import process from "process";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";

const workerDataUrlPlugin = {
  name: "pdf-worker-data-url",
  setup(build) {
    build.onResolve(
      { filter: /pdf\.worker\.min\.mjs\?worker-dataurl$/ },
      () => ({
        path: resolve(
          process.cwd(),
          "node_modules",
          "pdfjs-dist",
          "build",
          "pdf.worker.min.mjs"
        ),
        namespace: "pdf-worker-data-url"
      })
    );

    build.onLoad(
      { filter: /.*/, namespace: "pdf-worker-data-url" },
      async (args) => {
        const workerSource = await readFile(args.path);
        const dataUrl = `data:application/javascript;base64,${workerSource.toString("base64")}`;
        return {
          contents: `export default ${JSON.stringify(dataUrl)};`,
          loader: "js"
        };
      }
    );
  }
};

const production = process.argv[2] === "production";
const builtins = builtinModules
  .filter(
    (moduleName) =>
      !moduleName.startsWith("_") &&
      !moduleName.includes("/") &&
      moduleName !== "sys"
  )
  .sort();

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  loader: {
    ".mjs": "js"
  },
  plugins: [workerDataUrlPlugin]
}).catch(() => process.exit(1));
