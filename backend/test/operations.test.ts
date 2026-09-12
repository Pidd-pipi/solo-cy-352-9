import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./memory-storage";
import { BusinessError, OperationsService } from "../src/modules/operations/operations.service";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";

function setup() {
  const storage = new MemoryStorage().withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  return { storage, service: new OperationsService(storage) };
}

function expectError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessError, `expected BusinessError, got ${String(error)}`);
    assert.equal((error as BusinessError).code, code);
    return true;
  };
}

test("包厢按等级折扣计费，积分按实付金额累积", async () => {
  const { service, storage } = setup();

  // 林小鹿 gold 8 折：策略厅 60/h × 2h = 120，折后 96，得 96 积分
  const { booking, member } = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    startTime: "2026-10-01T10:00:00+08:00",
    endTime: "2026-10-01T12:00:00+08:00",
  });

  assert.equal(booking.baseAmount, 120);
  assert.equal(booking.chargedAmount, 96);
  assert.equal(booking.pointsEarned, 96);
  assert.equal(member.balance, 500 - 96);
  assert.equal(member.points, 320 + 96);

  // 周大锤 silver 9 折：60 × 1.5h(半小时向上取整) = 90，折后 81
  const second = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-bob",
    startTime: "2026-10-01T13:00:00+08:00",
    endTime: "2026-10-01T14:20:00+08:00",
  });
  assert.equal(second.booking.baseAmount, 90);
  assert.equal(second.booking.chargedAmount, 81);
  assert.equal(second.member.balance, 120 - 81);
  assert.equal(storage.bookings.length, 2);
});

test("同一包厢时间重叠拒绝预约，首尾相接允许", async () => {
  const { service } = setup();

  await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    startTime: "2026-10-02T10:00:00+08:00",
    endTime: "2026-10-02T12:00:00+08:00",
  });

  await assert.rejects(
    service.createBooking({
      roomId: "seed-room-strategy",
      memberId: "seed-member-bob",
      startTime: "2026-10-02T11:00:00+08:00",
      endTime: "2026-10-02T13:00:00+08:00",
    }),
    expectError("TIME_CONFLICT"),
  );

  // 不同包厢同一时段允许
  const otherRoom = await service.createBooking({
    roomId: "seed-room-party",
    memberId: "seed-member-bob",
    startTime: "2026-10-02T11:00:00+08:00",
    endTime: "2026-10-02T12:00:00+08:00",
  });
  assert.equal(otherRoom.booking.roomId, "seed-room-party");

  // 首尾相接（12:00 开场）允许（用林小鹿：她订完 10-12 点后余额 404 仍充足）
  const backToBack = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    startTime: "2026-10-02T12:00:00+08:00",
    endTime: "2026-10-02T13:00:00+08:00",
  });
  assert.equal(backToBack.booking.status, "booked");
});

test("维护中的包厢拒绝预约，解除维护后可预约", async () => {
  const { service, storage } = setup();

  await assert.rejects(
    service.createBooking({
      roomId: "seed-room-script",
      memberId: "seed-member-alice",
      startTime: "2026-10-03T10:00:00+08:00",
      endTime: "2026-10-03T11:00:00+08:00",
    }),
    expectError("ROOM_IN_MAINTENANCE"),
  );

  await service.setMaintenance("seed-room-script", false);
  const result = await service.createBooking({
    roomId: "seed-room-script",
    memberId: "seed-member-alice",
    startTime: "2026-10-03T10:00:00+08:00",
    endTime: "2026-10-03T11:00:00+08:00",
  });
  assert.equal(result.booking.roomName, "剧本推理厅");
  assert.equal(storage.bookings.length, 1);
});

test("余额不足拒绝预约且不产生预约、不扣款", async () => {
  const { service, storage } = setup();

  // 苏晴 bronze 余额 30：剧本厅 120/h 即使不维护也不够；这里用可预约的策略厅 2h = 120
  await assert.rejects(
    service.createBooking({
      roomId: "seed-room-strategy",
      memberId: "seed-member-carol",
      startTime: "2026-10-04T10:00:00+08:00",
      endTime: "2026-10-04T12:00:00+08:00",
    }),
    expectError("INSUFFICIENT_BALANCE"),
  );

  const carol = await service.listMembers().then((members) =>
    members.find((member) => member.id === "seed-member-carol"),
  );
  assert.equal(carol?.balance, 30);
  assert.equal(carol?.points, 12);
  assert.equal(storage.bookings.length, 0);
});

test("充值增加余额并按累计充值自动升级", async () => {
  const { service } = setup();

  // 苏晴累计充值 100，再充 500 -> 累计 600，升 silver
  const silver = await service.recharge("seed-member-carol", 500);
  assert.equal(silver.level, "silver");
  assert.equal(silver.balance, 530);
  assert.equal(silver.totalRecharge, 600);

  // 再充 1500 -> 累计 2100，升 gold
  const gold = await service.recharge("seed-member-carol", 1500);
  assert.equal(gold.level, "gold");
  assert.equal(gold.balance, 2030);

  await assert.rejects(service.recharge("seed-member-carol", 0), expectError("INVALID_AMOUNT"));
  await assert.rejects(service.recharge("seed-member-carol", -5), expectError("INVALID_AMOUNT"));
});

test("取消预约后余额和积分正确回退，且不能重复取消", async () => {
  const { service, storage } = setup();

  const created = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    startTime: "2026-10-05T10:00:00+08:00",
    endTime: "2026-10-05T12:00:00+08:00",
  });
  assert.equal(created.member.balance, 404); // 500 - 96
  assert.equal(created.member.points, 416); // 320 + 96

  const cancelled = await service.cancelBooking(created.booking.id);
  assert.equal(cancelled.booking.status, "cancelled");
  assert.equal(cancelled.member.balance, 500);
  assert.equal(cancelled.member.points, 320);

  // 已取消的时段可以被重新预约（不再参与冲突判断）
  const rebooked = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-bob",
    startTime: "2026-10-05T10:00:00+08:00",
    endTime: "2026-10-05T12:00:00+08:00",
  });
  assert.equal(rebooked.booking.status, "booked");

  await assert.rejects(
    service.cancelBooking(created.booking.id),
    expectError("BOOKING_ALREADY_CANCELLED"),
  );

  // listBookings 默认不返回已取消预约
  const active = await service.listBookings();
  assert.equal(active.length, 1);
  const all = await service.listBookings(true);
  assert.equal(all.length, 2);
  assert.equal(storage.bookings[0].status, "cancelled");
});
