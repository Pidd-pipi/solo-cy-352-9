import cors from "cors";
import express from "express";
import helmet from "helmet";
import { overviewRouter } from "./modules/overview/overview.routes";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.use("/", overviewRouter);
app.use("/api", overviewRouter);
