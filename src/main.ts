import { launchRelay } from "./index";

export const main = () => {
	const shutdown = launchRelay();

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
};
