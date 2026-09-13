/**
 * 存储失败下的资金一致性回归组（确定性故障注入，可重复运行）。
 *
 * 覆盖两类题目要求的故障，并验证“失败后重试或查询时”状态、余额、积分收敛一致：
 *  A. 取消时退款写入失败        —— 不允许“已取消但未退款”
 *  B. 下单确认失败且补偿也失败  —— 不允许“已扣款却没有预约”
 *
 * 每条断言都带【不变量】前缀，失败时直接指出被破坏的资金/预约规则。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { BusinessError, OperationsService } from "../src/modules/operations/operations.service";
import { createApp } from "../src/app";
import { FaultyStorage } from "./faulty-storage";
import { MemoryStorage } from "./memory-storage";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";
import type { Booking, Member, Storage } from "../src/db/types";

const ROOM_STRATEGY = "seed-room-strategy";
const ALICE = "seed-member-alice";
const BOB = "seed-member-bob";
const SLOT_10_12 = { startTime: "2026-10-20T10:00:00+08:00", endTime: "2026-10-20T12:00:00+08:00" };

const SEED_STATE: Record<string, { balance: number; points: number }> = Object.fromEntries(
  SEED_MEMBERS.map((m) => [m.id, { balance: m.balance, points: m.points }]),
);

function faultyService(config: ConstructorParameters<typeof FaultyStorage>[0]) {
  const storage = new FaultyStorage(config).withSeed(
    SEED_ROOMS.map((room) => ({ ...room })),
    SEED_MEMBERS.map((member) => ({ ...member })),
  );
  return { storage, service: new OperationsService(storage) };
}

/**
 * 资金一致性不变量（静止状态下逐条预约核对台账）：
 * - cancelled：恰好一条 charge + 一条 refund，金额积分对冲
 * - booked：恰好一条 charge，无 refund
 * - failed：无净扣款（无 charge，或 charge 与 refund 都在）
 * - 不存在 pending_payment 残留
 * - 会员余额/积分 = 初始值 + 全部流水代数和（台账即真相）
 */
async function assertConsistency(storage: Storage) {
  const bookings = await storage.listBookings();
  const members = await storage.listMembers();

  for (const booking of bookings) {
    const member = members.find((m) => m.id === booking.memberId);
    assert.ok(member, `【台账不变量】预约 ${booking.id} 的会员必须存在`);
    const charges = member.walletTransactions.filter((tx) => tx.id === `${booking.id}:charge`);
    const refunds = member.walletTransactions.filter((tx) => tx.id === `${booking.id}:refund`);

    if (booking.status === "booked") {
      assert.equal(charges.length, 1, `【台账不变量】已预约 ${booking.id} 必须恰好有一条扣款流水`);
      assert.ok(
        charges[0].amount === booking.chargedAmount && charges[0].pointsDelta === booking.pointsEarned,
        `【台账不变量】扣款金额/积分必须与订单一致：${booking.id}`,
      );
      assert.equal(refunds.length, 0, `【预约不变量】已预约 ${booking.id} 不得有退款流水`);
    } else if (booking.status === "cancelled") {
      assert.equal(charges.length, 1, `【台账不变量】已取消预约 ${booking.id} 必须先有一条扣款`);
      assert.equal(refunds.length, 1, `【资金不变量】已取消预约 ${booking.id} 必须恰好有一条退款，禁止已取消未退款`);
      assert.equal(
        refunds[0].amount,
        booking.chargedAmount,
        `【资金不变量】退款 ${booking.id} 必须等于原实付额`,
      );
      assert.equal(
        refunds[0].pointsDelta,
        -booking.pointsEarned,
        `【资金不变量】退款 ${booking.id} 必须等额回退积分`,
      );
      assert.equal(
        refunds[0].linkedTransactionId,
        `${booking.id}:charge`,
        `【台账不变量】退款 ${booking.id} 必须指向对应扣款，禁止凭空退款`,
      );
    } else if (booking.status === "failed") {
      // failed 可能从未扣款（扣款写入失败/余额不足），也可能扣了又全额补偿
      assert.ok(charges.length <= 1, `【资金不变量】失败预约 ${booking.id} 至多一条扣款`);
      if (charges.length === 1) {
        assert.equal(refunds.length, 1, `【资金不变量】已扣款的失败预约 ${booking.id} 必须有全额补偿退款`);
        assert.equal(
          refunds[0].amount,
          booking.chargedAmount,
          `【资金不变量】失败预约 ${booking.id} 的补偿退款必须全额`,
        );
      } else {
        assert.equal(refunds.length, 0, `【资金不变量】未扣款的失败预约 ${booking.id} 不得有退款`);
      }
    } else {
      assert.fail(`【预约不变量】静止状态不允许残留 ${booking.status}：${booking.id}`);
    }
  }

  for (const member of members) {
    const seed = SEED_STATE[member.id];
    if (!seed) {
      continue;
    }
    const charged = member.walletTransactions
      .filter((tx) => tx.kind === "charge")
      .reduce((sum, tx) => sum + tx.amount, 0);
    const refunded = member.walletTransactions
      .filter((tx) => tx.kind === "refund")
      .reduce((sum, tx) => sum + tx.amount, 0);
    const pointsFromTx = member.walletTransactions.reduce((sum, tx) => sum + tx.pointsDelta, 0);
    assert.equal(
      member.balance,
      Math.round((seed.balance - charged + refunded) * 100) / 100,
      `【余额不变量】会员 ${member.name} 余额必须等于台账轧差结果`,
    );
    assert.equal(
      member.points,
      seed.points + pointsFromTx,
      `【积分不变量】会员 ${member.name} 积分必须等于台账累计结果`,
    );
  }
}

