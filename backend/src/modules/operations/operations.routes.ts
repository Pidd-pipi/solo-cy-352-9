import { Router } from "express";
import type { OperationsService } from "./operations.service";
import { OperationsController } from "./operations.controller";

export function buildOperationsRouter(service: OperationsService): Router {
  const router = Router();
  const controller = new OperationsController(service);

  // 包厢
  router.get("/rooms", controller.listRooms);
  router.patch("/rooms/:id/maintenance", controller.setMaintenance);

  // 会员储值
  router.get("/members", controller.listMembers);
  router.post("/members/:id/recharge", controller.recharge);
  // 下单前试算折扣价（不扣款）
  router.post("/bookings/quote", controller.quote);

  // 包厢时段预约
  router.get("/bookings", controller.listBookings);
  router.post("/bookings", controller.createBooking);
  router.post("/bookings/:id/cancel", controller.cancelBooking);

  return router;
}
