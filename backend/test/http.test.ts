import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { MemoryStorage } from "./memory-storage";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";

let server: Server;
let baseUrl: string;

before(async () => {
  const storage = new MemoryStorage().withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const app = createApp(storage, "file");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(() => {
  server.close();
});

test("GET /health 暴露存储模式", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; storage: string };
  assert.equal(body.status, "ok");
  assert.equal(body.storage, "file");
});

test("GET /rooms 返回带容量、设施、维护状态的包厢", async () => {
  const res = await fetch(`${baseUrl}/rooms`);
  const rooms = (await res.json()) as Array<{
    name: string;
    capacity: number;
    facilities: string[];
    underMaintenance: boolean;
  }>;
  assert.equal(rooms.length, 4);
  const scriptRoom = rooms.find((room) => room.name === "剧本推理厅");
  assert.equal(scriptRoom?.capacity, 6);
  assert.equal(scriptRoom?.underMaintenance, true);
  assert.ok((scriptRoom?.facilities ?? []).includes("古风布景"));
});

test("预约全流程：下单扣款 -> 重叠/维护/余额不足被拒 -> 取消回退", async () => {
  // 成功下单（gold 8 折 2 小时策略厅，96 元）
  const created = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-strategy",
      memberId: "seed-member-alice",
      startTime: "2026-11-01T10:00:00+08:00",
      endTime: "2026-11-01T12:00:00+08:00",
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    booking: { id: string; chargedAmount: number };
    member: { balance: number; points: number };
  };
  assert.equal(createdBody.booking.chargedAmount, 96);
  assert.equal(createdBody.member.balance, 404);

  // 时间重叠 -> 409 TIME_CONFLICT
  const conflict = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-strategy",
      memberId: "seed-member-bob",
      startTime: "2026-11-01T11:00:00+08:00",
      endTime: "2026-11-01T13:00:00+08:00",
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "TIME_CONFLICT");

  // 维护中 -> 409 ROOM_IN_MAINTENANCE
  const maintenance = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-script",
      memberId: "seed-member-alice",
      startTime: "2026-11-02T10:00:00+08:00",
      endTime: "2026-11-02T11:00:00+08:00",
    }),
  });
  assert.equal(maintenance.status, 409);
  assert.equal((await maintenance.json()).error, "ROOM_IN_MAINTENANCE");

  // 余额不足（苏晴余额 30，策略厅 2h bronze 价 120）-> 402
  const poor = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-strategy",
      memberId: "seed-member-carol",
      startTime: "2026-11-03T10:00:00+08:00",
      endTime: "2026-11-03T12:00:00+08:00",
    }),
  });
  assert.equal(poor.status, 402);
  assert.equal((await poor.json()).error, "INSUFFICIENT_BALANCE");

  // 充值后再下单成功
  const recharge = await fetch(`${baseUrl}/members/seed-member-carol/recharge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: 200 }),
  });
  assert.equal(recharge.status, 200);
  const rechargedMember = (await recharge.json()) as { balance: number; level: string };
  assert.equal(rechargedMember.balance, 230);
  assert.equal(rechargedMember.level, "bronze"); // 累计 300 仍是青铜

  const retry = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-strategy",
      memberId: "seed-member-carol",
      startTime: "2026-11-03T10:00:00+08:00",
      endTime: "2026-11-03T12:00:00+08:00",
    }),
  });
  assert.equal(retry.status, 201);

  // 取消 -> 余额积分回退
  const cancel = await fetch(`${baseUrl}/bookings/${createdBody.booking.id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancel.status, 200);
  const cancelledBody = (await cancel.json()) as {
    booking: { status: string };
    member: { balance: number; points: number };
  };
  assert.equal(cancelledBody.booking.status, "cancelled");
  assert.equal(cancelledBody.member.balance, 500);
  assert.equal(cancelledBody.member.points, 320);

  // 重复取消 -> 409
  const cancelAgain = await fetch(`${baseUrl}/bookings/${createdBody.booking.id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelAgain.status, 409);
});

test("非法参数返回 400，未知资源返回 404", async () => {
  const badAmount = await fetch(`${baseUrl}/members/seed-member-alice/recharge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: -1 }),
  });
  assert.equal(badAmount.status, 400);

  const badTime = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "seed-room-strategy",
      memberId: "seed-member-alice",
      startTime: "2026-11-05T12:00:00+08:00",
      endTime: "2026-11-05T11:00:00+08:00",
    }),
  });
  assert.equal(badTime.status, 400);

  const missingRoom = await fetch(`${baseUrl}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "nope",
      memberId: "seed-member-alice",
      startTime: "2026-11-05T10:00:00+08:00",
      endTime: "2026-11-05T11:00:00+08:00",
    }),
  });
  assert.equal(missingRoom.status, 404);
});
