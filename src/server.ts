import { serverConfig } from "./config.js";
import { startServer } from "./start-server.js";

try {
  const { port, stop } = await startServer(serverConfig(process.env));
  console.log(`aye-links listening on 127.0.0.1:${port}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`${signal}: draining and stopping`);
      stop().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
