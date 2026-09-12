<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { APP_CODE, APP_NAME } from "./constants/app";
import { useWorkbench } from "./state/workbench";
import RoomsView from "./views/RoomsView.vue";
import BookingsView from "./views/BookingsView.vue";
import MembersView from "./views/MembersView.vue";

const activeTab = ref("rooms");
const { rooms, members, bookings, loadAll, lastError } = useWorkbench();

onMounted(async () => {
  await loadAll();
  if (lastError.value) {
    ElMessage.error(`数据加载失败：${lastError.value}`);
  }
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <span class="brand-code">{{ APP_CODE }} · 运营台</span>
        <h1 class="brand-title">{{ APP_NAME }} · 包厢预约与会员储值</h1>
      </div>
      <div class="topbar-stats">
        <span class="stat-chip">包厢 {{ rooms.length }}</span>
        <span class="stat-chip">进行中预约 {{ bookings.length }}</span>
        <span class="stat-chip">会员 {{ members.length }}</span>
      </div>
    </header>
    <section class="workspace">
      <el-tabs v-model="activeTab" class="workbench-tabs">
        <el-tab-pane label="包厢资源" name="rooms">
          <RoomsView />
        </el-tab-pane>
        <el-tab-pane label="预约记录" name="bookings">
          <BookingsView />
        </el-tab-pane>
        <el-tab-pane label="会员储值" name="members">
          <MembersView />
        </el-tab-pane>
      </el-tabs>
    </section>
  </main>
</template>
