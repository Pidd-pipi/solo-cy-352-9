<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { operationsApi, ApiError } from "../api/operations";
import { LEVEL_META, formatMoney } from "../constants/operations";
import type { Booking, Member, PriceQuote, Room } from "../types/operations";

const props = defineProps<{
  modelValue: boolean;
  rooms: Room[];
  members: Member[];
  /** 打开弹窗时预选的包厢 */
  presetRoomId?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "booked", payload: { booking: Booking; member: Member }): void;
}>();

const formRef = ref<FormInstance>();
const submitting = ref(false);
const quote = ref<PriceQuote | null>(null);
const quoting = ref(false);

const form = ref({
  roomId: "",
  memberId: "",
  // datetimerange 返回 [Date, Date]
  range: [] as Date[],
});

const rules: FormRules = {
  roomId: [{ required: true, message: "请选择包厢", trigger: "change" }],
  memberId: [{ required: true, message: "请选择预约会员", trigger: "change" }],
  range: [
    {
      required: true,
      validator: (_rule, value: Date[], callback) => {
        if (!value || value.length !== 2 || !value[0] || !value[1]) {
          callback(new Error("请选择预约的开始与结束时间"));
        } else {
          callback();
        }
      },
      trigger: "change",
    },
  ],
};

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

function roomLabel(room: Room): string {
  return `${room.name}（${room.capacity}人 · ￥${room.hourlyRate}/h）${room.underMaintenance ? " · 维护中" : ""}`;
}

function memberLabel(member: Member): string {
  return `${member.name}（${LEVEL_META[member.level].label} · 余额￥${member.balance.toFixed(2)}）`;
}

const selectedRoom = computed(() => props.rooms.find((room) => room.id === form.value.roomId));
const selectedMember = computed(() => props.members.find((member) => member.id === form.value.memberId));
const rangeShortcut = (days: number) => {
  const end = new Date();
  end.setDate(end.getDate() + days);
  end.setMinutes(0, 0, 0);
  const start = new Date(end);
  start.setHours(start.getHours() - 2);
  return [start, end];
};

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      form.value = {
        roomId: props.presetRoomId && props.rooms.some((room) => room.id === props.presetRoomId)
          ? props.presetRoomId
          : props.rooms.find((room) => !room.underMaintenance)?.id ?? "",
        memberId: props.members[0]?.id ?? "",
        range: rangeShortcut(1),
      };
      quote.value = null;
      void refreshQuote();
    }
  },
);

watch([() => form.value.roomId, () => form.value.memberId, () => form.value.range], () => {
  if (props.modelValue) {
    void refreshQuote();
  }
});

async function refreshQuote() {
  if (!form.value.roomId || !form.value.memberId || form.value.range.length !== 2) {
    quote.value = null;
    return;
  }
  quoting.value = true;
  try {
    quote.value = await operationsApi.quote({
      roomId: form.value.roomId,
      memberId: form.value.memberId,
      startTime: form.value.range[0].toISOString(),
      endTime: form.value.range[1].toISOString(),
    });
  } catch {
    // 试算失败（如时间倒置）静默处理，提交时由后端返回明确错误
    quote.value = null;
  } finally {
    quoting.value = false;
  }
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) {
    return;
  }
  submitting.value = true;
  try {
    const result = await operationsApi.createBooking({
      roomId: form.value.roomId,
      memberId: form.value.memberId,
      startTime: form.value.range[0].toISOString(),
      endTime: form.value.range[1].toISOString(),
    });
    ElMessage.success(
      `预约成功：扣款 ${formatMoney(result.booking.chargedAmount)}，累积 ${result.booking.pointsEarned} 积分`,
    );
    emit("booked", result);
    dialogVisible.value = false;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "预约失败，请稍后重试");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="dialogVisible" title="新建包厢预约" width="520px" destroy-on-close>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
      <el-form-item label="包厢" prop="roomId">
        <el-select v-model="form.roomId" placeholder="请选择包厢" style="width: 100%">
          <el-option
            v-for="room in rooms"
            :key="room.id"
            :value="room.id"
            :label="roomLabel(room)"
            :disabled="room.underMaintenance"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="预约会员" prop="memberId">
        <el-select v-model="form.memberId" placeholder="请选择会员" style="width: 100%">
          <el-option
            v-for="member in members"
            :key="member.id"
            :value="member.id"
            :label="memberLabel(member)"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="预约时段" prop="range">
        <el-date-picker
          v-model="form.range"
          type="datetimerange"
          range-separator="至"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          format="MM-DD HH:mm"
          :clearable="false"
          style="width: 100%"
        />
      </el-form-item>
    </el-form>

    <el-alert
      v-if="selectedRoom?.underMaintenance"
      type="warning"
      :closable="false"
      title="该包厢维护中，无法提交预约"
      style="margin-bottom: 12px"
    />

    <el-descriptions v-if="quote" :column="1" border size="small" title="费用试算">
      <el-descriptions-item label="计费时长">{{ quote.hours }} 小时（半小时向上取整）</el-descriptions-item>
      <el-descriptions-item label="原价">{{ formatMoney(quote.baseAmount) }}</el-descriptions-item>
      <el-descriptions-item v-if="selectedMember" :label="`${LEVEL_META[selectedMember.level].label}折扣`">
        {{ quote.discount === 1 ? "无折扣" : `${quote.discount * 10} 折` }}
      </el-descriptions-item>
      <el-descriptions-item label="实付金额">
        <strong>{{ formatMoney(quote.chargedAmount) }}</strong>
        <span style="margin-left: 8px">可得 {{ quote.pointsEarned }} 积分</span>
      </el-descriptions-item>
      <el-descriptions-item label="账户余额">
        <span :class="quote.affordable ? 'amount-ok' : 'amount-bad'">
          ￥{{ quote.balance.toFixed(2) }}
          <template v-if="!quote.affordable">（余额不足，请先充值）</template>
        </span>
      </el-descriptions-item>
    </el-descriptions>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting || quoting" @click="submit">
        确认预约并扣款
      </el-button>
    </template>
  </el-dialog>
</template>
