import { MemoryStorage } from "./memory-storage";
import type {
  Booking,
  BookingStatus,
  WalletTxInput,
  WalletTxResult,
} from "../src/db/types";

export interface FaultRule {
  /** 前 failTimes 次匹配调用抛 StorageFault（第 failTimes+1 次起恢复正常，模拟存储恢复后重试） */
  failTimes: number;
}

export interface FaultConfig {
  /** pending 预约落库失败 */
  insertBooking?: FaultRule;
  /** 扣款/退款流水写入失败，可按 kind 过滤 */
  applyWalletTransaction?: FaultRule & { kind?: "charge" | "refund" };
  /** 预约状态迁移失败，可按目标状态过滤 */
  setBookingStatus?: FaultRule & { to?: BookingStatus };
}

/** 可确定性注入的存储故障。 */
export class StorageFault extends Error {
  constructor(public readonly operation: string) {
    super(`injected storage failure: ${operation}`);
  }
}

/**
 * 包装内存存储，按配置让指定操作的前 N 次调用确定性失败，之后恢复。
 * 不改变任何成功路径的数据语义，只负责“抛错”。
 */
export class FaultyStorage extends MemoryStorage {
  private counters: Record<string, number> = {};

  constructor(private readonly config: FaultConfig) {
    super();
  }

  /** 已实际发生的故障次数（测试可据此确认故障确实被触发） */
  faultCount(operation: keyof FaultConfig): number {
    return this.counters[operation] ?? 0;
  }

  private shouldFail(
    key: keyof FaultConfig,
    rule?: FaultRule,
  ): boolean {
    if (!rule) {
      return false;
    }
    const used = this.counters[key] ?? 0;
    if (used < rule.failTimes) {
      this.counters[key] = used + 1;
      return true;
    }
    return false;
  }

  override async insertBooking(booking: Booking): Promise<Booking> {
    if (this.shouldFail("insertBooking", this.config.insertBooking)) {
      throw new StorageFault("insertBooking");
    }
    return super.insertBooking(booking);
  }

  override async applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult> {
    const rule = this.config.applyWalletTransaction;
    if (rule && (!rule.kind || rule.kind === tx.kind) && this.shouldFail("applyWalletTransaction", rule)) {
      throw new StorageFault(`applyWalletTransaction:${tx.kind}`);
    }
    return super.applyWalletTransaction(memberId, tx);
  }

  override async setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean> {
    const rule = this.config.setBookingStatus;
    if (rule && (!rule.to || rule.to === nextStatus) && this.shouldFail("setBookingStatus", rule)) {
      throw new StorageFault(`setBookingStatus:${nextStatus}`);
    }
    return super.setBookingStatus(id, expectedStatuses, nextStatus);
  }
}
