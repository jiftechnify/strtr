import { jack } from "jackspeak";
import { launchRelay } from "./index";

export const main = () => {
  const j = jack({ envPrefix: "STRTR" })
    .opt({
      host: { description: "host to listen to", default: "127.0.0.1", short: "h" },
    })
    .num({
      port: { description: "port to listen to", default: 5454, short: "p", hint: "port" },
    })
    .flag({
      help: { description: "show help", default: false },
    });

  const args = j.parse(process.argv);
  if (args.values.help) {
    console.log(j.usage());
    return;
  }

  const shutdown = launchRelay(args.values);

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};
