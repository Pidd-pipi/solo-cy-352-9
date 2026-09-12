import { reactive, ref } from "vue";
import { operationsApi } from "../api/operations";
import type { Booking, Member, Room } from "../types/operations";

/**
 * 运营台共享状态：模块级单例，切换 Tab 不重新拉取；
 * 所有数据保存在后端（MongoDB，无数据库时为后端 JSON 文件），刷新页面后仍在。
 */
const rooms = ref<Room[]>([]);
const members = ref<Member[]>([]);
const bookings = ref<Booking[]>([]);
const loading = reactive({ rooms: false, members: false, bookings: false });
const lastError = ref("");

async function runGuarded<T>(key: keyof typeof loading, task: () => Promise<T>): Promise<T | undefined> {
  loading[key] = true;
  try {
    return await task();
  } catch (error) {
    lastError.value = error instanceof Error ? error.message : String(error);
    return undefined;
  } finally {
    loading[key] = false;
  }
}

export function useWorkbench() {
  async function loadRooms(force = true) {
    if (!force && rooms.value.length) {
      return;
    }
    const data = await runGuarded("rooms", operationsApi.listRooms);
    if (data) {
      rooms.value = data;
    }
  }

  async function loadMembers(force = true) {
    if (!force && members.value.length) {
      return;
    }
    const data = await runGuarded("members", operationsApi.listMembers);
    if (data) {
      members.value = data;
    }
  }

  async function loadBookings(force = true) {
    const data = await runGuarded("bookings", () => operationsApi.listBookings(false));
    if (data) {
      bookings.value = data;
    }
  }

  async function loadAll() {
    await Promise.all([loadRooms(), loadMembers(), loadBookings()]);
  }

  return {
    rooms,
    members,
    bookings,
    loading,
    lastError,
    loadRooms,
    loadMembers,
    loadBookings,
    loadAll,
  };
}
