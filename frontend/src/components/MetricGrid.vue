<script setup lang="ts">
import type { KpiItem } from "../types";

defineProps<{ items: KpiItem[] }>();
</script>

<template>
  <section class="metric-grid" aria-label="关键指标">
    <article v-for="item in items" :key="item.label" class="metric-card">
      <span>{{ item.label }}</span>
      <strong class="metric-value">{{ item.value }}</strong>
      <small>{{ item.trend }}</small>
    </article>
  </section>
</template>
