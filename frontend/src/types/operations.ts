export type MemberLevel = "bronze" | "silver" | "gold";

export interface Room {
  id: string;
  name: string;
  capacity: number;
  facilities: string[];
  hourlyRate: number;
  underMaintenance: boolean;
  createdAt: string;
}

export interface Booking {
  id: string;
  roomId: string;
  roomName: string;
  memberId: string;
  memberName: string;
  startTime: string;
  endTime: string;
  baseAmount: number;
  chargedAmount: number;
  pointsEarned: number;
  level: MemberLevel;
  status: "booked" | "cancelled";
  createdAt: string;
}

export interface Member {
  id: string;
  name: string;
  phone: string;
  level: MemberLevel;
  balance: number;
  points: number;
  totalRecharge: number;
  createdAt: string;
}

export interface PriceQuote {
  hours: number;
  baseAmount: number;
  discount: number;
  chargedAmount: number;
  pointsEarned: number;
  balance: number;
  affordable: boolean;
}

export interface BookingResult {
  booking: Booking;
  member: Member;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
