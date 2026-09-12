<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Clock, User } from "@element-plus/icons-vue";
import { operationsApi, ApiError } from "../api/operations";
import { formatDateTime, formatMoney } from "../constants/operations";
import { useWorkbench } from "../state/workbench";
import type { BookingResult } from "../types/operations";
import BookingDialog from "../components/BookingDialog.vue";

const { rooms, members, bookings, loading, loadAll } = useWorkbench();

const dialogVisible = ref(false);
const presetRoomId = ref<string>("");

const roomsView = computed(() =>
  rooms.value.map((room) => ({
    ...room,
    roomBookings: bookings.value
      .filter((booking) => booking.roomId === room.id)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
  })),
);

function openCreate(roomId: string) {
  presetRoomId.value = roomId;
  dialogVisible.value = true;
}

async function toggleMaintenance(roomId: string, next: boolean) {
  try {
    await ElMessageBox.confirm(
      next ? "设为维护中后，该包厢将不能被预约。确认操作？" : "确认解除维护、恢复可预约状态？",
      "维护状态变更",
      { type: "warning" },
    );
  } catch {
    return;
  }
  try {
    const room = await operationsApi.setMaintenance(roomId, next);
    const index = rooms.value.findIndex((item) => item.id === roomId);
    if (index >= 0) {
      rooms.value[index] = room;
    }
    ElMessage.success(`「${room.name}」已${next ? "进入维护" : "恢复营业"}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "状态更新失败");
  }
}

function onMaintenanceChange(roomId: string, value: string | number | boolean) {
  void toggleMaintenance(roomId, Boolean(value));
}

async function onBooked(payload: BookingResult) {
  await loadAll();
}
</script>

<template>
  <div v-loading="loading.rooms">
    <div class="section-head">
      <div>
        <h2>包厢资源</h2>
        <p>展示各包厢容量、设施与维护状态；维护中的包厢不能被预约。</p>
      </div>
      <el-button type="primary" @click="openCreate('')">新建预约</el-button>
    </div>

    <div class="room-grid">
      <el-card v-for="room in roomsView" :key="room.id" class="room-card" shadow="hover">
        <template #header>
          <div class="room-card-head">
            <strong>{{ room.name }}</strong>
            <el-tag :type="room.underMaintenance ? 'danger' : 'success'" effect="dark">
              {{ room.underMaintenance ? "维护中" : "可预约" }}
            </el-tag>
          </div>
        </template>

        <div class="room-meta">
          <span><el-icon><User /></el-icon> 容纳 {{ room.capacity }} 人</span>
          <span><el-icon><Clock /></el-icon> {{ formatMoney(room.hourlyRate) }} / 小时</span>
        </div>

        <div class="facility-list">
          <el-tag v-for="facility in room.facilities" :key="facility" size="small" effect="plain">
            {{ facility }}
          </el-tag>
        </div>

        <div class="room-bookings">
          <p v-if="room.roomBookings.length === 0" class="empty-hint">暂无进行中预约</p>
          <div v-for="booking in room.roomBookings" :key="booking.id" class="mini-booking">
            <span>{{ booking.memberName }}</span>
            <span>{{ formatDateTime(booking.startTime) }} - {{ formatDateTime(booking.endTime) }}</span>
          </div>
        </div>

        <div class="room-actions">
          <el-button
            type="primary"
            plain
            size="small"
            :disabled="room.underMaintenance"
            @click="openCreate(room.id)"
          >
            预约此包厢
          </el-button>
          <span class="maintenance-switch">
            维护
            <el-switch
              :model-value="room.underMaintenance"
              @change="onMaintenanceChange(room.id, $event as boolean | string | number)"
            />
          </span>
        </div>
      </el-card>
    </div>

    <BookingDialog
      v-model="dialogVisible"
      :rooms="rooms"
      :members="members"
      :preset-room-id="presetRoomId"
      @booked="onBooked"
    />
  </div>
</template>
