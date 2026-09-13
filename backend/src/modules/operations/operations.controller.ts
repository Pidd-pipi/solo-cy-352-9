import type { NextFunction, Request, Response } from "express";
import { OperationsService, BusinessError } from "./operations.service";

export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  private static param(request: Request, name: string): string {
    const value = request.params[name];
    return Array.isArray(value) ? value[0] : value;
  }

  listRooms = async (_request: Request, response: Response) => {
    response.json(await this.service.listRooms());
  };

  setMaintenance = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const underMaintenance = Boolean(request.body?.underMaintenance);
      response.json(await this.service.setMaintenance(OperationsController.param(request, "id"), underMaintenance));
    } catch (error) {
      next(error);
    }
  };

  listMembers = async (_request: Request, response: Response) => {
    response.json(await this.service.listMembers());
  };

  recharge = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const amount = Number(request.body?.amount);
      response.json(await this.service.recharge(OperationsController.param(request, "id"), amount));
    } catch (error) {
      next(error);
    }
  };

  quote = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { roomId, memberId, startTime, endTime } = request.body ?? {};
      response.json(await this.service.quote(roomId, memberId, startTime, endTime));
    } catch (error) {
      next(error);
    }
  };

  listBookings = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const includeCancelled = request.query.all === "true";
      response.json(await this.service.listBookings(includeCancelled));
    } catch (error) {
      next(error);
    }
  };

  createBooking = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { roomId, memberId, startTime, endTime, requestId } = request.body ?? {};
      // 允许通过 Idempotency-Key 头传幂等键，重试同一请求不会重复扣款
      const idempotencyKey =
        (typeof requestId === "string" && requestId) ||
        (request.headers["idempotency-key"] as string | undefined);
      const result = await this.service.createBooking({
        roomId,
        memberId,
        startTime,
        endTime,
        requestId: idempotencyKey,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  };

  cancelBooking = async (request: Request, response: Response, next: NextFunction) => {
    try {
      response.json(await this.service.cancelBooking(OperationsController.param(request, "id")));
    } catch (error) {
      next(error);
    }
  };
}

/** Express 错误处理中间件：业务错误返回结构化 JSON，未知错误返回 500。 */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof BusinessError) {
    response.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }
  const message = error instanceof Error ? error.message : "Internal Server Error";
  response.status(500).json({ error: "INTERNAL_ERROR", message });
}
