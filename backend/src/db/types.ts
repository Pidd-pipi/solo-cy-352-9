/** 会员等级：储值余额越高等级越高，消费时享受对应折扣。 */
export type MemberLevel = "bronze" | "silver" | "gold";

/**
 * 预约状态机：
 * - pending_payment：已占用时段、等待扣款（瞬时态；崩溃后由对账收敛）
 * - booked：扣款成功、预约生效
 * - cancelled：已取消且退款流水已入账（不可能出现“已取消但未退款”）
 * - failed：扣款失败或无法完成，时段已释放，不产生任何资金变动
 */
export type BookingStatus = "pending_payment" | "booked" | "cancelled" | "failed";

export interface Room {
  id: string;
  name: string;
  /** 容纳人数 */
  capacity: number;
  /** 设施列表，如：投影、音响、剧本服化道 */
  facilities: string[];
  /** 每小时价格（元） */
  hourlyRate: number;
  /** 维护状态：true 表示维护中，不可预约 */
  underMaintenance: boolean;
  createdAt: string;
}

/** 一笔钱包流水：扣款与退款都先写流水，天然幂等、可审计、可对账。 */
export interface WalletTransaction {
  /** 幂等键，如 `${bookingId}:charge` / `${bookingId}:refund` */
  id: string;
  kind: "charge" | "refund";
  amount: number;
  /** 积分变动：扣款为正（累积），退款为负（回退） */
  pointsDelta: number;
  /** 退款流水必须指向对应的扣款流水，禁止无中生有地加钱 */
  linkedTransactionId?: string;
  createdAt: string;
}

export interface Booking {
  id: string;
  /** 客户端幂等键：同一请求重试时复用同一预约，而不是再扣一次款 */
  requestId?: string;
  roomId: string;
  roomName: string;
  memberId: string;
  memberName: string;
  /** ISO 时间字符串，时段开始 */
  startTime: string;
  /** ISO 时间字符串，时段结束 */
  endTime: string;
  /** 原价（按时长与包厢小时价计算） */
  baseAmount: number;
  /** 会员等级折扣后实际扣款 */
  chargedAmount: number;
  /** 本次消费累积的积分 */
  pointsEarned: number;
  /** 预约时使用的会员等级，用于取消时回退对应折扣逻辑 */
  level: MemberLevel;
  status: BookingStatus;
  createdAt: string;
}

export interface Member {
  id: string;
  name: string;
  phone: string;
  level: MemberLevel;
  /** 储值余额（元） */
  balance: number;
  /** 积分 */
  points: number;
  /** 累计充值金额 */
  totalRecharge: number;
  /** 钱包流水台账：余额/积分的每次变动都有幂等记录 */
  walletTransactions: WalletTransaction[];
  createdAt: string;
}

/** 幂等资金操作的结果。 */
export type WalletTxResult =
  | { outcome: "applied"; member: Member }
  | { outcome: "duplicate"; member: Member }
  | { outcome: "insufficient"; member: Member }
  | { outcome: "no_linked_charge"; member: Member }
  | { outcome: "member_not_found" };

export interface WalletTxInput {
  id: string;
  kind: "charge" | "refund";
  amount: number;
  pointsDelta: number;
  /** 退款时必填：对应扣款流水 id */
  linkedTransactionId?: string;
}

/** 数据存储抽象：MongoDB 与本地文件两种实现共用同一接口。 */
export interface Storage {
  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | null>;
  updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null>;

  listBookings(filter?: { status?: BookingStatus }): Promise<Booking[]>;
  insertBooking(booking: Booking): Promise<Booking>;
  getBooking(id: string): Promise<Booking | null>;
  /**
   * 幂等请求查找（作用域隔离）：仅当 (requestId, memberId, roomId) 三元组完全一致
   * 且预约处于未结束态（pending_payment / booked）时才视为同一请求的重试。
   * 因此不同会员或不同包厢即使复用同一 requestId，也绝不会返回他人的预约。
   * 已取消/已失败的旧请求键允许重新发起。
   */
  findLiveBookingByRequest(input: {
    requestId: string;
    memberId: string;
    roomId: string;
  }): Promise<Booking | null>;
  /**
   * 原子状态迁移（compare-and-set）：仅当当前状态在 expectedStatuses 中时才写入 nextStatus。
   * 返回 false 表示状态已被其他操作改变。
   */
  setBookingStatus(
    id: string,
    expectedStatuses: BookingStatus[],
    nextStatus: BookingStatus,
  ): Promise<boolean>;

  listMembers(): Promise<Member[]>;
  getMember(id: string): Promise<Member | null>;
  insertMember(member: Member): Promise<Member>;
  /** 原子地充值：余额、累计充值同时增加 */
  rechargeMember(id: string, amount: number): Promise<Member | null>;
  /**
   * 幂等资金流水：
   * - 同一 tx.id 重复提交返回 duplicate，余额积分不再变动；
   * - charge 在余额不足时返回 insufficient，不写流水、不扣款；
   * - refund 必须存在 linkedTransactionId 指向的扣款流水，否则 no_linked_charge。
   * 余额、积分与流水的写入在同一次原子更新内完成。
   */
  applyWalletTransaction(memberId: string, tx: WalletTxInput): Promise<WalletTxResult>;
}
