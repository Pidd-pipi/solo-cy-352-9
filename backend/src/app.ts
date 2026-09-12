import cors from "cors";
import express from "express";
import helmet from "helmet";
import { overviewRouter } from "./modules/overview/overview.routes";
import { buildOperationsRouter } from "./modules/operations/operations.routes";
import { errorHandler } from "./modules/operations/operations.controller";
import { OperationsService } from "./modules/operations/operations.service";
import type { Storage } from "./db/types";

export function createApp(storage: Storage, storageMode: "mongodb" | "file" = "mongodb") {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_request, response) =>
    response.json({ status: "ok", storage: storageMode }),
  );
  app.get("/api/health", (_request, response) =>
    response.json({ status: "ok", storage: storageMode }),
  );

  const operationsService = new OperationsService(storage);
  const operationsRouter = buildOperationsRouter(operationsService);

  app.use("/", overviewRouter);
  app.use("/api", overviewRouter);
  // Nginx 与 Vite 代理均把 /api 前缀剥离后转发到根路径，故运营路由两处都挂载
  app.use("/", operationsRouter);
  app.use("/api", operationsRouter);

  app.use(errorHandler);

  return app;
}
