import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./common/logger";
import { connectStorage } from "./db";
import { OperationsService } from "./modules/operations/operations.service";

async function main() {
  const { storage, mode, close } = await connectStorage();

  // 启动即对账：修复上次进程在存储故障/崩溃中遗留的中间态预约
  await new OperationsService(storage).reconcileAll();

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
