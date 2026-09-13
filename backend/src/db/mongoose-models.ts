import { Schema, model, type Model } from "mongoose";
import type { Booking, Member, Room, WalletTransaction } from "./types";

const roomSchema = new Schema<Room>(
  {
    name: { type: String, required: true },
    capacity: { type: Number, required: true, min: 1 },
    facilities: { type: [String], default: [] },
    hourlyRate: { type: Number, required: true, min: 0 },
    underMaintenance: { type: Boolean, default: false },
    createdAt: { type: String, required: true },
  },
  { versionKey: false },
);

const bookingSchema = new Schema<Booking>(
  {
    requestId: { type: String, index: true, sparse: true },
    roomId: { type: String, required: true, index: true },
    roomName: { type: String, required: true },
    memberId: { type: String, required: true, index: true },
    memberName: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    baseAmount: { type: Number, required: true },
    chargedAmount: { type: Number, required: true },
    pointsEarned: { type: Number, required: true },
    level: { type: String, enum: ["bronze", "silver", "gold"], required: true },
    status: {
      type: String,
      enum: ["pending_payment", "booked", "cancelled", "failed"],
      default: "pending_payment",
      index: true,
    },
    createdAt: { type: String, required: true },
  },
  { versionKey: false },
);

const walletTransactionSchema = new Schema<WalletTransaction>(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ["charge", "refund"], required: true },
    amount: { type: Number, required: true },
    pointsDelta: { type: Number, required: true },
    linkedTransactionId: { type: String },
    createdAt: { type: String, required: true },
  },
  { _id: false, versionKey: false },
);

const memberSchema = new Schema<Member>(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    level: { type: String, enum: ["bronze", "silver", "gold"], default: "bronze" },
    balance: { type: Number, default: 0, min: 0 },
    points: { type: Number, default: 0, min: 0 },
    totalRecharge: { type: Number, default: 0, min: 0 },
    walletTransactions: { type: [walletTransactionSchema], default: [] },
    createdAt: { type: String, required: true },
  },
  { versionKey: false },
);

export const RoomModel: Model<Room> = model<Room>("Room", roomSchema);
export const BookingModel: Model<Booking> = model<Booking>("Booking", bookingSchema);
export const MemberModel: Model<Member> = model<Member>("Member", memberSchema);
