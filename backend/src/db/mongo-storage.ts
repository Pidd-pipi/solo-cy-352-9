import type { Booking, Member, Room, Storage } from "./types";
import { BookingModel, MemberModel, RoomModel } from "./mongoose-models";
import { levelForTotalRecharge } from "../modules/pricing";

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
  return { ...rest, id: String(_id) };
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

  async listBookings(filter?: { status?: "booked" | "cancelled" }): Promise<Booking[]> {
    const query = filter?.status ? { status: filter.status } : {};
    const docs = (await BookingModel.find(query)
      .sort({ startTime: 1 })
      .lean()) as unknown as BookingDoc[];
    return docs.map((doc) => normalizeBooking(doc) as Booking);
  }

  async insertBooking(booking: Booking): Promise<Booking> {
    const { id: _ignored, ...fields } = booking;
    const created = await BookingModel.create(fields);
    return normalizeBooking(created.toObject() as unknown as BookingDoc) as Booking;
  }

  async getBooking(id: string): Promise<Booking | null> {
    const doc = (await BookingModel.findById(id).lean()) as unknown as BookingDoc | null;
    return normalizeBooking(doc);
  }

  async markBookingCancelled(id: string): Promise<boolean> {
    const result = await BookingModel.updateOne(
      { _id: id, status: "booked" },
      { $set: { status: "cancelled" } },
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
    const { id: _ignored, ...fields } = member;
    const created = await MemberModel.create(fields);
    return normalizeMember(created.toObject() as unknown as MemberDoc) as Member;
  }

  async rechargeMember(id: string, amount: number): Promise<Member | null> {
    const updated = (await MemberModel.findByIdAndUpdate(
      id,
      { $inc: { balance: amount, totalRecharge: amount } },
      { new: true },
    ).lean()) as unknown as MemberDoc | null;
    if (!updated) {
      return null;
    }
    // 充值累计金额变化可能触发等级提升
    const nextLevel = levelForTotalRecharge(updated.totalRecharge);
    if (nextLevel !== updated.level) {
      const leveled = (await MemberModel.findByIdAndUpdate(
        id,
        { $set: { level: nextLevel } },
        { new: true },
      ).lean()) as unknown as MemberDoc | null;
      return normalizeMember(leveled);
    }
    return normalizeMember(updated);
  }

  async chargeMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    const updated = (await MemberModel.findOneAndUpdate(
      { _id: id, balance: { $gte: amount } },
      {
        $inc: { balance: -amount, points: pointsDelta },
      },
      { new: true },
    ).lean()) as unknown as MemberDoc | null;
    return normalizeMember(updated);
  }

  async refundMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    // $max 保证取消预约回退积分后积分不会变成负数
    const updated = (await MemberModel.findOneAndUpdate(
      { _id: id },
      [
        {
          $set: {
            balance: { $add: ["$balance", amount] },
            points: { $max: [0, { $add: ["$points", pointsDelta] }] },
          },
        },
      ],
      { new: true },
    ).lean()) as unknown as MemberDoc | null;
    return normalizeMember(updated);
  }
}
