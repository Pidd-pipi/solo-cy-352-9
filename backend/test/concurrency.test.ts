import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { MemoryStorage } from "./memory-storage";
import { BusinessError, OperationsService } from "../src/modules/operations/operations.service";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";
import type { Storage } from "../src/db/types";
import { createApp } from "../src/app";

/**
 * 可手动控制的门：await gate.wait() 会一直挂起，直到 gate.open()。
 * 用于把多个并发请求确定性地停在存储调用点，再同时放行，复现竞态。
 */
class Gate {
  private resolveGate: (() => void) | null = null;
  private readonly opened: Promise<void> = new Promise((resolve) => {
    this.resolveGate = resolve;
  });
  waiters = 0;
  private armed = false;
  private readonly waiterArrivals: Array<() => void> = [];
  private readonly arrivalWaiters: Array<Promise<void>> = [];

  constructor(private readonly blockCalls: number) {
    for (let i = 0; i < blockCalls; i += 1) {
      this.arrivalWaiters.push(
        new Promise<void>((resolve) => {
          this.waiterArrivals.push(resolve);
        }),
      );
    }
  }

  arm(): void {
    this.armed = true;
  }

  /** 调用方在门内 await 它；武装后的前 blockCalls 次调用被挡住，并通知“有请求到门了”。 */
  async enter(): Promise<void> {
    if (!this.armed) {
      return;
    }
    const index = this.waiters;
    if (index < this.blockCalls) {
      this.waiters += 1;
      this.waiterArrivals[index]();
      await this.opened;
    }
  }

  /** 等齐 blockCalls 个请求都停在门前 */
  async waitForArrivals(): Promise<void> {
    await Promise.all(this.arrivalWaiters);
  }

  open(): void {
    this.resolveGate?.();
  }
}

/**
 * 在内存存储外包一层：getRoom 先过门。
 *
 * getRoom 发生在包厢互斥锁之外（资源存在性校验），因此两个并发请求都会到达这里；
 * 开门放行后它们再竞争同一把包厢锁，可确定性地验证“同时发起、串行裁决”。
 * （若把门放在锁内的 listBookings 上，修复后的实现中第二个请求根本无法到达，
 * 因为它会在锁外排队等待——那个位置只能阻塞住第一个请求，无法构造并发。）
 */
class GatedStorage extends MemoryStorage {
  constructor(private readonly gate: Gate) {
    super();
  }

  override async getRoom(id: string) {
    await this.gate.enter();
    return super.getRoom(id);
  }
}

function isBusinessError(error: unknown, code: string): boolean {
  return error instanceof BusinessError && error.code === code;
}

function setupStorage(mutate?: (members: typeof SEED_MEMBERS) => void): MemoryStorage {
  const members = SEED_MEMBERS.map((member) => ({ ...member }));
  mutate?.(members);
  return new MemoryStorage().withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    members,
  );
}

const SLOT_A = {
  startTime: "2026-10-20T10:00:00+08:00",
  endTime: "2026-10-20T12:00:00+08:00",
};
const SLOT_OVERLAP = {
  startTime: "2026-10-20T11:00:00+08:00",
  endTime: "2026-10-20T13:00:00+08:00",
};
const SLOT_ADJACENT = {
  startTime: "2026-10-20T12:00:00+08:00",
  endTime: "2026-10-20T14:00:00+08:00",
};

test("并发：同包厢重叠时段，只有一个请求成功，另一个得到时段冲突且不扣款/不落单", async () => {
  const gate = new Gate(2);
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);
  gate.arm();

  const first = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });
  const second = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-bob",
    ...SLOT_OVERLAP,
  });

  // 两个请求都已进入查重临界区并停在门前，然后同时放行
  await gate.waitForArrivals();
  assert.equal(gate.waiters, 2);
  gate.open();

  const results = await Promise.allSettled([first, second]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "必须恰好一个请求成功");
  assert.equal(rejected.length, 1, "必须恰好一个请求失败");
  const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(
    isBusinessError(rejectedReason, "TIME_CONFLICT"),
    `失败原因必须是 TIME_CONFLICT，实际：${String(rejectedReason)}`,
  );

  // 只有一条已预约记录，没有重叠预约
  const bookings = await service.listBookings();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, "booked");

  // 只有成功者被扣过一次款：林小鹿 -96（gold 8 折），周大锤余额不变
  const members = await service.listMembers();
  const alice = members.find((m) => m.id === "seed-member-alice")!;
  const bob = members.find((m) => m.id === "seed-member-bob")!;
  assert.equal(alice.balance, 500 - 96);
  assert.equal(alice.points, 320 + 96);
  assert.equal(bob.balance, 120, "冲突方不得被扣款");
  assert.equal(bob.points, 88, "冲突方不得累积积分");
});

