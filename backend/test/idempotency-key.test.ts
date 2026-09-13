/**
 * 预约请求键（Idempotency-Key / requestId）隔离回归组——可重复运行。
 *
 * 规则：
 *  - 同一会员 + 同一包厢 + 同一请求键重试：只复用原预约，只扣一次款；
 *  - 不同会员 或 不同包厢，即使请求键完全相同：各自独立处理，
 *    绝不返回他人/他厅的预约或账户数据；若时段冲突则按冲突拒绝（而非串单）。
 *
 * 并发用例用 test/gates.ts 的确定性门控制进入临界区的顺序；
 * 断言带【越权隔离】/【单次扣款】前缀，失败即指出泄露的数据或重复扣款。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { BusinessError, OperationsService } from "../src/modules/operations/operations.service";
import { createApp } from "../src/app";
import { Gate, seededGatedStorage } from "./gates";
import { MemoryStorage } from "./memory-storage";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";
import type { Member } from "../src/db/types";

const STRATEGY = "seed-room-strategy"; // 60/h
const PARTY = "seed-room-party"; // 88/h
const CARD = "seed-room-card"; // 40/h
const ALICE = "seed-member-alice"; // gold, 余额 500 积分 320
const BOB = "seed-member-bob"; // silver, 余额 120 积分 88
const CAROL = "seed-member-carol"; // bronze, 余额 30 积分 12
const SAME_KEY = "idempotency-key-20261020-001";

const SLOT_10_12 = { startTime: "2026-10-20T10:00:00+08:00", endTime: "2026-10-20T12:00:00+08:00" };
const SLOT_14_16 = { startTime: "2026-10-20T14:00:00+08:00", endTime: "2026-10-20T16:00:00+08:00" };

function code(error: unknown): string {
  return error instanceof BusinessError ? error.code : String(error);
}

function charges(member: Member) {
  return member.walletTransactions.filter((tx) => tx.kind === "charge").length;
}
function refunds(member: Member) {
  return member.walletTransactions.filter((tx) => tx.kind === "refund").length;
}

// ---------------------------------------------------------------------------
describe("同一会员同一包厢同一请求键：重试只复用、只扣一次", () => {
  test("顺序重试：第二次返回同一笔预约，金额积分不变、无第二条扣款", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const first = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    const second = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });

    assert.equal(second.booking.id, first.booking.id, "【幂等复用】重试必须返回同一笔预约 id");
    assert.equal(second.booking.status, "booked");
    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【单次扣款】重试不得产生第二条预约");
    const alice = await storage.getMember(ALICE);
    assert.equal(charges(alice!), 1, "【单次扣款】重试不得第二次扣款");
    assert.equal(alice!.balance, 404, "【单次扣款】余额必须只减少一次 96（500-96）");
    assert.equal(alice!.points, 416, "【积分】积分只累积一次");
  });

  test("重试时即使携带不同时间参数，也只返回原预约（不另建、不改价、不另扣款）", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const first = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    // 客户端用同一 requestId 重试，却误传了另一个时段
    const retry = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_14_16,
    });

    assert.equal(retry.booking.id, first.booking.id, "【幂等复用】同键重试必须返回原预约");
    assert.equal(retry.booking.startTime, first.booking.startTime, "【幂等复用】重试参数不得改动原预约时段");
    assert.equal(retry.booking.chargedAmount, 96, "【单次扣款】不得按重试参数重新计价扣款");
    const alice = await storage.getMember(ALICE);
    assert.equal(charges(alice!), 1);
    assert.equal(alice!.balance, 404);
  });

  test("并发双击（确定性门控）：两个同键请求同时到达，都返回同一笔预约且只扣一次", async () => {
    // 门装在锁外 getRoom：两请求同时停在包厢锁前，开门后串行进入同一把包厢锁
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = new OperationsService(storage);
    gate.arm();

    const a = service.createBooking({ roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12 });
    const b = service.createBooking({ roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12 });
    await gate.waitForArrivals();
    gate.open();

    const results = await Promise.allSettled([a, b]);
    assert.equal(
      results.filter((r) => r.status === "fulfilled").length,
      2,
      "【幂等复用】携带相同请求键的并发双击，两笔都应成功返回，而不是互相判为冲突",
    );
    const first = (results[0] as PromiseFulfilledResult<{ booking: { id: string } }>).value;
    const second = (results[1] as PromiseFulfilledResult<{ booking: { id: string } }>).value;
    assert.equal(second.booking.id, first.booking.id, "【幂等复用】两个响应必须是同一笔预约");

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【单次扣款】双击后只允许一条预约");
    const alice = await storage.getMember(ALICE);
    assert.equal(charges(alice!), 1, "【单次扣款】并发双击只允许一条扣款流水");
    assert.equal(alice!.balance, 404, "【单次扣款】余额只能减少一次 96");
    assert.equal(alice!.points, 416);
  });
});

// ---------------------------------------------------------------------------
describe("不同会员使用相同请求键：必须隔离", () => {
  test("不同会员、不同时段：两笔各自成功，互不返回对方数据", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const aliceOrder = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    const bobOrder = await service.createBooking({
      roomId: STRATEGY, memberId: BOB, requestId: SAME_KEY, ...SLOT_14_16,
    });

    assert.notEqual(bobOrder.booking.id, aliceOrder.booking.id, "【越权隔离】不同会员同键必须各自成单");
    assert.equal(bobOrder.booking.memberId, BOB, "【越权隔离】返回的预约必须属于下单会员本人");
    assert.equal(aliceOrder.booking.memberId, ALICE);
    assert.equal(bobOrder.member.id, BOB, "【越权隔离】返回的账户必须是下单会员本人的账户");
    assert.equal(aliceOrder.member.id, ALICE);

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 2);

    const alice = await storage.getMember(ALICE);
    const bob = await storage.getMember(BOB);
    assert.equal(alice!.balance, 404, "【单次扣款】林小鹿按 gold 扣自己的 96");
    assert.equal(bob!.balance, 12, "【单次扣款】周大锤按 silver 扣策略厅 2h 自己的 108（120-108）");
    assert.equal(charges(bob!), 1, "【单次扣款】两笔订单各有一条属于本人的扣款");
    // 两条扣款流水分别属于各自会员，金额互不相同，证明没有串到对方账户
    assert.equal(aliceOrder.booking.chargedAmount, 96);
    assert.equal(bobOrder.booking.chargedAmount, 108);
  });

  test("不同会员、同一时段：第二笔必须按时段冲突拒绝，而不是拿到第一笔的预约", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const aliceOrder = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });

    await assert.rejects(
      service.createBooking({ roomId: STRATEGY, memberId: BOB, requestId: SAME_KEY, ...SLOT_10_12 }),
      (error: unknown) => code(error) === "TIME_CONFLICT",
      "【越权隔离】不同会员同键抢同一时段必须返回冲突，绝不能返回林小鹿的预约",
    );

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【越权隔离】冲突方不得产生预约");
    assert.equal(bookings[0].id, aliceOrder.booking.id);
    assert.equal(bookings[0].memberId, ALICE, "【越权隔离】留下的预约必须是先下单会员本人的");

    const bob = await storage.getMember(BOB);
    assert.equal(charges(bob!), 0, "【单次扣款】被冲突拒绝的会员不得被扣款");
    assert.equal(bob!.balance, 120, "【单次扣款】周大锤余额必须保持 120");
    assert.equal(bob!.points, 88);
  });

  test("不同会员同键并发抢同一时段（确定性门控）：只有一个会员成功，另一会员收到冲突且不扣款", async () => {
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = new OperationsService(storage);
    gate.arm();

    const alicePromise = service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    const bobPromise = service.createBooking({
      roomId: STRATEGY, memberId: BOB, requestId: SAME_KEY, ...SLOT_10_12,
    });
    await gate.waitForArrivals();
    gate.open();

    const [aliceResult, bobResult] = await Promise.allSettled([alicePromise, bobPromise]);

    let winner: "alice" | "bob";
    if (aliceResult.status === "fulfilled") {
      winner = "alice";
      assert.equal(code((bobResult as PromiseRejectedResult).reason), "TIME_CONFLICT", "【越权隔离】败方必须是冲突而非串单");
    } else {
      winner = "bob";
      assert.equal(code((aliceResult as PromiseRejectedResult).reason), "TIME_CONFLICT");
    }

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【越权隔离】并发后只允许一条预约");
    assert.equal(
      bookings[0].memberId,
      winner === "alice" ? ALICE : BOB,
      "【越权隔离】保留的预约必须属于真正的赢家本人",
    );

    const alice = await storage.getMember(ALICE);
    const bob = await storage.getMember(BOB);
    if (winner === "alice") {
      assert.equal(alice!.balance, 404, "【单次扣款】赢家林小鹿只扣一次 96");
      assert.equal(bob!.balance, 120, "【单次扣款】败方周大锤不得被扣款");
      assert.equal(charges(bob!), 0);
    } else {
      // 周大锤 silver 2h 策略厅 = 108，余额 120 足够
      assert.equal(bob!.balance, 120 - 108, "【单次扣款】赢家周大锤只扣一次 108");
      assert.equal(alice!.balance, 500, "【单次扣款】败方林小鹿不得被扣款");
      assert.equal(charges(alice!), 0);
    }
  });
});

// ---------------------------------------------------------------------------
describe("不同包厢使用相同请求键：必须隔离", () => {
  test("同一会员、不同包厢、同键、不重叠时段：两笔各自成功、各扣各的款", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const strategy = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12, // 96
    });
    const card = await service.createBooking({
      roomId: CARD, memberId: ALICE, requestId: SAME_KEY, ...SLOT_14_16, // 40*2*0.8=64
    });

    assert.notEqual(card.booking.id, strategy.booking.id, "【越权隔离】不同包厢同键必须各自成单");
    assert.equal(card.booking.roomId, CARD, "【越权隔离】返回的预约必须属于下单包厢");
    assert.equal(strategy.booking.roomId, STRATEGY);

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 2);
    const alice = await storage.getMember(ALICE);
    assert.equal(charges(alice!), 2, "【单次扣款】两笔预约必须各有一条扣款（同键不等于合并）");
    assert.equal(alice!.balance, 500 - 96 - 64, "【单次扣款】余额按两笔实付累计扣减");
    assert.equal(alice!.points, 320 + 96 + 64);
  });

  test("不同会员 + 不同包厢 + 完全相同请求键 + 同一时段：互不冲突，各自扣款", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const a = await service.createBooking({ roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12 });
    // 周大锤订静谧卡牌室 1h（40*0.9=36），余额足够
    const b = await service.createBooking({ roomId: CARD, memberId: BOB, requestId: SAME_KEY, ...{ startTime: SLOT_10_12.startTime, endTime: "2026-10-20T11:00:00+08:00" } });

    assert.notEqual(a.booking.id, b.booking.id, "【越权隔离】会员与包厢都不同，必须是两笔独立预约");
    assert.equal(a.booking.memberId, ALICE);
    assert.equal(b.booking.memberId, BOB);
    assert.equal(b.booking.roomId, CARD);
    assert.equal(b.member.id, BOB, "【越权隔离】返回账户必须是周大锤本人，不能串到林小鹿");
    const alice = await storage.getMember(ALICE);
    const bob = await storage.getMember(BOB);
    assert.equal(alice!.balance, 404);
    assert.equal(bob!.balance, 84, "【单次扣款】周大锤只扣自己的 36");
    assert.equal((await service.listBookings()).length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("请求键与取消/失败的交互", () => {
  test("同键预约取消后，允许用同一请求键重新发起（不返回旧的已取消预约）", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    const first = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    const cancelled = await service.cancelBooking(first.booking.id);
    assert.equal(cancelled.booking.status, "cancelled");
    assert.equal(cancelled.member.balance, 500);

    const rebook = await service.createBooking({
      roomId: STRATEGY, memberId: ALICE, requestId: SAME_KEY, ...SLOT_10_12,
    });
    assert.notEqual(rebook.booking.id, first.booking.id, "【幂等复用】已取消的请求键必须允许新建，不能返回旧单");
    assert.equal(rebook.booking.status, "booked");
    assert.equal(rebook.member.balance, 404, "退款后重订再扣一次 96，最终余额 404");

    const alice = await storage.getMember(ALICE);
    assert.equal(charges(alice!), 2, "取消后重订：两笔预约各一条扣款");
    assert.equal(refunds(alice!), 1, "只有第一笔被退款");
  });

  test("余额不足的同键请求失败后，充值再用同键重试应成功（失败不占用请求键）", async () => {
    const storage = seededGatedStorage();
    const service = new OperationsService(storage);

    // 苏晴 bronze 余额 30：策略厅 2h = 120，余额不足
    await assert.rejects(
      service.createBooking({ roomId: STRATEGY, memberId: CAROL, requestId: SAME_KEY, ...SLOT_10_12 }),
      (error: unknown) => code(error) === "INSUFFICIENT_BALANCE",
    );
    const carolBefore = await storage.getMember(CAROL);
    assert.equal(carolBefore!.balance, 30, "【单次扣款】失败请求不得扣款");
    assert.equal(charges(carolBefore!), 0);

    await service.recharge(CAROL, 200); // 余额 230
    const retry = await service.createBooking({
      roomId: STRATEGY, memberId: CAROL, requestId: SAME_KEY, ...SLOT_10_12,
    });
    assert.equal(retry.booking.status, "booked", "失败不占用请求键：充值后同键重试必须成功");
    assert.equal(retry.member.balance, 110, "230 - 120 = 110");
    assert.equal(charges(retry.member), 1, "【单次扣款】只扣成功的这一次");
  });
});

// ---------------------------------------------------------------------------
describe("HTTP：Idempotency-Key 头隔离", () => {
  test("两个会员用相同 Idempotency-Key 抢同一时段：一个 201、一个 409，账户各自独立", async () => {
    const storage = new MemoryStorage().withSeed(
      SEED_ROOMS.map((room) => ({ ...room })),
      SEED_MEMBERS.map((member) => ({ ...member })),
    );
    const app = createApp(storage, "file");
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("bind failed");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    try {
      const body = (memberId: string) =>
        JSON.stringify({ roomId: STRATEGY, memberId, ...SLOT_10_12 });
      // 相同 Idempotency-Key 头，不同会员
      const [resAlice, resBob] = await Promise.all([
        fetch(`${baseUrl}/bookings`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": SAME_KEY }, body: body(ALICE),
        }),
        fetch(`${baseUrl}/bookings`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": SAME_KEY }, body: body(BOB),
        }),
      ]);

      const statuses = [resAlice.status, resBob.status].sort((x, y) => x - y);
      assert.deepEqual(statuses, [201, 409], `【越权隔离】期望 201+409，实际 ${statuses.join(",")}`);

      // 林小鹿用同一个键重试：必须 201 且返回原单
      const retry = await fetch(`${baseUrl}/bookings`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": SAME_KEY }, body: body(ALICE),
      });
      assert.equal(retry.status, 201, "【幂等复用】同会员同键重试必须成功返回原预约");
      const retryBody = (await retry.json()) as { booking: { id: string; memberId: string }; member: Member };
      assert.equal(retryBody.booking.memberId, ALICE, "【越权隔离】重试返回的预约必须属于林小鹿本人");
      assert.equal(retryBody.member.id, ALICE, "【越权隔离】重试返回的账户必须是林小鹿本人账户");

      const members = (await (await fetch(`${baseUrl}/members`)).json()) as Member[];
      const alice = members.find((m) => m.id === ALICE)!;
      const bob = members.find((m) => m.id === BOB)!;
      assert.equal(charges(alice), 1, "【单次扣款】林小鹿只有一条扣款");
      assert.equal(charges(bob), 0, "【单次扣款】周大锤被冲突拒绝，零扣款");
      assert.equal(bob.balance, 120);
    } finally {
      server.close();
    }
  });
});
