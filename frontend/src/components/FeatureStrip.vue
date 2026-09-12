<script setup lang="ts">
import type { FeatureItem } from "../types";

defineProps<{ items: FeatureItem[] }>();
</script>

<template>
  <section class="feature-strip" aria-label="核心功能">
    <article v-for="item in items" :key="item.title" class="feature-panel">
      <span class="pill">{{ item.metric }}</span>
      <strong>{{ item.title }}</strong>
      <p>{{ item.description }}</p>
    </article>
  </section>
</template>
