import cp from "node:child_process";
import { build } from "esbuild";
import { esbuildPluginFilePathExtensions } from "esbuild-plugin-file-path-extensions";
import fs from "fs-extra";

const DIST_DIR = "./dist";
const BUILD_TS_CONFIG_PATH = "./tsconfig.build.json";

const sharedBuildOptions = {
	outdir: DIST_DIR,
	bundle: true,
	platform: "node",
};

const buildRelayCJS = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/relay.ts"],
		format: "cjs",
		outExtension: { ".js": ".cjs" },
		external: ["ws", "nostr-tools", "heap-js"],
	});
};

const buildIndexCJS = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/index.ts"],
		format: "cjs",
		outExtension: { ".js": ".cjs" },
		external: ["./relay"],
		plugins: [esbuildPluginFilePathExtensions()],
	});
};

const buildRelayESM = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/relay.ts"],
		format: "esm",
		outExtension: { ".js": ".mjs" },
		external: ["ws", "nostr-tools", "heap-js"],
	});
};

const buildIndexESM = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/index.ts"],
		format: "esm",
		outExtension: { ".js": ".mjs" },
		external: ["./relay"],
		plugins: [esbuildPluginFilePathExtensions({ esm: true })],
	});
};

const buildCLIMain = async () => {
	build({
		...sharedBuildOptions,
		entryPoints: ["src/main.ts"],
		format: "cjs",
		external: ["./index", "jackspeak"],
		plugins: [esbuildPluginFilePathExtensions({ filter: /^\.\// })],
	});
};

/** @type { () => Promise<void> } */
const buildTypes = async () =>
	new Promise((resolve, reject) => {
		const proc = cp.spawn("npx", ["tsc", "-p", BUILD_TS_CONFIG_PATH, "--declarationDir", DIST_DIR], {
			stdio: "inherit",
		});
		proc.on("exit", (code) => {
			if (code != null && code !== 0) {
				reject(Error(`tsc exited with code ${code}`));
			} else {
				resolve();
			}
		});
	});

// remove outputs of the last build
fs.rmSync(DIST_DIR, { force: true, recursive: true });

Promise.all([buildRelayCJS(), buildRelayESM(), buildIndexCJS(), buildIndexESM(), buildCLIMain(), buildTypes()]).catch(
	(e) => {
		console.error(`failed to build: ${e}`);
		process.exit(1);
	},
);