async function bookAlice(service: OperationsService) {
  // gold 8 折 2h：实付 96、积分 96
  return service.createBooking({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 });
}

// ---------------------------------------------------------------------------
describe("A. 取消时退款写入失败：禁止已取消但未退款", () => {
  test("退款流水首次写入抛错：预约保持 booked、钱不动；重试后取消成功且只退一次", async () => {
    const { storage, service } = faultyService({
      applyWalletTransaction: { kind: "refund", failTimes: 1 },
    });
    const created = await bookAlice(service);
    assert.equal(storage.faultCount("applyWalletTransaction"), 0);

    // 第一次取消：退款写入失败 → 500，且不得把状态改成 cancelled
    await assert.rejects(
      service.cancelBooking(created.booking.id),
      (error: unknown) => error instanceof Error,
      "【资金不变量】退款写入失败时取消必须报错，而不是假装成功",
    );
    assert.equal(storage.faultCount("applyWalletTransaction"), 1, "故障必须确实被触发一次");

    const stuck = await storage.getBooking(created.booking.id);
    assert.equal(stuck?.status, "booked", "【预约不变量】退款失败后预约必须仍是 booked，禁止已取消未退款");
    const aliceUnchanged = await storage.getMember(ALICE);
    assert.equal(aliceUnchanged.balance, 404, "【余额不变量】退款失败不得改动余额");
    assert.equal(aliceUnchanged.points, 416, "【积分不变量】退款失败不得改动积分");

    // 重试取消（存储已恢复）：退款成功、状态取消
    const retried = await service.cancelBooking(created.booking.id);
    assert.equal(retried.booking.status, "cancelled");
    assert.equal(retried.member.balance, 500, "【资金不变量】重试后余额恢复 500");
    assert.equal(retried.member.points, 320, "【资金不变量】重试后积分恢复 320");

    const refunds = retried.member.walletTransactions.filter((tx) => tx.kind === "refund");
    assert.equal(refunds.length, 1, "【资金不变量】失败+重试全过程只能有一条退款（失败的写入未生效）");
    await assertConsistency(storage);
  });

  test("退款已入账但取消状态写入抛错：查询对账自动补成 cancelled，再次取消幂等不重复退款", async () => {
    const { storage, service } = faultyService({
      setBookingStatus: { to: "cancelled", failTimes: 1 },
    });
    const created = await bookAlice(service);

    // 退款成功、CAS 到 cancelled 失败 → 报错；此时钱已退、状态仍 booked
    await assert.rejects(
      service.cancelBooking(created.booking.id),
      (error: unknown) => error instanceof Error,
    );
    const interim = await storage.getBooking(created.booking.id);
    assert.equal(interim?.status, "booked", "故障瞬间状态写入未成功，仍为 booked");
    const interimMember = await storage.getMember(ALICE);
    assert.equal(interimMember.balance, 500, "退款流水已写入，余额已回补");

    // 失败后查询：reconcile 发现 booked 已有退款，自动补写 cancelled
    const visible = await service.listBookings(true);
    const reconciled = visible.find((b) => b.id === created.booking.id);
    assert.equal(reconciled?.status, "cancelled", "【预约不变量】查询对账必须把“已退款未取消”收敛为 cancelled");
    assert.equal(
      visible.filter((b) => b.status === "booked").length,
      0,
      "对账后该预约不得还出现在进行中列表",
    );

    // 再次取消：预约已被对账修正为 cancelled，按重复取消返回 409，且钱只退一次
    await assert.rejects(
      service.cancelBooking(created.booking.id),
      (error: unknown) => error instanceof BusinessError && error.code === "BOOKING_ALREADY_CANCELLED",
      "【取消规则】对账取消后再次取消必须按重复取消拒绝",
    );
    const aliceFinal = await storage.getMember(ALICE);
    assert.equal(aliceFinal.balance, 500, "【资金不变量】重复取消不得二次退款");
    assert.equal(aliceFinal.points, 320);
    assert.equal(aliceFinal.walletTransactions.filter((tx) => tx.kind === "refund").length, 1);
    await assertConsistency(storage);
  });

  test("HTTP：取消首次 500、客户端重试 200，最终只退一次款", async () => {
    const storage = new FaultyStorage({
      applyWalletTransaction: { kind: "refund", failTimes: 1 },
    }).withSeed(
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
      const created = await fetch(`${baseUrl}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: ROOM_STRATEGY, memberId: ALICE, ...SLOT_10_12 }),
      });
      const body = (await created.json()) as { booking: Booking };
      const id = body.booking.id;

      const first = await fetch(`${baseUrl}/bookings/${id}/cancel`, { method: "POST" });
      assert.equal(first.status, 500, "退款写入失败必须返回 5xx，不能假装 200");

      const retry = await fetch(`${baseUrl}/bookings/${id}/cancel`, { method: "POST" });
      assert.equal(retry.status, 200, "存储恢复后重试必须成功");
      const result = (await retry.json()) as { booking: Booking; member: Member };
      assert.equal(result.booking.status, "cancelled");
      assert.equal(result.member.balance, 500);
      assert.equal(result.member.points, 320);
      assert.equal(result.member.walletTransactions.filter((tx) => tx.kind === "refund").length, 1);

      const duplicate = await fetch(`${baseUrl}/bookings/${id}/cancel`, { method: "POST" });
      assert.equal(duplicate.status, 409, "第三次取消必须按重复取消拒绝");
      await assertConsistency(storage);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe("B. 下单写入失败且回补也失败：禁止已扣款却没有预约", () => {
  test("扣款写入抛错：不产生流水、预约置 failed、时段释放，重试下单只扣一次", async () => {
    const { storage, service } = faultyService({
      applyWalletTransaction: { kind: "charge", failTimes: 1 },
    });

    await assert.rejects(
      bookAlice(service),
      (error: unknown) => error instanceof BusinessError && error.code === "WALLET_CHARGE_FAILED",
      "【资金不变量】扣款写入失败必须明确报错",
    );

    const alice = await storage.getMember(ALICE);
    assert.equal(alice.balance, 500, "【余额不变量】扣款写入失败时钱不得被扣");
    assert.equal(alice.points, 320, "【积分不变量】扣款写入失败时积分不得增加");
    assert.equal(
      alice.walletTransactions.filter((tx) => tx.kind === "charge").length,
      0,
      "【台账不变量】失败的扣款写入不得留下流水",
    );
    // 查询触发对账：pending 被收敛为 failed
    const active = await service.listBookings();
    assert.equal(active.length, 0, "【预约不变量】扣款失败的预约不得占用时段");

    // 存储恢复后重新下单同一时段：成功且只扣一次
    const retry = await bookAlice(service);
    assert.equal(retry.booking.status, "booked");
    assert.equal(retry.member.balance, 404);
    assert.equal(retry.member.points, 416);
    assert.equal(retry.member.walletTransactions.filter((tx) => tx.kind === "charge").length, 1);
    await assertConsistency(storage);
  });

  test("pending 落库失败：尚未扣款，直接报错且零资金变动、零预约", async () => {
    const { storage, service } = faultyService({ insertBooking: { failTimes: 1 } });

    await assert.rejects(bookAlice(service), (error: unknown) => error instanceof Error);
    const alice = await storage.getMember(ALICE);
    assert.equal(alice.balance, 500, "【余额不变量】预约落库失败发生在扣款之前，不得扣款");
    assert.equal(alice.points, 320);
    assert.equal(alice.walletTransactions.length, 0);
    assert.equal((await service.listBookings()).length, 0);

    // 恢复后可正常下单
    const retry = await bookAlice(service);
    assert.equal(retry.booking.status, "booked");
    await assertConsistency(storage);
  });

  test("确认 booked 失败且补偿置 failed 也失败：查询/重试自动对账，退款一次、时段释放", async () => {
    // 故障序列：第 1 次 setBookingStatus（pending→booked 确认）失败，
    // 第 2 次（补偿 pending/booked→failed）也失败；第 3 次起恢复（对账时成功）。
    const { storage, service } = faultyService({ setBookingStatus: { failTimes: 2 } });
    const createdPromise = bookAlice(service);

    await assert.rejects(
      createdPromise,
      (error: unknown) => error instanceof BusinessError && error.code === "WALLET_SETTLE_FAILED",
      "【资金不变量】确认失败必须报错，不能返回一个并未生效的预约",
    );

    // 此刻：钱已扣、补偿已尝试（退款流水已写入），但预约仍是 pending（两次状态写入都失败）
    const pendingBookings = await storage.listBookings({ status: "pending_payment" });
    assert.equal(pendingBookings.length, 1, "故障瞬间保留 pending 中间态，等待对账");
    const interimAlice = await storage.getMember(ALICE);
    assert.equal(
      interimAlice.balance,
      500,
      "【资金不变量】确认失败后补偿退款必须已把余额退回（即使状态写失败）",
    );
    assert.equal(interimAlice.points, 320, "【积分不变量】补偿必须已回退积分");
    const charges = interimAlice.walletTransactions.filter((tx) => tx.kind === "charge");
    const refunds = interimAlice.walletTransactions.filter((tx) => tx.kind === "refund");
    assert.equal(charges.length, 1);
    assert.equal(refunds.length, 1, "补偿退款必须恰好一条");

    // 失败后查询：reconcile 把 pending（已有退款）收敛为 failed，时段释放
    const active = await service.listBookings();
    assert.equal(active.length, 0, "【预约不变量】对账后不得留下已扣款却无预约的占用");
    const failed = await storage.listBookings({ status: "failed" });
    assert.equal(failed.length, 1);

    // 另一会员预订同一时段必须成功（时段确实释放）
    const rebook = await service.createBooking({
      roomId: ROOM_STRATEGY,
      memberId: BOB,
      ...SLOT_10_12,
    });
    assert.equal(rebook.booking.status, "booked", "【预约不变量】对账释放时段后应允许重新预约");
    assert.equal(rebook.member.balance, 120 - rebook.booking.chargedAmount);

    const alice = await storage.getMember(ALICE);
    assert.equal(alice.balance, 500, "【资金不变量】林小鹿最终余额必须完整恢复");
    assert.equal(alice.points, 320);
    assert.equal(alice.walletTransactions.filter((tx) => tx.kind === "refund").length, 1, "禁止重复退款");
    await assertConsistency(storage);
  });
});

// ---------------------------------------------------------------------------
describe("C. 进程崩溃遗留状态：启动/查询对账收敛", () => {
  test("遗留 pending 且已扣款（模拟崩溃在确认前）：对账幂等退款并置 failed", async () => {
    const storage = new MemoryStorage().withSeed(
      SEED_ROOMS.map((room) => ({ ...room })),
      SEED_MEMBERS.map((member) => ({ ...member })),
    );
    const service = new OperationsService(storage);

    // 手工构造崩溃现场：pending 预约 + 已扣款流水
    const bookingId = "crashed-pending-booking";
    await storage.insertBooking({
      id: bookingId,
      roomId: ROOM_STRATEGY,
      roomName: "策略大师厅",
      memberId: ALICE,
      memberName: "林小鹿",
      ...SLOT_10_12,
      baseAmount: 120,
      chargedAmount: 96,
      pointsEarned: 96,
      level: "gold",
      status: "pending_payment",
      createdAt: new Date().toISOString(),
    });
    const charged = await storage.applyWalletTransaction(ALICE, {
      id: `${bookingId}:charge`,
      kind: "charge",
      amount: 96,
      pointsDelta: 96,
    });
    assert.equal(charged.outcome, "applied");

    // 模拟进程重启后的启动对账
    await service.reconcileAll();

    const recovered = await storage.getBooking(bookingId);
    assert.equal(recovered?.status, "failed", "【预约不变量】崩溃遗留的 pending 必须收敛为 failed");
    const alice = await storage.getMember(ALICE);
    assert.equal(alice.balance, 500, "【资金不变量】对账退款后余额恢复");
    assert.equal(alice.points, 320);
    assert.equal(alice.walletTransactions.filter((tx) => tx.kind === "refund").length, 1);

    // 对账幂等：再跑一次不重复退款
    await service.reconcileAll();
    const aliceAgain = await storage.getMember(ALICE);
    assert.equal(aliceAgain.balance, 500, "【资金不变量】重复对账不得二次退款");
    assert.equal(aliceAgain.walletTransactions.filter((tx) => tx.kind === "refund").length, 1);
    await assertConsistency(storage);
  });

  test("遗留 booked 但退款已入账（模拟崩溃在取消状态写入前）：查询补写 cancelled", async () => {
    const storage = new MemoryStorage().withSeed(
      SEED_ROOMS.map((room) => ({ ...room })),
      SEED_MEMBERS.map((member) => ({ ...member })),
    );
    const service = new OperationsService(storage);
    const created = await bookAlice(service);

    // 手工制造“钱已退、状态漏写”的崩溃现场（直接写退款流水，绕过状态迁移）
    const directRefund = await storage.applyWalletTransaction(ALICE, {
      id: `${created.booking.id}:refund`,
      kind: "refund",
      amount: 96,
      pointsDelta: -96,
      linkedTransactionId: `${created.booking.id}:charge`,
    });
    assert.equal(directRefund.outcome, "applied");
    assert.equal((await storage.getBooking(created.booking.id))?.status, "booked");

    // 查询即对账：修正为 cancelled，且不进行任何额外资金操作
    const all = await service.listBookings(true);
    const fixed = all.find((b) => b.id === created.booking.id);
    assert.equal(fixed?.status, "cancelled", "【预约不变量】已退款的 booked 必须被对账修正为 cancelled");
    const alice = await storage.getMember(ALICE);
    assert.equal(alice.balance, 500);
    assert.equal(alice.points, 320);
    assert.equal(alice.walletTransactions.filter((tx) => tx.kind === "refund").length, 1);
    await assertConsistency(storage);
  });
});

// ---------------------------------------------------------------------------
describe("D. 台账幂等原语", () => {
  test("同一流水 id 重复扣款只生效一次；无对应扣款的退款被拒绝", async () => {
    const storage = new MemoryStorage().withSeed(
      SEED_ROOMS.map((room) => ({ ...room })),
      SEED_MEMBERS.map((member) => ({ ...member })),
    );

    const first = await storage.applyWalletTransaction(ALICE, {
      id: "tx-x:charge",
      kind: "charge",
      amount: 96,
      pointsDelta: 96,
    });
    assert.equal(first.outcome, "applied");

    const duplicate = await storage.applyWalletTransaction(ALICE, {
      id: "tx-x:charge",
      kind: "charge",
      amount: 96,
      pointsDelta: 96,
    });
    assert.equal(duplicate.outcome, "duplicate", "【台账不变量】重复扣款必须幂等忽略");
    if (duplicate.outcome === "duplicate") {
      assert.equal(duplicate.member.balance, 404, "【资金不变量】幂等重复不得二次扣款");
      assert.equal(duplicate.member.points, 416);
    }

    const orphanRefund = await storage.applyWalletTransaction(ALICE, {
      id: "tx-y:refund",
      kind: "refund",
      amount: 96,
      pointsDelta: -96,
      linkedTransactionId: "nonexistent:charge",
    });
    assert.equal(orphanRefund.outcome, "no_linked_charge", "【台账不变量】必须拒绝无对应扣款的退款");
    if (orphanRefund.outcome === "no_linked_charge") {
      assert.equal(orphanRefund.member.balance, 404, "【资金不变量】拒绝时不得加钱");
    }

    const insufficient = await storage.applyWalletTransaction(BOB, {
      id: "tx-z:charge",
      kind: "charge",
      amount: 158.4,
      pointsDelta: 158,
    });
    assert.equal(insufficient.outcome, "insufficient", "【余额规则】余额不足必须拒绝且不写流水");
    if (insufficient.outcome === "insufficient") {
      assert.equal(insufficient.member.balance, 120);
    }
  });
});
