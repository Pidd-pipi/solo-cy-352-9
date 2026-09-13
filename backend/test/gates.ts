import { MemoryStorage } from "./memory-storage";
import type {
  Booking,
  BookingStatus,
  Member,
  Room,
  WalletTxInput,
  WalletTxResult,
} from "../src/db/types";
import { SEED_MEMBERS, SEED_ROOMS } from "../src/db/seed";

/**
 * 确定性并发门（deterministic gate）。
 *
 * 用法：多个并发任务跑到指定存储调用点时 await gate.enter() 被挂起；
 * 测试用 waitForArrivals() 确认它们全部停在门前，再 open() 同时放行。
 * 这样无需依赖时序/超时即可 100% 复现竞态。
 */
export class Gate {
  private resolveGate: (() => void) | null = null;
  private readonly opened: Promise<void> = new Promise((resolve) => {
    this.resolveGate = resolve;
  });
  private armed = false;
  waiters = 0;
  private readonly arrivals: Array<() => void> = [];
  private readonly arrivalPromises: Array<Promise<void>> = [];

  /** blockCalls = 需要在门前拦住多少个调用 */
  constructor(private readonly blockCalls: number) {
    for (let i = 0; i < blockCalls; i += 1) {
      this.arrivalPromises.push(
        new Promise<void>((resolve) => {
          this.arrivals.push(resolve);
        }),
      );
    }
  }

  /** 建场数据时先不武装，等准备好再打开拦截能力 */
  arm(): void {
    this.armed = true;
  }

  async enter(): Promise<void> {
    if (!this.armed) {
      return;
    }
    const index = this.waiters;
    if (index < this.blockCalls) {
      this.waiters += 1;
      this.arrivals[index]?.();
      await this.opened;
    }
  }

  /** 等待 blockCalls 个调用全部到达门前 */
  async waitForArrivals(): Promise<void> {
    await Promise.all(this.arrivalPromises);
  }

  open(): void {
    this.resolveGate?.();
  }
}

export interface GateHooks {
  /** 下单锁外资源校验点（createBooking 的 getRoom）——用于让多个请求同时停在锁前 */
  getRoom?: Gate;
  /** 下单锁外资源校验点（createBooking 的 getMember，入锁前最后一个等待点） */
  getMember?: Gate;
  /** 下单临界区内部的查重点（listBookings）——用于让先持锁者停在锁内，把竞争者挡在锁外 */
  listBookings?: Gate;
  /** 维护开关写入点（updateRoomMaintenance）——在包厢锁内 */
  updateRoomMaintenance?: Gate;
  /** 取消预约锁外读取点（getBooking）——用于让取消停在锁前 */
  getBooking?: Gate;
  /** 预约状态迁移点（setBookingStatus：确认 booked / 置 cancelled/failed） */
  setBookingStatus?: Gate;
  /** 资金流水写入点（applyWalletTransaction：扣款或退款） */
  applyWalletTransaction?: Gate;
  /** 预约插入点（insertBooking：pending_payment 落库） */
  insertBooking?: Gate;
}

/**
 * 在内存存储的指定调用点装门。
 * 门位于服务层加锁边界的两侧，使测试可以精确控制并发请求进入包厢临界区的先后顺序。
 */
export class GatedStorage extends MemoryStorage {
  constructor(private readonly hooks: GateHooks = {}) {
    super();
  }

  override async getRoom(id: string): Promise<Room | null> {
    await this.hooks.getRoom?.enter();
    return super.getRoom(id);
  }

  override async getMember(id: string): Promise<Member | null> {
    await this.hooks.getMember?.enter();
    return super.getMember(id);
  }

  override async listBookings(filter?: { status?: BookingStatus }): Promise<Booking[]> {
    await this.hooks.listBookings?.enter();
    return super.listBookings(filter);
  }

  override async updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null> {
    await this.hooks.updateRoomMaintenance?.enter();
    return super.updateRoomMaintenance(id, underMaintenance);
  }

  override async getBooking(id: string): Promise<Booking | null> {
    await this.hooks.getBooking?.enter();
    return super.getBooking(id);
  }

  override async setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean> {
    await this.hooks.setBookingStatus?.enter();
    return super.setBookingStatus(id, expectedStatuses, nextStatus);
  }

  override async applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult> {
    await this.hooks.applyWalletTransaction?.enter();
    return super.applyWalletTransaction(memberId, tx);
  }

  override async insertBooking(booking: Booking): Promise<Booking> {
    await this.hooks.insertBooking?.enter();
    return super.insertBooking(booking);
  }
}

/** 构造一份播种好包厢和会员的门控存储（每个用例独立数据）。 */
export function seededGatedStorage(
  hooks: GateHooks = {},
  seed: { rooms: Room[]; members: Member[] } = {
    rooms: SEED_ROOMS,
    members: SEED_MEMBERS,
  },
): GatedStorage {
  return new GatedStorage(hooks).withSeed(
    seed.rooms.map((room) => ({ ...room })),
    seed.members.map((member) => ({ ...member })),
  );
}
