import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./common/logger";

app.listen(env.port, "0.0.0.0", () => {
  logger.info(`API listening on port ${env.port}`);
});
