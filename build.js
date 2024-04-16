import { build } from "esbuild";
import fs from "fs-extra";

const DIST_DIR = "./dist";
const BUILD_TS_CONFIG_PATH = "./tsconfig.build.json";

const sharedBuildOptions = {
  outdir: DIST_DIR,
  bundle: true,
  platform: "node",
};

const buildCLIMain = async () => {
  build({
    ...sharedBuildOptions,
    entryPoints: ["src/index.ts"],
    format: "esm",
  });
};

// remove outputs of the last build
fs.rmSync(DIST_DIR, { force: true, recursive: true });

Promise.all([buildCLIMain()]).catch(
  (e) => {
    console.error(`failed to build: ${e}`);
    process.exit(1);
  }
);