test("并发：同一会员对同一时段双击提交，只能成功一次（防重复扣款）", async () => {
  const gate = new Gate(2);
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);
  gate.arm();

  const first = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });
  const doubleClick = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });

  await gate.waitForArrivals();
  gate.open();

  const results = await Promise.allSettled([first, doubleClick]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const reason = (rejected[0] as PromiseRejectedResult).reason;
  // 第二个请求要么撞时段冲突，要么在第一笔扣款后余额不足——二者都代表“没有重复扣款”
  assert.ok(
    isBusinessError(reason, "TIME_CONFLICT") || isBusinessError(reason, "INSUFFICIENT_BALANCE"),
    `第二个请求必须被拒绝，实际：${String(reason)}`,
  );

  const bookings = await service.listBookings();
  assert.equal(bookings.length, 1, "重复点击不得产生两条预约");

  const alice = (await service.listMembers()).find((m) => m.id === "seed-member-alice")!;
  assert.equal(alice.balance, 500 - 96, "只能扣一次款");
  assert.equal(alice.points, 320 + 96, "只能积一次分");
});

test("并发：同包厢首尾相接（非重叠）的两个请求都应成功", async () => {
  const gate = new Gate(2);
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);
  gate.arm();

  const first = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });
  const adjacent = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-bob",
    ...SLOT_ADJACENT,
  });

  await gate.waitForArrivals();
  gate.open();

  const results = await Promise.allSettled([first, adjacent]);
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    2,
    "首尾相接不算重叠，两笔都应成功",
  );
  const bookings = await service.listBookings();
  assert.equal(bookings.length, 2);
});

test("并发：不同包厢使用不同锁，同一时段互不阻塞、都成功", async () => {
  const gate = new Gate(2);
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);
  gate.arm();

  const strategyRoom = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });
  const cardRoom = service.createBooking({
    roomId: "seed-room-card",
    memberId: "seed-member-bob",
    ...SLOT_A,
  });

  await gate.waitForArrivals();
  gate.open();

  const results = await Promise.allSettled([strategyRoom, cardRoom]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const bookings = await service.listBookings();
  assert.equal(bookings.length, 2);
  const roomIds = new Set(bookings.map((b) => b.roomId));
  assert.deepEqual([...roomIds].sort(), ["seed-room-card", "seed-room-strategy"]);
});

test("并发：两笔余额都不足时，不会出现任何扣款或预约", async () => {
  const gate = new Gate(2);
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);
  gate.arm();

  // 苏晴 bronze 余额 30；策略厅 2h = 120。两笔都不可能成功
  const first = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-carol",
    ...SLOT_A,
  });
  const second = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-carol",
    ...SLOT_OVERLAP,
  });

  await gate.waitForArrivals();
  gate.open();

  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(isBusinessError(result.reason, "INSUFFICIENT_BALANCE"));
    }
  }
  assert.equal((await service.listBookings()).length, 0);
  const carol = (await service.listMembers()).find((m) => m.id === "seed-member-carol")!;
  assert.equal(carol.balance, 30);
  assert.equal(carol.points, 12);
});

