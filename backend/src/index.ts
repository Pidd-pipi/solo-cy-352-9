import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./common/logger";
import { connectStorage } from "./db";

async function main() {
  const { storage, mode, close } = await connectStorage();
  const app = createApp(storage, mode);

  const server = app.listen(env.port, "0.0.0.0", () => {
    logger.info(`API listening on port ${env.port} (storage: ${mode})`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error(`Failed to start: ${(error as Error).message}`);
  process.exit(1);
});
