<script setup lang="ts">
import { ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { operationsApi, ApiError } from "../api/operations";
import { formatDateTime, formatMoney, levelMeta } from "../constants/operations";
import { useWorkbench } from "../state/workbench";

const { bookings, loading, loadBookings } = useWorkbench();
const cancellingId = ref("");
const showCancelled = ref(false);
const allBookings = ref<Awaited<ReturnType<typeof operationsApi.listBookings>>>([]);

async function refresh() {
  await loadBookings();
  if (showCancelled.value) {
    allBookings.value = (await operationsApi.listBookings(true)) ?? [];
  }
}

async function cancelBooking(bookingId: string, roomName: string) {
  try {
    const { value: reason } = await ElMessageBox.prompt(
      `取消「${roomName}」的该笔预约后，实付金额将原路退回储值余额，累积积分同步回退。`,
      "取消预约",
      {
        confirmButtonText: "确认取消并退款",
        cancelButtonText: "再想想",
        inputPlaceholder: "可填写取消原因（选填）",
        inputValue: "",
      },
    );
    void reason;
  } catch {
    return;
  }
  cancellingId.value = bookingId;
  try {
    const result = await operationsApi.cancelBooking(bookingId);
    ElMessage.success(
      `已取消并退款 ${formatMoney(result.booking.chargedAmount)}，会员余额 ${formatMoney(result.member.balance)}、积分 ${result.member.points}`,
    );
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "取消失败，请稍后重试");
  } finally {
    cancellingId.value = "";
  }
}

function bookingRows() {
  return showCancelled.value ? allBookings.value : bookings.value;
}
</script>

<template>
  <div v-loading="loading.bookings">
    <div class="section-head">
      <div>
        <h2>预约记录</h2>
        <p>同一包厢时段重叠、包厢维护中或会员余额不足时，下单会被拒绝。</p>
      </div>
      <el-checkbox v-model="showCancelled" @change="refresh">包含已取消记录</el-checkbox>
    </div>

    <el-table :data="bookingRows()" stripe class="booking-table">
      <el-table-column label="包厢" min-width="120">
        <template #default="{ row }">
          <strong>{{ row.roomName }}</strong>
        </template>
      </el-table-column>
      <el-table-column label="会员" min-width="110">
        <template #default="{ row }">{{ row.memberName }}</template>
      </el-table-column>
      <el-table-column label="等级" width="92">
        <template #default="{ row }">
          <el-tag :type="levelMeta(row.level).tagType" size="small">
            {{ levelMeta(row.level).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时段" min-width="210">
        <template #default="{ row }">
          {{ formatDateTime(row.startTime) }} ~ {{ formatDateTime(row.endTime) }}
          <span v-if="row.endTime" class="booking-id">#{{ row.id.slice(0, 8) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="实付 / 积分" width="130">
        <template #default="{ row }">
          {{ formatMoney(row.chargedAmount) }}
          <span class="points-text">+{{ row.pointsEarned }} 积分</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="92">
        <template #default="{ row }">
          <el-tag :type="row.status === 'booked' ? 'success' : 'info'" size="small">
            {{ row.status === "booked" ? "已预约" : "已取消" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'booked'"
            type="danger"
            plain
            size="small"
            :loading="cancellingId === row.id"
            @click="cancelBooking(row.id, row.roomName)"
          >
            取消预约
          </el-button>
          <span v-else class="empty-hint">—</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
