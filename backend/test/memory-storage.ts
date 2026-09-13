import type { Booking, Member, Room, Storage } from "../src/db/types";
import { levelForTotalRecharge, round2 } from "../src/modules/pricing";

/** 测试用内存存储，行为与 FileStorage 保持一致。 */
export class MemoryStorage implements Storage {
  rooms: Room[] = [];
  bookings: Booking[] = [];
  members: Member[] = [];

  withSeed(rooms: Room[], members: Member[], bookings: Booking[] = []): this {
    this.rooms = rooms.map((room) => ({ ...room, facilities: [...room.facilities] }));
    this.members = members.map((member) => ({ ...member }));
    this.bookings = bookings.map((booking) => ({ ...booking }));
    return this;
  }

  async listRooms(): Promise<Room[]> {
    return this.rooms.map((room) => ({ ...room }));
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
    return { ...room };
  }

  async listBookings(filter?: { status?: "booked" | "cancelled" }): Promise<Booking[]> {
    const rows = filter?.status
      ? this.bookings.filter((booking) => booking.status === filter.status)
      : this.bookings;
    return rows.map((booking) => ({ ...booking }));
  }

  async insertBooking(booking: Booking): Promise<Booking> {
    this.bookings.push({ ...booking });
    return { ...booking };
  }

  async getBooking(id: string): Promise<Booking | null> {
    const booking = this.bookings.find((item) => item.id === id);
    return booking ? { ...booking } : null;
  }

  async markBookingCancelled(id: string): Promise<boolean> {
    const booking = this.bookings.find((item) => item.id === id);
    if (!booking || booking.status !== "booked") {
      return false;
    }
    booking.status = "cancelled";
    return true;
  }

  async listMembers(): Promise<Member[]> {
    return this.members.map((member) => ({ ...member }));
  }

  async getMember(id: string): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    // 返回副本，模拟 DB 快照语义：锁外拿到的会员对象不随后续扣款而变化
    return member ? { ...member } : null;
  }

  async insertMember(member: Member): Promise<Member> {
    this.members.push({ ...member });
    return { ...member };
  }

  async rechargeMember(id: string, amount: number): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    if (!member) {
      return null;
    }
    member.balance = round2(member.balance + amount);
    member.totalRecharge = round2(member.totalRecharge + amount);
    member.level = levelForTotalRecharge(member.totalRecharge);
    return { ...member };
  }

  async chargeMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    if (!member || member.balance < amount) {
      return null;
    }
    member.balance = round2(member.balance - amount);
    member.points = Math.max(0, member.points + pointsDelta);
    return { ...member };
  }

  async refundMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    const member = this.members.find((item) => item.id === id);
    if (!member) {
      return null;
    }
    member.balance = round2(member.balance + amount);
    member.points = Math.max(0, member.points + pointsDelta);
    return { ...member };
  }
}
