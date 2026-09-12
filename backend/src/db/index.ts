import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "../common/logger";
import type { Storage } from "./types";
import { MongoStorage } from "./mongo-storage";
import { FileStorage } from "./file-storage";
import { RoomModel, MemberModel } from "./mongoose-models";
import { SEED_MEMBERS, SEED_ROOMS } from "./seed";

export interface ConnectedStorage {
  storage: Storage;
  /** 当前生效的存储模式，供健康检查/排障展示 */
  mode: "mongodb" | "file";
  close(): Promise<void>;
}

/**
 * 优先连接 MongoDB；连接失败（如本地未启动数据库）时自动降级为 JSON 文件存储，
 * 保证 npm run dev 与页面演示在无数据库环境下也能运行，且刷新/重启后数据仍在。
 */
export async function connectStorage(): Promise<ConnectedStorage> {
  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: env.mongoConnectTimeoutMs,
    });
    logger.info("Connected to MongoDB");
    await seedMongoIfEmpty();
    const mongo = new MongoStorage();
    return {
      storage: mongo,
      mode: "mongodb",
      close: () => mongoose.disconnect(),
    };
  } catch (error) {
    logger.error(
      `MongoDB unavailable (${(error as Error).message}); falling back to file storage at ${env.dataDir}`,
    );
    const file = new FileStorage(env.dataDir);
    await seedFileIfEmpty(file);
    return {
      storage: file,
      mode: "file",
      close: async () => undefined,
    };
  }
}

async function seedMongoIfEmpty(): Promise<void> {
  const roomCount = await RoomModel.countDocuments();
  if (roomCount === 0) {
    await RoomModel.create(
      SEED_ROOMS.map(({ id: _id, ...rest }) => ({ _id, ...rest })),
    );
    logger.info("Seeded demo rooms into MongoDB");
  }
  const memberCount = await MemberModel.countDocuments();
  if (memberCount === 0) {
    await MemberModel.create(
      SEED_MEMBERS.map(({ id: _id, ...rest }) => ({ _id, ...rest })),
    );
    logger.info("Seeded demo members into MongoDB");
  }
}

async function seedFileIfEmpty(storage: FileStorage): Promise<void> {
  const rooms = await storage.listRooms();
  const members = await storage.listMembers();
  if (rooms.length === 0 || members.length === 0) {
    await storage.replaceAll({
      rooms: rooms.length === 0 ? SEED_ROOMS.map((room) => ({ ...room })) : rooms,
      bookings: [],
      members: members.length === 0 ? SEED_MEMBERS.map((member) => ({ ...member })) : members,
    });
    logger.info("Seeded demo rooms and members into file storage");
  }
}
