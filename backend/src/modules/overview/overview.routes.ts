import { Router } from "express";
import { getOverview } from "./overview.controller";

export const overviewRouter = Router();

overviewRouter.get("/overview", getOverview);
