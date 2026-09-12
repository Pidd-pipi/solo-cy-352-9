import type { Member, Room } from "./types";

/** 首次启动时写入的演示包厢。 */
export const SEED_ROOMS: Room[] = [
  {
    id: "seed-room-strategy",
    name: "策略大师厅",
    capacity: 8,
    facilities: ["投影幕布", "空调", "白板", "储物柜"],
    hourlyRate: 60,
    underMaintenance: false,
    createdAt: "2026-09-01T09:00:00.000Z",
  },
  {
    id: "seed-room-party",
    name: "欢乐派对厅",
    capacity: 12,
    facilities: ["音响", "氛围灯", "KTV 点歌机", "桌游墙", "独立卫生间"],
    hourlyRate: 88,
    underMaintenance: false,
    createdAt: "2026-09-01T09:05:00.000Z",
  },
  {
    id: "seed-room-script",
    name: "剧本推理厅",
    capacity: 6,
    facilities: ["古风布景", "服化道", "沉浸灯光", "机关道具"],
    hourlyRate: 120,
    underMaintenance: true,
    createdAt: "2026-09-01T09:10:00.000Z",
  },
  {
    id: "seed-room-card",
    name: "静谧卡牌室",
    capacity: 4,
    facilities: ["牌垫", "排烟系统", "充电插座"],
    hourlyRate: 40,
    underMaintenance: false,
    createdAt: "2026-09-01T09:15:00.000Z",
  },
];

/** 首次启动时写入的演示会员。 */
export const SEED_MEMBERS: Member[] = [
  {
    id: "seed-member-alice",
    name: "林小鹿",
    phone: "13800000001",
    level: "gold",
    balance: 500,
    points: 320,
    totalRecharge: 2200,
    createdAt: "2026-09-02T10:00:00.000Z",
  },
  {
    id: "seed-member-bob",
    name: "周大锤",
    phone: "13800000002",
    level: "silver",
    balance: 120,
    points: 88,
    totalRecharge: 600,
    createdAt: "2026-09-02T10:05:00.000Z",
  },
  {
    id: "seed-member-carol",
    name: "苏晴",
    phone: "13800000003",
    level: "bronze",
    balance: 30,
    points: 12,
    totalRecharge: 100,
    createdAt: "2026-09-02T10:10:00.000Z",
  },
];
