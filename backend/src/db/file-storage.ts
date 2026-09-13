import { promises as fs } from "node:fs";
import path from "node:path";
import type { Booking, Member, Room, Storage } from "./types";

interface DatabaseShape {
  rooms: Room[];
  bookings: Booking[];
  members: Member[];
}

const EMPTY_DB: DatabaseShape = { rooms: [], bookings: [], members: [] };

/**
 * 无 MongoDB 时的降级存储：所有数据写入单个 JSON 文件。
 * 同一进程内用 Promise 队列串行化写操作，保证扣款等复合操作的原子性。
 */
export class FileStorage implements Storage {
  private readonly filePath: string;
  private cache: DatabaseShape | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "lpboardgame.json");
  }

  private async load(): Promise<DatabaseShape> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.cache = { ...EMPTY_DB, ...(JSON.parse(raw) as DatabaseShape) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.cache = structuredClone(EMPTY_DB);
    }
    return this.cache;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.cache, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  /** 供种子脚本/测试写入初始数据 */
  async replaceAll(data: DatabaseShape): Promise<void> {
    await this.load();
    this.cache = {
      rooms: data.rooms ?? [],
      bookings: data.bookings ?? [],
      members: data.members ?? [],
    };
    await this.persist();
  }

  async listRooms(): Promise<Room[]> {
    const db = await this.load();
    return db.rooms.map((room) => ({ ...room, facilities: [...room.facilities] }));
  }

  async getRoom(id: string): Promise<Room | null> {
    const db = await this.load();
    // 返回副本，与 Mongo lean() 的快照语义保持一致
    const room = db.rooms.find((item) => item.id === id);
    return room ? { ...room, facilities: [...room.facilities] } : null;
  }

  async updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null> {
    const db = await this.load();
    const room = db.rooms.find((item) => item.id === id);
    if (!room) {
      return null;
    }
    room.underMaintenance = underMaintenance;
    await this.persist();
    return { ...room };
  }

  async listBookings(filter?: { status?: "booked" | "cancelled" }): Promise<Booking[]> {
    const db = await this.load();
    const rows = filter?.status
      ? db.bookings.filter((booking) => booking.status === filter.status)
      : db.bookings;
    return rows
      .map((booking) => ({ ...booking }))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  }

  async insertBooking(booking: Booking): Promise<Booking> {
    const db = await this.load();
    db.bookings.push({ ...booking });
    await this.persist();
    return { ...booking };
  }

  async getBooking(id: string): Promise<Booking | null> {
    const db = await this.load();
    const booking = db.bookings.find((item) => item.id === id);
    return booking ? { ...booking } : null;
  }

  async markBookingCancelled(id: string): Promise<boolean> {
    const db = await this.load();
    const booking = db.bookings.find((item) => item.id === id);
    if (!booking || booking.status !== "booked") {
      return false;
    }
    booking.status = "cancelled";
    await this.persist();
    return true;
  }

  async listMembers(): Promise<Member[]> {
    const db = await this.load();
    return db.members.map((member) => ({ ...member }));
  }

  async getMember(id: string): Promise<Member | null> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === id);
    return member ? { ...member } : null;
  }

  async insertMember(member: Member): Promise<Member> {
    const db = await this.load();
    db.members.push({ ...member });
    await this.persist();
    return { ...member };
  }

  async rechargeMember(id: string, amount: number): Promise<Member | null> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === id);
    if (!member) {
      return null;
    }
    member.balance = round2(member.balance + amount);
    member.totalRecharge = round2(member.totalRecharge + amount);
    member.level = levelFor(member.totalRecharge);
    await this.persist();
    return { ...member };
  }

  /** 余额足够才扣款，否则返回 null（调用方按“余额不足”处理）。 */
  async chargeMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === id);
    if (!member || round2(member.balance - amount) < 0) {
      return null;
    }
    member.balance = round2(member.balance - amount);
    member.points = Math.max(0, member.points + pointsDelta);
    await this.persist();
    return { ...member };
  }

  async refundMember(id: string, amount: number, pointsDelta: number): Promise<Member | null> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === id);
    if (!member) {
      return null;
    }
    member.balance = round2(member.balance + amount);
    member.points = Math.max(0, member.points + pointsDelta);
    await this.persist();
    return { ...member };
  }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function levelFor(totalRecharge: number): Member["level"] {
  if (totalRecharge >= 2000) {
    return "gold";
  }
  if (totalRecharge >= 500) {
    return "silver";
  }
  return "bronze";
}