test("并发：取消与新建竞争时，取消完成后释放的时段可以被新预约使用，退款恰好一次", async () => {
  // 先有一笔林小鹿 10-12 点的预约；取消它的同时，周大锤并发预订同一时段。
  // 串行化保证：要么新预约先到（撞冲突），要么取消先到（新预约成功）——结果只能二选一，
  // 且余额、积分、预约数始终一致，不会出现“取消了一条仍然有效的重叠预约”。
  const gate = new Gate(1); // 只拦第一个进入查重的请求
  const storage = new GatedStorage(gate).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  const service = new OperationsService(storage);

  const existing = await service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-alice",
    ...SLOT_A,
  });

  // 建场完成后再武装门，只拦截下面这笔并发新建
  gate.arm();

  const cancelPromise = service.cancelBooking(existing.booking.id);
  const createPromise = service.createBooking({
    roomId: "seed-room-strategy",
    memberId: "seed-member-bob",
    ...SLOT_A,
  });

  // 等先到的那一个请求停在它的临界区门前（取消不经过 listBookings，门只作用于新建）
  await gate.waitForArrivals();
  gate.open();

  const [cancelResult, createResult] = await Promise.allSettled([cancelPromise, createPromise]);
  assert.equal(cancelResult.status, "fulfilled", "取消必须成功");
  if (cancelResult.status === "fulfilled") {
    // 林小鹿收到一次退款，回到初始余额/积分
    assert.equal(cancelResult.value.member.balance, 500);
    assert.equal(cancelResult.value.member.points, 320);
  }

  const bookings = await service.listBookings();
  const members = await service.listMembers();
  const alice = members.find((m) => m.id === "seed-member-alice")!;
  const bob = members.find((m) => m.id === "seed-member-bob")!;

  if (createResult.status === "fulfilled") {
    // 取消先落定 -> 新预约成功：只剩周大锤那一笔，林小鹿已退款
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].memberId, "seed-member-bob");
    assert.equal(bob.balance, 120 - bookings[0].chargedAmount);
    assert.equal(alice.balance, 500);
    assert.equal(alice.points, 320);
  } else {
    // 新预约先落定 -> 与原预约冲突被拒；随后取消把原预约取消
    assert.ok(isBusinessError((createResult as PromiseRejectedResult).reason, "TIME_CONFLICT"));
    assert.equal(bookings.length, 0);
    assert.equal(bob.balance, 120, "被冲突拒绝的一方不扣款");
    assert.equal(alice.balance, 500);
    assert.equal(alice.points, 320);
  }

  // 重复取消仍然必须失败，防止双重退款
  await assert.rejects(
    service.cancelBooking(existing.booking.id),
    (error: unknown) => isBusinessError(error, "BOOKING_ALREADY_CANCELLED"),
  );
  const aliceAfter = (await service.listMembers()).find((m) => m.id === "seed-member-alice")!;
  assert.equal(aliceAfter.balance, 500, "重复取消不得二次退款");
  assert.equal(aliceAfter.points, 320, "重复取消不得二次回退积分");
});

test("HTTP 并发：同时打两个重叠预约请求，响应为一个 201 一个 409", async () => {
  const storage: Storage = setupStorage();
  const app = createApp(storage as Parameters<typeof createApp>[0], "file");
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  try {
    const payload = (memberId: string, slot: typeof SLOT_A) =>
      JSON.stringify({ roomId: "seed-room-strategy", memberId, ...slot });

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload("seed-member-alice", SLOT_A),
      }),
      fetch(`${baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload("seed-member-bob", SLOT_OVERLAP),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], `期望 201+409，实际 ${statuses.join(",")}`);

    const body409 = resA.status === 409 ? await resA.json() : await resB.json();
    assert.equal(body409.error, "TIME_CONFLICT");

    const membersResponse = await fetch(`${baseUrl}/members`);
    const members = (await membersResponse.json()) as Array<{ id: string; balance: number; points: number }>;
    const alice = members.find((m) => m.id === "seed-member-alice")!;
    const bob = members.find((m) => m.id === "seed-member-bob")!;
    // 成功方恰好扣一次（201 一定是 alice，因为 bob 的时段与 alice 重叠，反之也可能——按结果校验总额）
    const bookedResponse = await fetch(`${baseUrl}/bookings`);
    const booked = (await bookedResponse.json()) as unknown[];
    assert.equal(booked.length, 1, "只允许留下一条预约");
    assert.ok(
      (alice.balance === 404 && bob.balance === 120) || (alice.balance === 500 && bob.balance === 66),
      `扣款必须恰好一次，实际 alice=${alice.balance} bob=${bob.balance}`,
    );
    void alice;
  } finally {
    server.close();
  }
});
