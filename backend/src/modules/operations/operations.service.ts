import { randomUUID } from "node:crypto";
import type { Booking, BookingStatus, Member, Room, Storage } from "../../db/types";
import { intervalsOverlap, quotePrice, round2 } from "../pricing";
import { KeyedMutex } from "../../common/keyed-mutex";

export class BusinessError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** 占用包厢时段的预约状态（失败/已取消不参与冲突判断）。 */
const SLOT_OCCUPYING: BookingStatus[] = ["pending_payment", "booked"];

/** 返回当前占用时段的预约（待支付与已预约），按时间排序。 */
async function listOccupying(storage: Storage): Promise<Booking[]> {
  const groups = await Promise.all(
    SLOT_OCCUPYING.map((status) => storage.listBookings({ status })),
  );
  return groups
    .flat()
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

export class OperationsService {
  /** 每个包厢一把串行锁，保证同包厢「查重-扣款-落单」原子化 */
  private readonly roomLocks = new KeyedMutex();

  constructor(private readonly storage: Storage) {}

  // ---------------- 包厢 ----------------

  async listRooms(): Promise<Room[]> {
    return this.storage.listRooms();
  }

  async setMaintenance(roomId: string, underMaintenance: boolean): Promise<Room> {
    // 与下单共用包厢锁，保证维护标志的写入与下单时锁内的读取可线性化
    const room = await this.roomLocks.runExclusive(roomId, () =>
      this.storage.updateRoomMaintenance(roomId, underMaintenance),
    );
    if (!room) {
      throw new BusinessError(404, "包厢不存在", "ROOM_NOT_FOUND");
    }
    return room;
  }

  // ---------------- 会员 ----------------

  async listMembers(): Promise<Member[]> {
    return this.storage.listMembers();
  }

  async recharge(memberId: string, amount: number): Promise<Member> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BusinessError(400, "充值金额必须是大于 0 的数字", "INVALID_AMOUNT");
    }
    const member = await this.storage.rechargeMember(memberId, round2(amount));
    if (!member) {
      throw new BusinessError(404, "会员不存在", "MEMBER_NOT_FOUND");
    }
    return member;
  }

  /** 试算价格，供前端下单前展示，不产生任何数据变更。 */
  async quote(roomId: string, memberId: string, startTime: string, endTime: string) {
    const { room, member } = await this.requireRoomAndMember(roomId, memberId);
    try {
      const quote = quotePrice(room.hourlyRate, startTime, endTime, member.level);
      return { ...quote, balance: member.balance, affordable: member.balance >= quote.chargedAmount };
    } catch (error) {
      throw new BusinessError(400, (error as Error).message, "INVALID_TIME_RANGE");
    }
  }

  // ---------------- 预约 ----------------

  /**
   * 查询前对账：把崩溃/存储失败遗留的中间态预约修复到一致状态。
   * - pending_payment：从未完成扣款确认 → 若已扣款则幂等退款，置 failed，释放时段；
   * - booked 却已有退款流水：退款已发生而状态漏写 → 置 cancelled。
   * 按包厢分组进各自的锁，绝不影响其他包厢正在进行的请求。
   */
  async reconcileAll(): Promise<void> {
    const [pending, booked] = await Promise.all([
      this.storage.listBookings({ status: "pending_payment" }),
      this.storage.listBookings({ status: "booked" }),
    ]);
    // booked 中只有“已存在退款流水”的才是异常；一次加载会员台账筛出，避免稳态 O(n) 读取
    const refundedIds = await this.bookingIdsWithRefund(booked.map((booking) => booking.id));
    const abnormal = [
      ...pending,
      ...booked.filter((booking) => refundedIds.has(booking.id)),
    ];
    await this.recoverGroupedByRoom(abnormal);
  }

  /** 返回已存在退款流水（kind=refund）的预约 id 集合。 */
  private async bookingIdsWithRefund(bookingIds: string[]): Promise<Set<string>> {
    if (bookingIds.length === 0) {
      return new Set();
    }
    const members = await this.storage.listMembers();
    const refundTxIds = new Set(
      members.flatMap((member) =>
        member.walletTransactions
          .filter((tx) => tx.kind === "refund")
          .map((tx) => tx.id.replace(/:refund$/, "")),
      ),
    );
    return new Set(bookingIds.filter((id) => refundTxIds.has(id)));
  }

  /** 把异常预约按包厢分组，逐包厢在锁内修复。 */
  private async recoverGroupedByRoom(bookings: Booking[]): Promise<void> {
    const byRoom = new Map<string, string[]>();
    for (const booking of bookings) {
      const list = byRoom.get(booking.roomId) ?? [];
      list.push(booking.id);
      byRoom.set(booking.roomId, list);
    }
    for (const [roomId, ids] of byRoom) {
      await this.roomLocks.runExclusive(roomId, () => this.recoverBookings(ids));
    }
  }

  async listBookings(includeCancelled = false): Promise<Booking[]> {
    // 查询即对账：保证“失败后查询时，预约状态、余额和积分一致”
    await this.reconcileAll();
    if (!includeCancelled) {
      return this.storage.listBookings({ status: "booked" });
    }
    const [booked, cancelled] = await Promise.all([
      this.storage.listBookings({ status: "booked" }),
      this.storage.listBookings({ status: "cancelled" }),
    ]);
    return [...booked, ...cancelled].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
  }

  async createBooking(input: {
    roomId: string;
    memberId: string;
    startTime: string;
    endTime: string;
    /** 客户端幂等键：同一请求重试不会重复扣款/重复下单 */
    requestId?: string;
  }): Promise<{ booking: Booking; member: Member }> {
    await this.requireRoomAndMember(input.roomId, input.memberId);
    if (
      Number.isNaN(new Date(input.startTime).getTime()) ||
      Number.isNaN(new Date(input.endTime).getTime()) ||
      new Date(input.endTime) <= new Date(input.startTime)
    ) {
      throw new BusinessError(400, "预约结束时间必须晚于开始时间", "INVALID_TIME_RANGE");
    }

    return this.roomLocks.runExclusive(input.roomId, () =>
      this.createBookingLocked(input.roomId, input.memberId, input.startTime, input.endTime, input.requestId),
    );
  }

  private async createBookingLocked(
    roomId: string,
    memberId: string,
    startTime: string,
    endTime: string,
    requestId?: string,
  ): Promise<{ booking: Booking; member: Member }> {
    // 先修复本包厢遗留的中间态，再开始新交易
    await this.recoverRoomBookings(roomId);

    // 幂等（作用域隔离）：只有 (requestId, memberId, roomId) 完全一致的未结束预约才算同一请求。
    // 不同会员或不同包厢即使复用同一 requestId，也只会落到这里之后的正常下单路径，
    // 绝不可能取回他人/他厅的预约或账户信息。
    if (requestId) {
      const repeated = await this.storage.findLiveBookingByRequest({ requestId, memberId, roomId });
      if (repeated) {
        const recovered = await this.recoverBooking(repeated);
        if (recovered.status === "booked") {
          // 双保险：确认复用的预约确实属于当前会员与包厢（越权数据直接拒绝而非返回）
          if (recovered.memberId !== memberId || recovered.roomId !== roomId) {
            throw new BusinessError(
              409,
              "幂等请求命中了不属于当前会员/包厢的预约，已阻止返回越权数据",
              "IDEMPOTENCY_SCOPE_MISMATCH",
            );
          }
          const member = (await this.storage.getMember(memberId))!;
          return { booking: recovered, member };
        }
        // recovered 为 failed（pending 中途失败且已对账退款）：允许用同一请求键重新发起
      }
    }

    const room = await this.storage.getRoom(roomId);
    if (!room) {
      throw new BusinessError(404, "包厢不存在", "ROOM_NOT_FOUND");
    }
    const member = await this.storage.getMember(memberId);
    if (!member) {
      throw new BusinessError(404, "会员不存在", "MEMBER_NOT_FOUND");
    }

    const quote = quotePrice(room.hourlyRate, startTime, endTime, member.level);

    if (room.underMaintenance) {
      throw new BusinessError(409, `包厢「${room.name}」维护中，暂不接受预约`, "ROOM_IN_MAINTENANCE");
    }

    const existing = await listOccupying(this.storage);
    const conflict = existing.find(
      (booking) =>
        booking.roomId === room.id &&
        intervalsOverlap(booking.startTime, booking.endTime, startTime, endTime),
    );
    if (conflict) {
      throw new BusinessError(
        409,
        `时段与已有预约冲突（${conflict.memberName}：${displayRange(conflict.startTime, conflict.endTime)}）`,
        "TIME_CONFLICT",
      );
    }

    if (member.balance < quote.chargedAmount) {
      throw new BusinessError(
        402,
        `余额不足：本次应付 ￥${quote.chargedAmount}，当前余额 ￥${member.balance}`,
        "INSUFFICIENT_BALANCE",
      );
    }

    // 并发同键双击兜底：插单前在锁内再查一次同一作用域的未结束预约。
    // 第一个请求可能已插入 pending（尚未 booked），此时第二个请求必须复用它而不是再建一单、再扣一次款。
    if (requestId) {
      const racing = await this.storage.findLiveBookingByRequest({ requestId, memberId, roomId });
      if (racing) {
        const recovered = await this.recoverBooking(racing);
        if (recovered.status === "booked") {
          const latestMember = await this.storage.getMember(memberId);
          return { booking: recovered, member: latestMember ?? member };
        }
        // 对方的同键交易仍在途或已失败：不再另建单，按冲突拒绝（无资金变动），客户端可稍后用同键重试
        throw new BusinessError(
          409,
          "同一预约请求正在处理中，请勿重复提交",
          "IDEMPOTENCY_REQUEST_IN_FLIGHT",
        );
      }
    }

    // 先落一笔 pending_payment 预约（此刻尚未扣款），让整个交易可被对账恢复
    const bookingId = randomUUID();
    const booking: Booking = {
      id: bookingId,
      requestId,
      roomId: room.id,
      roomName: room.name,
      memberId: member.id,
      memberName: member.name,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      baseAmount: quote.baseAmount,
      chargedAmount: quote.chargedAmount,
      pointsEarned: quote.pointsEarned,
      level: member.level,
      status: "pending_payment",
      createdAt: new Date().toISOString(),
    };
    try {
      await this.storage.insertBooking(booking); // 扣款前写入；若失败直接抛错，未发生任何资金变动
    } catch (error) {
      // 多实例并发同键重试时，可能由数据库唯一约束（requestId,memberId,roomId）拦下：
      // 转回幂等查找，复用已存在的同一请求预约，而不是重复扣款。
      if (isDuplicateKeyError(error) && requestId) {
        const winner = await this.storage.findLiveBookingByRequest({ requestId, memberId, roomId });
        if (winner) {
          const recovered = await this.recoverBooking(winner);
          if (recovered.status === "booked") {
            const latestMember = await this.storage.getMember(memberId);
            return { booking: recovered, member: latestMember ?? member };
          }
        }
      }
      throw error;
    }

    // 幂等扣款（余额条件 + 流水在存储层一次原子写入）
    const chargeId = `${bookingId}:charge`;
    let chargeResult;
    try {
      chargeResult = await this.storage.applyWalletTransaction(member.id, {
        id: chargeId,
        kind: "charge",
        amount: quote.chargedAmount,
        pointsDelta: quote.pointsEarned,
      });
    } catch (error) {
      // 扣款写入本身失败：钱不可能已扣（存储层原子写入）。把 pending 收尾为 failed；
      // 若这一步也写失败，留给查询/重试时的对账，绝不允许一直占用时段。
      await this.storage
        .setBookingStatus(bookingId, ["pending_payment"], "failed")
        .catch(() => undefined);
      throw new BusinessError(
        500,
        "扣款写入失败，预约未生效，请重试；系统会自动对账确保不扣款",
        "WALLET_CHARGE_FAILED",
      );
    }

    if (chargeResult.outcome === "insufficient") {
      await this.storage.setBookingStatus(bookingId, ["pending_payment"], "failed");
      throw new BusinessError(
        402,
        `余额不足：本次应付 ￥${quote.chargedAmount}`,
        "INSUFFICIENT_BALANCE",
      );
    }
    if (chargeResult.outcome === "member_not_found") {
      await this.storage.setBookingStatus(bookingId, ["pending_payment"], "failed");
      throw new BusinessError(404, "会员不存在", "MEMBER_NOT_FOUND");
    }
    // applied / duplicate 都意味着“这笔钱已经在台账里”，继续确认预约

    let confirmed: boolean;
    try {
      confirmed = await this.storage.setBookingStatus(bookingId, ["pending_payment"], "booked");
    } catch (error) {
      // 确认写入本身失败：尝试幂等回补；回补也失败时交给对账（查询/重试时收敛）
      await this.safeCompensate(bookingId, member.id, quote.chargedAmount, quote.pointsEarned);
      throw new BusinessError(
        500,
        "预约确认写入失败，系统将自动对账退款，请稍后查询或重试",
        "WALLET_SETTLE_FAILED",
      );
    }

    if (!confirmed) {
      // CAS 未命中：状态已不是 pending —— 走对账逻辑确定最终状态
      const recovered = await this.recoverBooking((await this.storage.getBooking(bookingId))!);
      const latestMember = await this.storage.getMember(member.id);
      if (recovered.status !== "booked") {
        throw new BusinessError(
          409,
          "预约未能确认，扣款已原路退回储值余额",
          "BOOKING_SETTLE_COMPENSATED",
        );
      }
      return { booking: recovered, member: latestMember ?? chargeResult.member };
    }

    const latestMember = await this.storage.getMember(member.id);
    return {
      booking: { ...booking, status: "booked" },
      member: latestMember ?? chargeResult.member,
    };
  }

  /** 取消预约：先写幂等退款流水，再把 booked 迁移为 cancelled，杜绝“已取消但未退款”。 */
  async cancelBooking(bookingId: string): Promise<{ booking: Booking; member: Member }> {
    const preview = await this.storage.getBooking(bookingId);
    if (!preview) {
      throw new BusinessError(404, "预约不存在", "BOOKING_NOT_FOUND");
    }
    return this.roomLocks.runExclusive(preview.roomId, () => this.cancelBookingLocked(bookingId));
  }

  private async cancelBookingLocked(
    bookingId: string,
  ): Promise<{ booking: Booking; member: Member }> {
    await this.recoverRoomBookings((await this.storage.getBooking(bookingId))?.roomId ?? "");

    const booking = await this.storage.getBooking(bookingId);
    if (!booking) {
      throw new BusinessError(404, "预约不存在", "BOOKING_NOT_FOUND");
    }

    if (booking.status === "cancelled") {
      throw new BusinessError(409, "该预约已取消，不能重复取消", "BOOKING_ALREADY_CANCELLED");
    }
    if (booking.status === "failed") {
      throw new BusinessError(409, "该预约已失败并退款，无需取消", "BOOKING_ALREADY_FAILED");
    }
    if (booking.status === "pending_payment") {
      // 待支付中间态：对账补偿（已扣则退款），置 failed
      const recovered = await this.recoverBooking(booking);
      const member = (await this.storage.getMember(booking.memberId))!;
      return { booking: recovered, member };
    }

    // 先退款（幂等：重复取消/重试时第二次起为 duplicate，资金只动一次）
    const refund = await this.storage.applyWalletTransaction(booking.memberId, {
      id: `${bookingId}:refund`,
      kind: "refund",
      amount: booking.chargedAmount,
      pointsDelta: -booking.pointsEarned,
      linkedTransactionId: `${bookingId}:charge`,
    });
    if (refund.outcome === "member_not_found") {
      throw new BusinessError(404, "预约关联的会员不存在，退款失败", "MEMBER_NOT_FOUND");
    }
    if (refund.outcome === "no_linked_charge") {
      // booked 却找不到扣款流水属于资金不变量被破坏：不允许假装取消成功
      throw new BusinessError(
        500,
        "预约缺少对应扣款记录，已阻止取消以保护余额，请人工核对",
        "WALLET_LEDGER_INCONSISTENT",
      );
    }

    // 退款入账后再置 cancelled。若这步失败：钱已退、状态仍 booked，
    // 重试时退款为 duplicate，CAS 重新执行；查询对账也会据退款流水把状态修正为 cancelled。
    let changed: boolean;
    try {
      changed = await this.storage.setBookingStatus(bookingId, ["booked"], "cancelled");
    } catch {
      throw new BusinessError(
        500,
        "退款已入账但取消状态写入失败，重试或等待系统对账即可一致",
        "CANCEL_STATUS_WRITE_FAILED",
      );
    }

    if (!changed) {
      const current = await this.storage.getBooking(bookingId);
      if (current?.status === "cancelled") {
        const member = (await this.storage.getMember(booking.memberId)) ?? refund.member;
        return { booking: current, member };
      }
      throw new BusinessError(409, "预约状态已变化，请刷新后重试", "BOOKING_STATE_CHANGED");
    }

    const member = (await this.storage.getMember(booking.memberId)) ?? refund.member;
    return { booking: { ...booking, status: "cancelled" }, member };
  }

  // ---------------- 对账恢复 ----------------

  private async recoverRoomBookings(roomId: string): Promise<void> {
    if (!roomId) {
      return;
    }
    const [pending, booked] = await Promise.all([
      this.storage.listBookings({ status: "pending_payment" }),
      this.storage.listBookings({ status: "booked" }),
    ]);
    const inRoom = [...pending, ...booked].filter((booking) => booking.roomId === roomId);
    const refundedIds = await this.bookingIdsWithRefund(
      inRoom.map((booking) => booking.id),
    );
    const abnormal = inRoom.filter(
      (booking) =>
        booking.status === "pending_payment" || refundedIds.has(booking.id),
    );
    await this.recoverBookings(abnormal.map((booking) => booking.id));
  }

  private async recoverBookings(ids: string[]): Promise<void> {
    for (const id of ids) {
      const booking = await this.storage.getBooking(id);
      if (booking) {
        await this.recoverBooking(booking);
      }
    }
  }

  /**
   * 把单笔预约修复到资金一致的状态（必须在对应包厢锁内调用）。
   * 不变量：
   *   booked     ⇔ 有 charge 无 refund
   *   cancelled  ⇔ 有 charge 有 refund
   *   failed     ⇔ 无 charge，或 charge 已被 refund 抵消
   */
  private async recoverBooking(booking: Booking): Promise<Booking> {
    const member = await this.storage.getMember(booking.memberId);
    if (!member) {
      return booking;
    }
    const txs = member.walletTransactions;
    const chargeId = `${booking.id}:charge`;
    const refundId = `${booking.id}:refund`;
    const hasCharge = txs.some((tx) => tx.id === chargeId && tx.kind === "charge");
    const hasRefund = txs.some((tx) => tx.id === refundId && tx.kind === "refund");

    if (booking.status === "pending_payment") {
      // 未完成的在途交易：有扣款就幂等退回，然后置 failed 释放时段
      if (hasCharge && !hasRefund) {
        await this.storage.applyWalletTransaction(member.id, {
          id: refundId,
          kind: "refund",
          amount: booking.chargedAmount,
          pointsDelta: -booking.pointsEarned,
          linkedTransactionId: chargeId,
        });
      }
      await this.storage.setBookingStatus(booking.id, ["pending_payment"], "failed");
      return (await this.storage.getBooking(booking.id)) ?? { ...booking, status: "failed" };
    }

    if (booking.status === "failed" && hasCharge && !hasRefund) {
      await this.storage.applyWalletTransaction(member.id, {
        id: refundId,
        kind: "refund",
        amount: booking.chargedAmount,
        pointsDelta: -booking.pointsEarned,
        linkedTransactionId: chargeId,
      });
      return booking;
    }

    if (booking.status === "booked" && hasRefund) {
      // 退款已入账但状态漏写（取消时 CAS 失败）：补写 cancelled
      await this.storage.setBookingStatus(booking.id, ["booked"], "cancelled");
      return (await this.storage.getBooking(booking.id)) ?? { ...booking, status: "cancelled" };
    }

    if (booking.status === "cancelled" && hasCharge && !hasRefund) {
      // 状态先落而退款漏写：补退款（题目要求禁止的状态）
      await this.storage.applyWalletTransaction(member.id, {
        id: refundId,
        kind: "refund",
        amount: booking.chargedAmount,
        pointsDelta: -booking.pointsEarned,
        linkedTransactionId: chargeId,
      });
    }

    return (await this.storage.getBooking(booking.id)) ?? booking;
  }

  /** 扣款已发生后确认失败时的尽力补偿；补偿失败不抛错，留给对账收敛。 */
  private async safeCompensate(
    bookingId: string,
    memberId: string,
    amount: number,
    points: number,
  ): Promise<void> {
    try {
      await this.storage.applyWalletTransaction(memberId, {
        id: `${bookingId}:refund`,
        kind: "refund",
        amount,
        pointsDelta: -points,
        linkedTransactionId: `${bookingId}:charge`,
      });
      await this.storage.setBookingStatus(bookingId, ["pending_payment", "booked"], "failed");
    } catch {
      // 下一次查询/重试的 reconcileAll 会继续修复
    }
  }

  private async requireRoomAndMember(roomId: string, memberId: string) {
    const room = await this.storage.getRoom(roomId);
    if (!room) {
      throw new BusinessError(404, "包厢不存在", "ROOM_NOT_FOUND");
    }
    const member = await this.storage.getMember(memberId);
    if (!member) {
      throw new BusinessError(404, "会员不存在", "MEMBER_NOT_FOUND");
    }
    return { room, member };
  }
}

function displayRange(startTime: string, endTime: string): string {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${fmt.format(new Date(startTime))} - ${fmt.format(new Date(endTime))}`;
}

/** 识别 MongoDB 唯一约束冲突（错误码 11000）。 */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
