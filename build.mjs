import { build } from "esbuild";
import fs from "fs-extra";

const DIST_DIR = "./dist";

const sharedBuildOptions = {
	outdir: DIST_DIR,
	bundle: true,
	platform: "node",
};

const buildCLIMain = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/index.ts"],
		format: "cjs",
	});
};

// remove outputs of the last build
fs.rmSync(DIST_DIR, { force: true, recursive: true });

Promise.all([buildCLIMain()]).catch((e) => {
	console.error(`failed to build: ${e}`);
	process.exit(1);
});
