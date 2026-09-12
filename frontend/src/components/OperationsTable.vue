<script setup lang="ts">
import type { OperationRecord } from "../types";

defineProps<{ records: OperationRecord[] }>();
</script>

<template>
  <el-table :data="records" style="width: 100%" size="large">
    <el-table-column prop="name" label="模块" />
    <el-table-column prop="owner" label="负责人" />
    <el-table-column prop="status" label="状态" />
    <el-table-column prop="metric" label="指标" />
  </el-table>
</template>
