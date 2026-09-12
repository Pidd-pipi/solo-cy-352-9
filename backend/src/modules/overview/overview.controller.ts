import type { Request, Response } from "express";
import { OverviewService } from "./overview.service";

const service = new OverviewService();

export function getOverview(_request: Request, response: Response) {
  response.json(service.getOverview());
}
