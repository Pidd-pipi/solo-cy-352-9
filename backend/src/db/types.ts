/** 会员等级：储值余额越高等级越高，消费时享受对应折扣。 */
export type MemberLevel = "bronze" | "silver" | "gold";

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

export interface Booking {
  id: string;
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
  status: "booked" | "cancelled";
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
  createdAt: string;
}

/** 数据存储抽象：MongoDB 与本地文件两种实现共用同一接口。 */
export interface Storage {
  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | null>;
  updateRoomMaintenance(id: string, underMaintenance: boolean): Promise<Room | null>;

  listBookings(filter?: { status?: "booked" | "cancelled" }): Promise<Booking[]>;
  insertBooking(booking: Booking): Promise<Booking>;
  getBooking(id: string): Promise<Booking | null>;
  markBookingCancelled(id: string): Promise<boolean>;

  listMembers(): Promise<Member[]>;
  getMember(id: string): Promise<Member | null>;
  insertMember(member: Member): Promise<Member>;
  /** 原子地充值：余额、累计充值同时增加 */
  rechargeMember(id: string, amount: number): Promise<Member | null>;
  /**
   * 原子扣款（余额足够才生效）。
   * 同时按积分差额更新积分（正数为累积，负数为回退）。
   */
  chargeMember(id: string, amount: number, pointsDelta: number): Promise<Member | null>;
  /** 取消预约时退款：余额回补、积分回退（积分不为负）。 */
  refundMember(id: string, amount: number, pointsDelta: number): Promise<Member | null>;
}
