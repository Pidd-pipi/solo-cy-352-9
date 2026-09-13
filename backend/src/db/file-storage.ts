import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Booking,
  BookingStatus,
  Member,
  Room,
  Storage,
  WalletTxInput,
  WalletTxResult,
} from "./types";

interface DatabaseShape {
  rooms: Room[];
  bookings: Booking[];
  members: Member[];
}

const EMPTY_DB: DatabaseShape = { rooms: [], bookings: [], members: [] };

/**
 * 无 MongoDB 时的降级存储：所有数据写入单个 JSON 文件。
 * 同一进程内用 Promise 队列串行化写操作，保证资金台账写入的原子性。
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
      const parsed = { ...EMPTY_DB, ...(JSON.parse(raw) as DatabaseShape) };
      // 兼容旧数据：补全新增字段
      for (const member of parsed.members) {
        member.walletTransactions ??= [];
      }
      this.cache = parsed;
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
      members: (data.members ?? []).map((member) => ({
        ...member,
        walletTransactions: member.walletTransactions ?? [],
      })),
    };
    await this.persist();
  }

  async listRooms(): Promise<Room[]> {
    const db = await this.load();
    return db.rooms.map((room) => ({ ...room, facilities: [...room.facilities] }));
  }

  async getRoom(id: string): Promise<Room | null> {
    const db = await this.load();
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
    return { ...room, facilities: [...room.facilities] };
  }

  async listBookings(filter?: { status?: BookingStatus }): Promise<Booking[]> {
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

  async findBookingByRequestId(requestId: string): Promise<Booking | null> {
    const db = await this.load();
    const booking = db.bookings.find((item) => item.requestId === requestId);
    return booking ? { ...booking } : null;
  }

  async setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean> {
    const db = await this.load();
    const booking = db.bookings.find((item) => item.id === id);
    if (!booking || !expectedStatuses.includes(booking.status)) {
      return false;
    }
    booking.status = nextStatus;
    await this.persist();
    return true;
  }

  async listMembers(): Promise<Member[]> {
    const db = await this.load();
    return db.members.map((member) => ({
      ...member,
      walletTransactions: member.walletTransactions.map((tx) => ({ ...tx })),
    }));
  }

  async getMember(id: string): Promise<Member | null> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === id);
    return member
      ? { ...member, walletTransactions: member.walletTransactions.map((tx) => ({ ...tx })) }
      : null;
  }

  async insertMember(member: Member): Promise<Member> {
    const db = await this.load();
    const record = { ...member, walletTransactions: member.walletTransactions ?? [] };
    db.members.push(record);
    await this.persist();
    return { ...record, walletTransactions: record.walletTransactions.map((tx) => ({ ...tx })) };
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
    return this.snapshotMember(member);
  }

  /**
   * 幂等资金流水：余额、积分与流水在同一次持久化中提交。
   * - 同 id 重复提交：duplicate，资金不变；
   * - charge 余额不足：insufficient，不写流水；
   * - refund 找不到对应扣款：no_linked_charge，不加钱。
   */
  async applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult> {
    const db = await this.load();
    const member = db.members.find((item) => item.id === memberId);
    if (!member) {
      return { outcome: "member_not_found" };
    }
    member.walletTransactions ??= [];
    if (member.walletTransactions.some((item) => item.id === tx.id)) {
      return { outcome: "duplicate", member: this.snapshotMember(member) };
    }

    if (tx.kind === "charge") {
      if (round2(member.balance - tx.amount) < 0) {
        return { outcome: "insufficient", member: this.snapshotMember(member) };
      }
      member.balance = round2(member.balance - tx.amount);
      member.points = Math.max(0, member.points + tx.pointsDelta);
      member.walletTransactions.push({ ...tx, createdAt: new Date().toISOString() });
      await this.persist();
      return { outcome: "applied", member: this.snapshotMember(member) };
    }

    const chargeExists = tx.linkedTransactionId
      ? member.walletTransactions.some(
          (item) => item.id === tx.linkedTransactionId && item.kind === "charge",
        )
      : false;
    if (!chargeExists) {
      return { outcome: "no_linked_charge", member: this.snapshotMember(member) };
    }
    member.balance = round2(member.balance + tx.amount);
    member.points = Math.max(0, member.points + tx.pointsDelta);
    member.walletTransactions.push({ ...tx, createdAt: new Date().toISOString() });
    await this.persist();
    return { outcome: "applied", member: this.snapshotMember(member) };
  }

  private snapshotMember(member: Member): Member {
    return {
      ...member,
      walletTransactions: (member.walletTransactions ?? []).map((tx) => ({ ...tx })),
    };
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
