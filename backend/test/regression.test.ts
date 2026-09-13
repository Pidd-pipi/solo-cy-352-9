/**
 * 包厢预约与会员储值 —— 可重复运行的确定性回归测试组。
 *
 * 并发用例全部通过 test/gates.ts 中的“确定性门”制造竞争：
 * 让请求在加锁边界的指定位置挂起，等所有竞争者就位后再按既定顺序放行，
 * 不依赖 setTimeout/时序，因此可稳定重复运行。
 *
 * 每条断言都带【规则名】前缀，失败时可直接指出被破坏的是哪条预约或余额规则。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { BusinessError, OperationsService } from "../src/modules/operations/operations.service";
import { createApp } from "../src/app";
import { Gate, GatedStorage, seededGatedStorage } from "./gates";
import type { Member } from "../src/db/types";

const ROOM_STRATEGY = "seed-room-strategy"; // 60/h，可预约
const ROOM_PARTY = "seed-room-party"; // 88/h，可预约
const ROOM_CARD = "seed-room-card"; // 40/h，可预约
const ROOM_SCRIPT = "seed-room-script"; // 维护中，120/h
const ALICE = "seed-member-alice"; // gold 8 折，余额 500，积分 320
const BOB = "seed-member-bob"; // silver 9 折，余额 120，积分 88
const CAROL = "seed-member-carol"; // bronze 原价，余额 30，积分 12

const SLOT_10_12 = { startTime: "2026-10-20T10:00:00+08:00", endTime: "2026-10-20T12:00:00+08:00" };
const SLOT_11_13 = { startTime: "2026-10-20T11:00:00+08:00", endTime: "2026-10-20T13:00:00+08:00" };
const SLOT_12_14 = { startTime: "2026-10-20T12:00:00+08:00", endTime: "2026-10-20T14:00:00+08:00" };
const SLOT_13_14 = { startTime: "2026-10-20T13:00:00+08:00", endTime: "2026-10-20T14:00:00+08:00" };
const SLOT_12_13 = { startTime: "2026-10-20T12:00:00+08:00", endTime: "2026-10-20T13:00:00+08:00" };
const SLOT_10_1130 = { startTime: "2026-10-21T10:00:00+08:00", endTime: "2026-10-21T11:20:00+08:00" }; // 1h20m → 1.5h
const SLOT_10_11 = { startTime: "2026-10-21T10:00:00+08:00", endTime: "2026-10-21T11:00:00+08:00" };

function makeService(storage: GatedStorage) {
  return new OperationsService(storage);
}

async function settledCode(result: PromiseSettledResult<unknown>): Promise<string> {
  assert.equal(result.status, "rejected", "该请求应当被拒绝，但它成功了");
  assert.ok(
    result.status === "rejected" && result.reason instanceof BusinessError,
    `拒绝原因必须是业务错误，实际：${String((result as PromiseRejectedResult).reason)}`,
  );
  return (result as PromiseRejectedResult).reason.code;
}

function expectCode(error: unknown, code: string): boolean {
  return error instanceof BusinessError && error.code === code;
}

// ---------------------------------------------------------------------------
describe("并发：同一包厢重叠预订", () => {
  test("两请求同时预订同一包厢重叠时段：恰好一个成功，另一个【时段冲突】，不允许重叠预约或重复扣款", async () => {
    // 门装在锁外的 getRoom 上（每次下单会在锁外、锁内各调一次 getRoom）；
    // blockCalls=2 恰好拦住两笔请求的锁外校验，使它们同时停在包厢锁前。
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = makeService(storage);
    gate.arm();

    const a = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    const b = service.createBooking({ roomId: ROOM_STRATEGY, memberId: BOB, ...SLOT_11_13 });

    await gate.waitForArrivals();
    assert.equal(gate.waiters, 2, "两个并发请求都必须停在包厢锁前");
    gate.open();

    const results = await Promise.allSettled([a, b]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "【冲突规则】并发重叠预订只能有一笔成功");
    assert.equal(rejected.length, 1, "【冲突规则】必须有一笔被拒绝");
    assert.equal(
      await settledCode(rejected[0]),
      "TIME_CONFLICT",
      "【冲突规则】失败方必须返回时段冲突 TIME_CONFLICT",
    );

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【冲突规则】同一包厢不得留下两条重叠预约");
    assert.equal(bookings[0].status, "booked");

    // 谁赢不确定（锁竞争），但只有赢家按自己的等级被扣一次款
    const members = await service.listMembers();
    const alice = members.find((m) => m.id === ALICE)!;
    const bob = members.find((m) => m.id === BOB)!;
    const winner = bookings[0].memberId === ALICE ? alice : bob;
    const loser = bookings[0].memberId === ALICE ? bob : alice;
    assert.equal(
      winner.balance + bookings[0].chargedAmount,
      winner.id === ALICE ? 500 : 120,
      "【扣款规则】成功方只能被扣一次款，金额等于预约实付额",
    );
    assert.equal(
      winner.points - bookings[0].pointsEarned,
      winner.id === ALICE ? 320 : 88,
      "【积分规则】成功方只能累积一次积分",
    );
    assert.equal(loser.balance, loser.id === ALICE ? 500 : 120, "【扣款规则】冲突失败方不得被扣款");
    assert.equal(loser.points, loser.id === ALICE ? 320 : 88, "【积分规则】冲突失败方不得获得积分");
  });

  test("同一会员双击重复提交同一时段：只允许一笔成功，不允许【重复扣款】", async () => {
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = makeService(storage);
    gate.arm();

    const first = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    const doubleClick = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });

    await gate.waitForArrivals();
    gate.open();

    const results = await Promise.allSettled([first, doubleClick]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "【冲突规则】双击提交只能成功一笔");
    const rejectedCode = await settledCode(results.find((r) => r.status === "rejected")!);
    assert.ok(
      rejectedCode === "TIME_CONFLICT" || rejectedCode === "INSUFFICIENT_BALANCE",
      `【冲突规则/扣款规则】第二笔必须因冲突或余额不足被拒绝，实际：${rejectedCode}`,
    );

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "【冲突规则】重复点击不得生成两条预约");
    const alice = (await service.listMembers()).find((m) => m.id === ALICE)!;
    assert.equal(alice.balance, 500 - 96, "【扣款规则】重复提交只能扣一次款（gold 2h 实付 96）");
    assert.equal(alice.points, 320 + 96, "【积分规则】重复提交只能积一次分");
  });

  test("同一会员连续提交首尾相接的不同时段：两笔都成功，分别按折扣扣款累计积分", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    const r1 = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    const r2 = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_12_13 });

    assert.equal(r1.booking.chargedAmount, 96, "【折扣规则】gold：60×2×0.8=96");
    assert.equal(r2.booking.chargedAmount, 48, "【折扣规则】gold：60×1×0.8=48");
    const bookings = await service.listBookings();
    assert.equal(bookings.length, 2, "【冲突规则】首尾相接（半开区间）不算冲突，两笔都应存在");
    const alice = (await service.listMembers()).find((m) => m.id === ALICE)!;
    assert.equal(alice.balance, 500 - 96 - 48, "【扣款规则】连续两笔都要扣款");
    assert.equal(alice.points, 320 + 96 + 48, "【积分规则】连续两笔的积分都要累积");
  });

  test("不同包厢同时段并发：各自独立锁，互不阻塞，两笔都成功", async () => {
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = makeService(storage);
    gate.arm();

    const a = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    const b = service.createBooking({ roomId: ROOM_CARD, memberId: BOB, ...SLOT_10_12 });

    await gate.waitForArrivals();
    gate.open();
    const results = await Promise.allSettled([a, b]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "【冲突规则】不同包厢不构成冲突");
    assert.equal((await service.listBookings()).length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("并发：取消与新建竞争", () => {
  test("确定性次序【取消先落定 → 新建后进入】：新预约成功，原退款恰好一次", async () => {
    const cancelGate = new Gate(1); // 取消在锁外 getBooking 处暂停
    const createGate = new Gate(1); // 新建在锁外 getMember（入锁前最后一步）处暂停
    const storage = seededGatedStorage({ getBooking: cancelGate, getMember: createGate });
    const service = makeService(storage);

    const existing = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    cancelGate.arm();
    createGate.arm();

    const cancelPromise = service.cancelBooking(existing.booking.id);
    const createPromise = service.createBooking({ roomId: ROOM_STRATEGY, memberId: BOB, ...SLOT_10_12 });

    await Promise.all([cancelGate.waitForArrivals(), createGate.waitForArrivals()]);

    // 先只放行取消，等它完全提交并释放包厢锁
    cancelGate.open();
    const cancelResult = await cancelPromise;
    assert.equal(cancelResult.booking.status, "cancelled", "【取消规则】原预约必须被置为已取消");
    assert.equal(cancelResult.member.balance, 500, "【回退规则】取消后余额必须恢复到扣款前 500");
    assert.equal(cancelResult.member.points, 320, "【回退规则】取消后积分必须恢复到 320");

    // 再放行新建：此时段已释放，允许重新预约
    createGate.open();
    const createResult = await createPromise;
    assert.equal(createResult.booking.memberId, BOB, "【冲突规则】取消释放时段后，新会员应能预订同一时段");

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 1, "取消 + 重订后进行中预约应恰好为 1 条");
    const bob = (await service.listMembers()).find((m) => m.id === BOB)!;
    assert.equal(bob.balance, 120 - createResult.booking.chargedAmount, "【扣款规则】重订方按自己的订单扣款一次");
    const alice = (await service.listMembers()).find((m) => m.id === ALICE)!;
    assert.equal(alice.balance, 500, "【回退规则】原预订人只退款一次");
  });

  test("确定性次序【新建先持锁 → 取消后执行】：新建撞冲突被拒且不扣款，取消随后正常退款", async () => {
    const listGate = new Gate(1); // 新建持锁后停在锁内查重点
    const storage = seededGatedStorage({ listBookings: listGate });
    const service = makeService(storage);

    const existing = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    listGate.arm();

    // 新建先发起：进入包厢锁并停在查重点
    const createPromise = service.createBooking({ roomId: ROOM_STRATEGY, memberId: BOB, ...SLOT_10_12 });
    await listGate.waitForArrivals();

    // 取消随后发起：锁外读取后在包厢锁后排队（同步入队，先到先得排在新建之后）
    const cancelPromise = service.cancelBooking(existing.booking.id);

    // 放行新建：它看到仍有效的原预约 → 冲突；释放锁后取消才执行
    listGate.open();
    const results = await Promise.allSettled([createPromise, cancelPromise]);
    assert.equal(
      await settledCode(results[0]),
      "TIME_CONFLICT",
      "【冲突规则】取消尚未提交时，并发新建必须撞时段冲突",
    );
    const cancelResult = results[1];
    assert.equal(cancelResult.status, "fulfilled", "【取消规则】排队在后的取消必须成功");
    if (cancelResult.status === "fulfilled") {
      assert.equal(cancelResult.value.member.balance, 500, "【回退规则】取消后林小鹿余额恢复 500");
      assert.equal(cancelResult.value.member.points, 320, "【回退规则】取消后林小鹿积分恢复 320");
    }

    const bookings = await service.listBookings();
    assert.equal(bookings.length, 0, "原预约已取消、新预约被拒，进行中预约应为 0");
    const bob = (await service.listMembers()).find((m) => m.id === BOB)!;
    assert.equal(bob.balance, 120, "【扣款规则】冲突失败方不得被扣款");
    assert.equal(bob.points, 88, "【积分规则】冲突失败方不得获得积分");
  });

  test("两笔取消并发竞争同一预约：只成功一笔，禁止【重复退款】", async () => {
    const gate = new Gate(2); // 两笔取消都停在锁外 getBooking
    const storage = seededGatedStorage({ getBooking: gate });
    const service = makeService(storage);

    const existing = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    gate.arm();
    const c1 = service.cancelBooking(existing.booking.id);
    const c2 = service.cancelBooking(existing.booking.id);
    await gate.waitForArrivals();
    gate.open();

    const results = await Promise.allSettled([c1, c2]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "【取消规则】并发取消只能成功一笔");
    assert.equal(
      await settledCode(results.find((r) => r.status === "rejected")!),
      "BOOKING_ALREADY_CANCELLED",
      "【取消规则】第二笔必须返回“已取消，不能重复取消”",
    );

    const alice = (await service.listMembers()).find((m) => m.id === ALICE)!;
    assert.equal(alice.balance, 500, "【回退规则】并发取消只能退款一次（96 不得退两次）");
    assert.equal(alice.points, 320, "【回退规则】并发取消积分只能回退一次");
  });
});

// ---------------------------------------------------------------------------
describe("并发：维护开关与下单竞争", () => {
  test("确定性次序【维护先提交 → 下单后进锁】：锁内重读维护标志，下单必须被拒", async () => {
    const maintenanceGate = new Gate(1); // 维护变更持锁后停在写入点
    const createGate = new Gate(1); // 下单停在入锁前的 getMember
    const storage = seededGatedStorage({
      updateRoomMaintenance: maintenanceGate,
      getMember: createGate,
    });
    const service = makeService(storage);
    maintenanceGate.arm();
    createGate.arm();

    // 维护先发起并拿到包厢锁，停在写入点
    const maintenancePromise = service.setMaintenance(ROOM_STRATEGY, true);
    // 下单随后发起：锁外读到的仍是“可预约”，但入锁前被门挡住
    const createPromise = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });

    await Promise.all([maintenanceGate.waitForArrivals(), createGate.waitForArrivals()]);

    // 先让维护落定并释放锁
    maintenanceGate.open();
    const room = await maintenancePromise;
    assert.equal(room.underMaintenance, true, "【维护规则】维护开关必须成功写入");

    // 再放行下单：锁内必须重读维护状态并拒绝
    createGate.open();
    const results = await Promise.allSettled([createPromise]);
    assert.equal(
      await settledCode(results[0]),
      "ROOM_IN_MAINTENANCE",
      "【维护规则】并发期间包厢被置为维护后，下单在锁内重读状态必须被拒绝（禁止凭锁外旧快照下单）",
    );
    assert.equal((await service.listBookings()).length, 0, "【维护规则】被维护拒绝的下单不得生成预约");
    const alice = (await service.listMembers()).find((m) => m.id === ALICE)!;
    assert.equal(alice.balance, 500, "【扣款规则】维护拒绝时不得扣款");
  });

  test("确定性次序【下单先提交 → 维护后执行】：预约成功，随后包厢进入维护", async () => {
    const listGate = new Gate(1); // 下单持锁后停在查重点
    const storage = seededGatedStorage({ listBookings: listGate });
    const service = makeService(storage);
    listGate.arm();

    const createPromise = service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    await listGate.waitForArrivals();

    // 维护变更同步入队，排在下单之后
    const maintenancePromise = service.setMaintenance(ROOM_STRATEGY, true);

    listGate.open();
    const createResult = await createPromise;
    const room = await maintenancePromise;

    assert.equal(createResult.booking.status, "booked", "【冲突规则】下单先持锁时应正常预约成功");
    assert.equal(createResult.member.balance, 404, "【扣款规则】成功下单按 gold 折扣扣款 96");
    assert.equal(room.underMaintenance, true, "【维护规则】下单释放锁后维护变更必须生效");
    assert.equal((await service.listBookings()).length, 1, "已提交的预约必须保留，不受随后维护影响");
  });

  test("维护中的包厢直接下单被拒；解除维护后下单成功（规则不回退）", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    await assert.rejects(
      service.createBooking({ roomId: ROOM_SCRIPT, memberId: ALICE, ...SLOT_10_11 }),
      (error: unknown) => expectCode(error, "ROOM_IN_MAINTENANCE"),
      "【维护规则】维护中的包厢拒绝预约",
    );
    const room = await service.setMaintenance(ROOM_SCRIPT, false);
    assert.equal(room.underMaintenance, false);
    const result = await service.createBooking({ roomId: ROOM_SCRIPT, memberId: ALICE, ...SLOT_10_11 });
    assert.equal(result.booking.status, "booked", "【维护规则】解除维护后允许预约");
  });
});

// ---------------------------------------------------------------------------
describe("余额不足：任何情况下都不扣款、不落单", () => {
  test("单笔下单余额不足：返回 402，余额积分不变、无预约", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    await assert.rejects(
      service.createBooking({ roomId: ROOM_STRATEGY, memberId: CAROL, ...SLOT_10_12 }),
      (error: unknown) => expectCode(error, "INSUFFICIENT_BALANCE"),
      "【扣款规则】余额 30 < bronze 2h 实付 120，必须拒绝",
    );
    const carol = (await service.listMembers()).find((m) => m.id === CAROL)!;
    assert.equal(carol.balance, 30, "【扣款规则】余额不足时不得扣款");
    assert.equal(carol.points, 12, "【积分规则】余额不足时不得增加积分");
    assert.equal((await service.listBookings()).length, 0, "【扣款规则】余额不足时不得生成预约");
  });

  test("并发两笔都余额不足：两笔都拒绝，零扣款零预约", async () => {
    const gate = new Gate(2);
    const storage = seededGatedStorage({ getRoom: gate });
    const service = makeService(storage);
    gate.arm();

    const a = service.createBooking({ roomId: ROOM_STRATEGY, memberId: CAROL, ...SLOT_10_12 });
    const b = service.createBooking({ roomId: ROOM_STRATEGY, memberId: CAROL, ...SLOT_11_13 });
    await gate.waitForArrivals();
    gate.open();

    const results = await Promise.allSettled([a, b]);
    for (const result of results) {
      assert.equal(
        await settledCode(result),
        "INSUFFICIENT_BALANCE",
        "【扣款规则】并发下余额不足的每一笔都必须被拒绝",
      );
    }
    const carol = (await service.listMembers()).find((m) => m.id === CAROL)!;
    assert.equal(carol.balance, 30, "【扣款规则】并发余额不足不得扣任何一笔款");
    assert.equal(carol.points, 12, "【积分规则】并发余额不足不得积任何分");
    assert.equal((await service.listBookings()).length, 0, "【扣款规则】并发余额不足不得留下预约");
  });

  test("连续消费把余额花光后，下一笔因余额不足被拒且不扣款", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    // 周大锤 silver 余额 120：静谧卡牌室 2h 实付 40×2×0.9=72 → 余 48
    const r1 = await service.createBooking({ roomId: ROOM_CARD, memberId: BOB, ...SLOT_10_12 });
    assert.equal(r1.booking.chargedAmount, 72);
    // 再订相邻 1h：40×1×0.9=36 → 余 12
    const r2 = await service.createBooking({ roomId: ROOM_CARD, memberId: BOB, ...SLOT_12_13 });
    assert.equal(r2.booking.chargedAmount, 36, "【折扣规则】1h 实付应为 36");

    let bob = (await service.listMembers()).find((m) => m.id === BOB)!;
    assert.equal(bob.balance, 120 - 72 - 36, "【扣款规则】前两笔按折扣累计扣款");

    // 余额 12 不足以支付任何包厢的下一小时（与上一时段首尾相接，不是冲突，纯粹余额不足）
    await assert.rejects(
      service.createBooking({ roomId: ROOM_CARD, memberId: BOB, ...SLOT_13_14 }),
      (error: unknown) => expectCode(error, "INSUFFICIENT_BALANCE"),
      "【扣款规则】余额 12 < 36 时必须拒绝",
    );
    bob = (await service.listMembers()).find((m) => m.id === BOB)!;
    assert.equal(bob.balance, 120 - 72 - 36, "【扣款规则】被拒后余额必须保持不变");
    assert.equal((await service.listBookings()).length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("折扣与积分", () => {
  test("各等级折扣、半小时向上取整、积分按实付向下取整", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    // gold 林小鹿：策略厅 1.5h，60×1.5=90，8 折 = 72，积分 72
    const gold = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_1130 });
    assert.equal(gold.booking.baseAmount, 90, "【计费规则】1h20m 按 1.5h 向上取整");
    assert.equal(gold.booking.chargedAmount, 72, "【折扣规则】gold 8 折：90×0.8=72");
    assert.equal(gold.booking.pointsEarned, 72, "【积分规则】实付 72 元得 72 分");

    // silver 周大锤：派对厅 1.5h，88×1.5=132，9 折 = 118.8，积分向下取整 118
    const silver = await service.createBooking({ roomId: ROOM_PARTY, memberId: BOB, ...SLOT_10_1130 });
    assert.equal(silver.booking.baseAmount, 132);
    assert.equal(silver.booking.chargedAmount, 118.8, "【折扣规则】silver 9 折：132×0.9=118.8");
    assert.equal(silver.booking.pointsEarned, 118, "【积分规则】积分按实付向下取整：floor(118.8)=118");

    // bronze 苏晴：卡牌室 1h（余额 30 恰好够 40？不够！）→ 先充值到 200（累计 300 仍 bronze）
    const carol = await service.recharge(CAROL, 170);
    assert.equal(carol.level, "bronze", "【等级规则】累计充值 300 仍是青铜");
    const bronze = await service.createBooking({ roomId: ROOM_CARD, memberId: CAROL, ...SLOT_10_11 });
    assert.equal(bronze.booking.chargedAmount, 40, "【折扣规则】bronze 原价：40×1=40");
    assert.equal(bronze.booking.pointsEarned, 40, "【积分规则】原价消费实付 40 得 40 分");
  });

  test("充值累计金额驱动自动升级：满 500 升白银 9 折，满 2000 升黄金 8 折", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    const silver = await service.recharge(CAROL, 500); // 100 + 500 = 600
    assert.equal(silver.level, "silver", "【等级规则】累计充值满 500 升白银");
    const gold = await service.recharge(CAROL, 1500); // 600 + 1500 = 2100
    assert.equal(gold.level, "gold", "【等级规则】累计充值满 2000 升黄金");
    assert.equal(gold.balance, 30 + 500 + 1500, "【充值规则】每次充值都累加进余额");

    await assert.rejects(service.recharge(CAROL, 0), (e: unknown) => expectCode(e, "INVALID_AMOUNT"));
    await assert.rejects(service.recharge(CAROL, -10), (e: unknown) => expectCode(e, "INVALID_AMOUNT"));
  });
});

// ---------------------------------------------------------------------------
describe("取消回退", () => {
  test("取消后余额、积分按实付额精确回退（含小数金额与向下取整积分）", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    // 周大锤 silver：派对厅 1.5h 实付 118.8、积分 118
    const created = await service.createBooking({ roomId: ROOM_PARTY, memberId: BOB, ...SLOT_10_1130 });
    assert.equal(created.member.balance, 1.2, "【扣款规则】120 - 118.8 = 1.2");
    assert.equal(created.member.points, 88 + 118, "【积分规则】88 + 118 = 206");

    const cancelled = await service.cancelBooking(created.booking.id);
    assert.equal(cancelled.booking.status, "cancelled");
    assert.equal(cancelled.member.balance, 120, "【回退规则】取消后余额必须精确恢复到 120（含小数）");
    assert.equal(cancelled.member.points, 88, "【回退规则】取消后积分必须回退 118，恢复到 88");
  });

  test("取消时按下单时锁定的金额退款：下单后会员升级，退款仍按原订单实付额", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    // 周大锤以 silver 身份消费卡牌室 2h：实付 72
    const created = await service.createBooking({ roomId: ROOM_CARD, memberId: BOB, ...SLOT_10_12 });
    assert.equal(created.member.balance, 48);
    // 随后充值升级为 gold（余额 1548）
    const upgraded = await service.recharge(BOB, 1500);
    assert.equal(upgraded.level, "gold");
    assert.equal(upgraded.balance, 1548);

    // 取消旧订单：必须按下单记录的 72 退款，而不是按 gold 重算
    const cancelled = await service.cancelBooking(created.booking.id);
    assert.equal(cancelled.member.level, "gold", "会员等级保持升级后的 gold");
    assert.equal(cancelled.member.balance, 1548 + 72, "【回退规则】退款必须等于原订单实付额 72");
    assert.equal(cancelled.member.points, 88, "【回退规则】积分按原订单获得的 72 回退");
  });

  test("取消后时段释放可被重新预约；已取消预约不参与冲突判断", async () => {
    const storage = seededGatedStorage();
    const service = makeService(storage);

    const created = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
    await service.cancelBooking(created.booking.id);

    const rebooked = await service.createBooking({ roomId: ROOM_STRATEGY, memberId: BOB, ...SLOT_10_12 });
    assert.equal(rebooked.booking.status, "booked", "【冲突规则】取消后同一时段必须允许重新预约");

    const active = await service.listBookings();
    const all = await service.listBookings(true);
    assert.equal(active.length, 1, "【取消规则】默认列表只含进行中预约");
    assert.equal(all.length, 2, "【取消规则】含已取消时总数为 2");

    await assert.rejects(
      service.cancelBooking(created.booking.id),
      (error: unknown) => expectCode(error, "BOOKING_ALREADY_CANCELLED"),
      "【取消规则】重复取消必须报错",
    );
  });
});

// ---------------------------------------------------------------------------
describe("HTTP 层并发", () => {
  test("两个重叠预约请求同时到达：响应必须是一个 201 一个 409，且只扣一次款", async () => {
    const storage = seededGatedStorage();
    const app = createApp(storage, "file");
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api`;

    try {
      const payload = (memberId: string, slot: typeof SLOT_10_12) =>
        JSON.stringify({ roomId: ROOM_STRATEGY, memberId, ...slot });

      // 同时发出两个真实 HTTP 请求（Node 会在事件循环中并发处理）
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/bookings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload(ALICE, SLOT_10_12),
        }),
        fetch(`${baseUrl}/bookings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload(BOB, SLOT_11_13),
        }),
      ]);

      const statuses = [resA.status, resB.status].sort((x, y) => x - y);
      assert.deepEqual(statuses, [201, 409], `【冲突规则】HTTP 并发必须返回 201+409，实际 ${statuses.join(",")}`);
      const failed = resA.status === 409 ? resA : resB;
      const body = (await failed.json()) as { error: string };
      assert.equal(body.error, "TIME_CONFLICT", "【冲突规则】409 响应必须带 TIME_CONFLICT 错误码");

      const booked = (await (await fetch(`${baseUrl}/bookings`)).json()) as Array<{
        memberId: string;
        chargedAmount: number;
      }>;
      assert.equal(booked.length, 1, "【冲突规则】HTTP 并发后只允许一条预约存在");

      const members = (await (await fetch(`${baseUrl}/members`)).json()) as Member[];
      const alice = members.find((m) => m.id === ALICE)!;
      const bob = members.find((m) => m.id === BOB)!;
      const totalCharged = (500 - alice.balance) + (120 - bob.balance);
      assert.equal(
        totalCharged,
        booked[0].chargedAmount,
        `【扣款规则】两人余额减少总额必须恰好等于唯一订单金额 ${booked[0].chargedAmount}，实际 ${totalCharged}`,
      );
    } finally {
      server.close();
    }
  });
});
