<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { operationsApi, ApiError } from "../api/operations";
import { LEVEL_META, levelMeta, formatMoney } from "../constants/operations";
import { useWorkbench } from "../state/workbench";
import type { Member } from "../types/operations";

const { members, loading, loadMembers } = useWorkbench();

const rechargeTarget = ref<Member | null>(null);
const dialogVisible = ref(false);
const rechargeAmount = ref(100);
const rechargeSaving = ref(false);

const quickAmounts = [100, 300, 500, 1000, 2000];

function openRecharge(member: Member) {
  rechargeTarget.value = member;
  rechargeAmount.value = 100;
  dialogVisible.value = true;
}

async function submitRecharge() {
  if (!rechargeTarget.value) {
    return;
  }
  if (!Number.isFinite(rechargeAmount.value) || rechargeAmount.value <= 0) {
    ElMessage.warning("充值金额必须大于 0");
    return;
  }
  rechargeSaving.value = true;
  try {
    const updated = await operationsApi.recharge(rechargeTarget.value.id, rechargeAmount.value);
    ElMessage.success(
      `充值成功：余额 ${formatMoney(updated.balance)}，累计充值 ${formatMoney(updated.totalRecharge)}，当前等级「${LEVEL_META[updated.level].label}」`,
    );
    const index = members.value.findIndex((member) => member.id === updated.id);
    if (index >= 0) {
      members.value[index] = updated;
    }
    dialogVisible.value = false;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "充值失败，请稍后重试");
  } finally {
    rechargeSaving.value = false;
  }
}
</script>

<template>
  <div v-loading="loading.members">
    <div class="section-head">
      <div>
        <h2>会员储值</h2>
        <p>
          充值后余额立即到账；累计充值满 ￥500 升白银（9 折），满 ￥2000 升黄金（8 折）。
          消费按等级折扣扣款，每实付 ￥1 累积 1 积分，取消预约时余额与积分同步回退。
        </p>
      </div>
      <el-button @click="loadMembers()">刷新</el-button>
    </div>

    <el-table :data="members" stripe class="member-table">
      <el-table-column label="会员" min-width="140">
        <template #default="{ row }">
          <strong>{{ row.name }}</strong>
          <div class="member-phone">{{ row.phone }}</div>
        </template>
      </el-table-column>
      <el-table-column label="等级" width="110">
        <template #default="{ row }">
          <el-tag :type="levelMeta(row.level).tagType" effect="dark" size="small">
            {{ levelMeta(row.level).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="折扣" width="80">
        <template #default="{ row }">
          {{ levelMeta(row.level).discount === 1
            ? "原价"
            : `${levelMeta(row.level).discount * 10} 折` }}
        </template>
      </el-table-column>
      <el-table-column label="储值余额" min-width="120">
        <template #default="{ row }">
          <span class="balance-text">{{ formatMoney(row.balance) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="积分" min-width="100">
        <template #default="{ row }">{{ row.points }} 分</template>
      </el-table-column>
      <el-table-column label="累计充值" min-width="120">
        <template #default="{ row }">{{ formatMoney(row.totalRecharge) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" size="small" @click="openRecharge(row)">充值</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" title="会员充值" width="420px">
      <template v-if="rechargeTarget">
        <el-descriptions :column="1" border size="small" class="recharge-desc">
          <el-descriptions-item label="会员">{{ rechargeTarget.name }}</el-descriptions-item>
          <el-descriptions-item label="当前等级">
            <el-tag :type="LEVEL_META[rechargeTarget.level].tagType" size="small">
              {{ LEVEL_META[rechargeTarget.level].label }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="当前余额">{{ formatMoney(rechargeTarget.balance) }}</el-descriptions-item>
        </el-descriptions>

        <div class="quick-amounts">
          <el-button
            v-for="amount in quickAmounts"
            :key="amount"
            :type="rechargeAmount === amount ? 'primary' : 'default'"
            size="small"
            @click="rechargeAmount = amount"
          >
            ￥{{ amount }}
          </el-button>
        </div>

        <el-input-number
          v-model="rechargeAmount"
          :min="1"
          :max="50000"
          :step="50"
          style="width: 100%; margin-top: 12px"
        />
      </template>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="rechargeSaving" @click="submitRecharge">确认充值</el-button>
      </template>
    </el-dialog>
  </div>
</template>
