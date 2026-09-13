import type {
  Booking,
  BookingStatus,
  Member,
  Room,
  Storage,
  WalletTransaction,
  WalletTxInput,
  WalletTxResult,
} from "../src/db/types";
import { levelForTotalRecharge, round2 } from "../src/modules/pricing";

/** 测试用内存存储，行为与 FileStorage 保持一致（含快照语义与金额取整）。 */
export class MemoryStorage implements Storage {
  rooms: Room[] = [];
  bookings: Booking[] = [];
  members: Member[] = [];

  withSeed(rooms: Room[], members: Member[], bookings: Booking[] = []): this {
    this.rooms = rooms.map((room) => ({ ...room, facilities: [...room.facilities] }));
    this.members = members.map((member) => ({
      ...member,
      walletTransactions: (member.walletTransactions ?? []).map((tx) => ({ ...tx })),
    }));
    this.bookings = bookings.map((booking) => ({ ...booking }));
    return this;
  }

  async listRooms(): Promise<Room[]> {
    return this.rooms.map((room) => ({ ...room, facilities: [...room.facilities] }));
  }

  async getRoom(id: string): Promise<Room | null> {
    // 返回副本，模拟 Mongo lean() 的快照语义：调用方持有的对象不随后续写入而变化
    const room = this.rooms.find((item) => item.id === id);
    return room ? { ...room, facilities: [...room.facilities] } : null;
  }

  async updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null> {
    const room = this.rooms.find((item) => item.id === id);
    if (!room) {
      return null;
    }
    room.underMaintenance = underMaintenance;
    return { ...room, facilities: [...room.facilities] };
  }

  async listBookings(filter?: { status?: BookingStatus }): Promise<Booking[]> {
    const rows = filter?.status
      ? this.bookings.filter((booking) => booking.status === filter.status)
      : this.bookings;
    return rows
      .map((booking) => ({ ...booking }))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }

  async insertBooking(booking: Booking): Promise<Booking> {
    this.bookings.push({ ...booking });
    return { ...booking };
  }

  async getBooking(id: string): Promise<Booking | null> {
    const booking = this.bookings.find((item) => item.id === id);
    return booking ? { ...booking } : null;
  }

  async findLiveBookingByRequest(input: {
    requestId: string;
    memberId: string;
    roomId: string;
  }): Promise<Booking | null> {
    const live: BookingStatus[] = ["pending_payment", "booked"];
    const booking = this.bookings.find(
      (item) =>
        item.requestId === input.requestId &&
        item.memberId === input.memberId &&
        item.roomId === input.roomId &&
        live.includes(item.status),
    );
    return booking ? { ...booking } : null;
  }

  async setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean> {
    const booking = this.bookings.find((item) => item.id === id);
    if (!booking || !expectedStatuses.includes(booking.status)) {
      return false;
    }
    booking.status = nextStatus;
    return true;
  }

  async listMembers(): Promise<Member[]> {
    return this.members.map((member) => ({
      ...member,
      walletTransactions: member.walletTransactions.map((tx) => ({ ...tx })),
    }));
  }

  async getMember(id: string): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    // 返回副本，模拟 DB 快照语义：锁外拿到的会员对象不随后续扣款而变化
    return member
      ? { ...member, walletTransactions: member.walletTransactions.map((tx) => ({ ...tx })) }
      : null;
  }

  async insertMember(member: Member): Promise<Member> {
    this.members.push({ ...member, walletTransactions: [...member.walletTransactions] });
    return { ...member, walletTransactions: [...member.walletTransactions] };
  }

  async rechargeMember(id: string, amount: number): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    if (!member) {
      return null;
    }
    member.balance = round2(member.balance + amount);
    member.totalRecharge = round2(member.totalRecharge + amount);
    member.level = levelForTotalRecharge(member.totalRecharge);
    return this.snapshot(member);
  }

  async applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult> {
    const member = this.members.find((item) => item.id === memberId);
    if (!member) {
      return { outcome: "member_not_found" };
    }
    // 幂等：同一流水 id 重复提交不再变动资金
    const existing = member.walletTransactions.find((item) => item.id === tx.id);
    if (existing) {
      return { outcome: "duplicate", member: this.snapshot(member) };
    }

    if (tx.kind === "charge") {
      if (member.balance < tx.amount) {
        return { outcome: "insufficient", member: this.snapshot(member) };
      }
      member.balance = round2(member.balance - tx.amount);
      member.points = Math.max(0, member.points + tx.pointsDelta);
      member.walletTransactions.push({ ...tx, createdAt: new Date().toISOString() });
      return { outcome: "applied", member: this.snapshot(member) };
    }

    // refund：必须有对应的成功扣款流水，防止凭空退款/重复退款
    const chargeId = tx.linkedTransactionId;
    const chargeExists = chargeId
      ? member.walletTransactions.some((item) => item.id === chargeId && item.kind === "charge")
      : false;
    if (!chargeExists) {
      return { outcome: "no_linked_charge", member: this.snapshot(member) };
    }
    member.balance = round2(member.balance + tx.amount);
    member.points = Math.max(0, member.points + tx.pointsDelta);
    member.walletTransactions.push({ ...tx, createdAt: new Date().toISOString() });
    return { outcome: "applied", member: this.snapshot(member) };
  }

  private snapshot(member: Member): Member {
    return { ...member, walletTransactions: member.walletTransactions.map((tx) => ({ ...tx })) };
  }
}

/** 仅供不关心流水时间戳的用例引用。 */
export type { WalletTransaction };
