import { randomUUID } from "node:crypto";
import type { Booking, Member, Room, Storage } from "../../db/types";
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

  async listBookings(includeCancelled = false): Promise<Booking[]> {
    return this.storage.listBookings(includeCancelled ? undefined : { status: "booked" });
  }

  async createBooking(input: {
    roomId: string;
    memberId: string;
    startTime: string;
    endTime: string;
  }): Promise<{ booking: Booking; member: Member }> {
    // 资源存在性与时间格式可以在锁外校验，不改变竞争结果
    await this.requireRoomAndMember(input.roomId, input.memberId);
    if (
      Number.isNaN(new Date(input.startTime).getTime()) ||
      Number.isNaN(new Date(input.endTime).getTime()) ||
      new Date(input.endTime) <= new Date(input.startTime)
    ) {
      throw new BusinessError(400, "预约结束时间必须晚于开始时间", "INVALID_TIME_RANGE");
    }

    // 同一包厢的「查重 -> 扣款 -> 落单」必须串行：
    // 并发预订同一包厢时，后进入临界区的请求一定能看到前一个已插入的预约，从而被冲突/余额规则拒绝。
    return this.roomLocks.runExclusive(input.roomId, () =>
      this.createBookingLocked(input.roomId, input.memberId, input.startTime, input.endTime),
    );
  }

  private async createBookingLocked(
    roomId: string,
    memberId: string,
    startTime: string,
    endTime: string,
  ): Promise<{ booking: Booking; member: Member }> {
    // 锁内重读，确保维护状态、小时价、会员等级与余额都是最新快照
    const room = await this.storage.getRoom(roomId);
    if (!room) {
      throw new BusinessError(404, "包厢不存在", "ROOM_NOT_FOUND");
    }
    const member = await this.storage.getMember(memberId);
    if (!member) {
      throw new BusinessError(404, "会员不存在", "MEMBER_NOT_FOUND");
    }

    const quote = quotePrice(room.hourlyRate, startTime, endTime, member.level);

    // 规则 1：维护中的包厢拒绝预约（以锁内最新状态为准）
    if (room.underMaintenance) {
      throw new BusinessError(409, `包厢「${room.name}」维护中，暂不接受预约`, "ROOM_IN_MAINTENANCE");
    }

    // 规则 2：同一包厢时间重叠拒绝预约（半开区间，首尾相接允许）
    const existing = await this.storage.listBookings({ status: "booked" });
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

    // 规则 3：余额不足拒绝预约（存储层条件更新再做一次原子兜底，防止任何路径下透支）
    if (member.balance < quote.chargedAmount) {
      throw new BusinessError(
        402,
        `余额不足：本次应付 ￥${quote.chargedAmount}，当前余额 ￥${member.balance}`,
        "INSUFFICIENT_BALANCE",
      );
    }
    const chargedMember = await this.storage.chargeMember(
      member.id,
      quote.chargedAmount,
      quote.pointsEarned,
    );
    if (!chargedMember) {
      throw new BusinessError(
        402,
        `余额不足：本次应付 ￥${quote.chargedAmount}，当前余额 ￥${member.balance}`,
        "INSUFFICIENT_BALANCE",
      );
    }

    const now = new Date().toISOString();
    const booking: Booking = {
      id: randomUUID(),
      roomId: room.id,
      roomName: room.name,
      memberId: chargedMember.id,
      memberName: chargedMember.name,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      baseAmount: quote.baseAmount,
      chargedAmount: quote.chargedAmount,
      pointsEarned: quote.pointsEarned,
      level: chargedMember.level,
      status: "booked",
      createdAt: now,
    };

    try {
      await this.storage.insertBooking(booking);
    } catch (error) {
      // 预约落库失败时回补已扣款项，避免吞钱
      await this.storage.refundMember(chargedMember.id, quote.chargedAmount, -quote.pointsEarned);
      throw error;
    }

    const refreshedMember = (await this.storage.getMember(chargedMember.id)) ?? chargedMember;
    return { booking, member: refreshedMember };
  }

  /** 取消预约：状态置为 cancelled，余额与积分按预约时扣款额原样回退。 */
  async cancelBooking(bookingId: string): Promise<{ booking: Booking; member: Member }> {
    const booking = await this.storage.getBooking(bookingId);
    if (!booking) {
      throw new BusinessError(404, "预约不存在", "BOOKING_NOT_FOUND");
    }
    // 与新建预约使用同一包厢锁，保证取消与下单的结果可线性化：
    // 取消进行到一半时，新下单不会基于旧状态做出错误判断。
    return this.roomLocks.runExclusive(booking.roomId, () => this.cancelBookingLocked(bookingId));
  }

  private async cancelBookingLocked(
    bookingId: string,
  ): Promise<{ booking: Booking; member: Member }> {
    // 锁内重读，避免读到锁外的过期快照
    const booking = await this.storage.getBooking(bookingId);
    if (!booking) {
      throw new BusinessError(404, "预约不存在", "BOOKING_NOT_FOUND");
    }
    if (booking.status === "cancelled") {
      throw new BusinessError(409, "该预约已取消，不能重复取消", "BOOKING_ALREADY_CANCELLED");
    }

    const changed = await this.storage.markBookingCancelled(bookingId);
    if (!changed) {
      throw new BusinessError(409, "预约状态已变化，请刷新后重试", "BOOKING_STATE_CHANGED");
    }

    const member = await this.storage.refundMember(
      booking.memberId,
      booking.chargedAmount,
      -booking.pointsEarned,
    );
    if (!member) {
      throw new BusinessError(404, "预约关联的会员不存在，退款失败", "MEMBER_NOT_FOUND");
    }

    return { booking: { ...booking, status: "cancelled" }, member };
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
