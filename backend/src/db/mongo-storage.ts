import type { Booking, BookingStatus, Member, Room, Storage, WalletTxInput, WalletTxResult } from "./types";
import { BookingModel, MemberModel, RoomModel } from "./mongoose-models";

type RoomDoc = Room & { _id: unknown };
type BookingDoc = Booking & { _id: unknown };
type MemberDoc = Member & { _id: unknown };

function normalizeRoom(doc: RoomDoc | null): Room | null {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  return { ...rest, id: String(_id) };
}

function normalizeBooking(doc: BookingDoc | null): Booking | null {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  return { ...rest, id: String(_id) };
}

function normalizeMember(doc: MemberDoc | null): Member | null {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  return {
    ...rest,
    id: String(_id),
    walletTransactions: (rest.walletTransactions ?? []).map((tx) => ({ ...tx })),
  };
}

export class MongoStorage implements Storage {
  async listRooms(): Promise<Room[]> {
    const docs = (await RoomModel.find().sort({ _id: 1 }).lean()) as unknown as RoomDoc[];
    return docs.map((doc) => normalizeRoom(doc) as Room);
  }

  async getRoom(id: string): Promise<Room | null> {
    const doc = (await RoomModel.findById(id).lean()) as unknown as RoomDoc | null;
    return normalizeRoom(doc);
  }

  async updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null> {
    const doc = (await RoomModel.findByIdAndUpdate(
      id,
      { $set: { underMaintenance } },
      { new: true },
    ).lean()) as unknown as RoomDoc | null;
    return normalizeRoom(doc);
  }

  async listBookings(filter?: { status?: BookingStatus }): Promise<Booking[]> {
    const query = filter?.status ? { status: filter.status } : {};
    const docs = (await BookingModel.find(query)
      .sort({ startTime: 1 })
      .lean()) as unknown as BookingDoc[];
    return docs.map((doc) => normalizeBooking(doc) as Booking);
  }

  async insertBooking(booking: Booking): Promise<Booking> {
    const { id, ...fields } = booking;
    const created = await BookingModel.create({ _id: id, ...fields });
    return normalizeBooking(created.toObject() as unknown as BookingDoc) as Booking;
  }

  async getBooking(id: string): Promise<Booking | null> {
    const doc = (await BookingModel.findById(id).lean()) as unknown as BookingDoc | null;
    return normalizeBooking(doc);
  }

  async findLiveBookingByRequest(input: {
    requestId: string;
    memberId: string;
    roomId: string;
  }): Promise<Booking | null> {
    const doc = (await BookingModel.findOne({
      requestId: input.requestId,
      memberId: input.memberId,
      roomId: input.roomId,
      // 作用域隔离：仅认未结束态，已取消/已失败的请求键可重新发起
      status: { $in: ["pending_payment", "booked"] },
    }).lean()) as unknown as BookingDoc | null;
    return normalizeBooking(doc);
  }

  async setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean> {
    const result = await BookingModel.updateOne(
      { _id: id, status: { $in: expectedStatuses } },
      { $set: { status: nextStatus } },
    );
    return result.matchedCount === 1;
  }

  async listMembers(): Promise<Member[]> {
    const docs = (await MemberModel.find().sort({ _id: 1 }).lean()) as unknown as MemberDoc[];
    return docs.map((doc) => normalizeMember(doc) as Member);
  }

  async getMember(id: string): Promise<Member | null> {
    const doc = (await MemberModel.findById(id).lean()) as unknown as MemberDoc | null;
    return normalizeMember(doc);
  }

  async insertMember(member: Member): Promise<Member> {
    const { id, ...fields } = member;
    const created = await MemberModel.create({ _id: id, ...fields });
    return normalizeMember(created.toObject() as unknown as MemberDoc) as Member;
  }

  async rechargeMember(id: string, amount: number): Promise<Member | null> {
    // 单条聚合管道更新：金额取整到分，并按累计充值同步等级
    const updated = (await MemberModel.findByIdAndUpdate(
      id,
      [
        {
          $set: {
            balance: { $round: [{ $add: ["$balance", amount] }, 2] },
            totalRecharge: { $round: [{ $add: ["$totalRecharge", amount] }, 2] },
            level: {
              $switch: {
                branches: [
                  { case: { $gte: [{ $add: ["$totalRecharge", amount] }, 2000] }, then: "gold" },
                  { case: { $gte: [{ $add: ["$totalRecharge", amount] }, 500] }, then: "silver" },
                ],
                default: "bronze",
              },
            },
          },
        },
      ],
      { new: true },
    ).lean()) as unknown as MemberDoc | null;
    return normalizeMember(updated);
  }

  async applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult> {
    const now = new Date().toISOString();
    const txLiteral = {
      id: tx.id,
      kind: tx.kind,
      amount: tx.amount,
      pointsDelta: tx.pointsDelta,
      linkedTransactionId: tx.linkedTransactionId,
      createdAt: now,
    };

    if (tx.kind === "charge") {
      // 单文档原子条件更新：余额足够且流水不存在时，余额/积分/流水一次写入
      const updated = (await MemberModel.findOneAndUpdate(
        {
          _id: memberId,
          balance: { $gte: tx.amount },
          "walletTransactions.id": { $ne: tx.id },
        },
        [
          {
            $set: {
              balance: { $round: [{ $subtract: ["$balance", tx.amount] }, 2] },
              points: { $max: [0, { $add: ["$points", tx.pointsDelta] }] },
              walletTransactions: { $concatArrays: ["$walletTransactions", [txLiteral]] },
            },
          },
        ],
        { new: true },
      ).lean()) as unknown as MemberDoc | null;
      if (updated) {
        return { outcome: "applied", member: normalizeMember(updated) as Member };
      }
      return this.classifyMiss(memberId, tx.id, "insufficient");
    }

    // refund：必须存在对应的扣款流水，且退款流水本身不能重复
    const updated = (await MemberModel.findOneAndUpdate(
      {
        _id: memberId,
        "walletTransactions.id": { $ne: tx.id },
        walletTransactions: {
          $elemMatch: { id: tx.linkedTransactionId, kind: "charge" },
        },
      },
      [
        {
          $set: {
            balance: { $round: [{ $add: ["$balance", tx.amount] }, 2] },
            points: { $max: [0, { $add: ["$points", tx.pointsDelta] }] },
            walletTransactions: { $concatArrays: ["$walletTransactions", [txLiteral]] },
          },
        },
      ],
      { new: true },
    ).lean()) as unknown as MemberDoc | null;
    if (updated) {
      return { outcome: "applied", member: normalizeMember(updated) as Member };
    }
    return this.classifyMiss(memberId, tx.id, "no_linked_charge");
  }

  /** 条件更新未命中时，区分会员不存在 / 幂等重复 / 业务拒绝。 */
  private async classifyMiss(
    memberId: string,
    txId: string,
    businessOutcome: "insufficient" | "no_linked_charge",
  ): Promise<WalletTxResult> {
    const doc = (await MemberModel.findById(memberId).lean()) as unknown as MemberDoc | null;
    if (!doc) {
      return { outcome: "member_not_found" };
    }
    const member = normalizeMember(doc) as Member;
    const duplicate = member.walletTransactions.some((item) => item.id === txId);
    return { outcome: duplicate ? "duplicate" : businessOutcome, member };
  }
}
