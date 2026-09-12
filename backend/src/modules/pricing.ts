import type { MemberLevel } from "../db/types";

/** 会员等级折扣配置：青铜原价，银卡 9 折，金卡 8 折。 */
export const LEVEL_RULES: Record<MemberLevel, { label: string; discount: number }> = {
  bronze: { label: "青铜会员", discount: 1.0 },
  silver: { label: "白银会员", discount: 0.9 },
  gold: { label: "黄金会员", discount: 0.8 },
};

/** 每消费 1 元累积 1 积分。 */
export const POINTS_PER_YUAN = 1;

/** 充值累计达到对应金额自动升级。 */
export const LEVEL_THRESHOLDS: { level: MemberLevel; minTotalRecharge: number }[] = [
  { level: "gold", minTotalRecharge: 2000 },
  { level: "silver", minTotalRecharge: 500 },
  { level: "bronze", minTotalRecharge: 0 },
];

export function levelForTotalRecharge(totalRecharge: number): MemberLevel {
  for (const rule of LEVEL_THRESHOLDS) {
    if (totalRecharge >= rule.minTotalRecharge) {
      return rule.level;
    }
  }
  return "bronze";
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 计费时长：按半小时向上取整，不足半小时按半小时计。 */
export function billedHours(startTime: string, endTime: string): number {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("预约结束时间必须晚于开始时间");
  }
  const hours = (endMs - startMs) / 3_600_000;
  return Math.ceil(hours * 2) / 2;
}

export interface PriceQuote {
  hours: number;
  baseAmount: number;
  discount: number;
  chargedAmount: number;
  pointsEarned: number;
}

/** 计算会员价：原价 × 等级折扣，积分按实付金额向下取整。 */
export function quotePrice(
  hourlyRate: number,
  startTime: string,
  endTime: string,
  level: MemberLevel,
): PriceQuote {
  const hours = billedHours(startTime, endTime);
  const discount = LEVEL_RULES[level].discount;
  const baseAmount = round2(hourlyRate * hours);
  const chargedAmount = round2(baseAmount * discount);
  const pointsEarned = Math.floor(chargedAmount * POINTS_PER_YUAN);
  return { hours, baseAmount, discount, chargedAmount, pointsEarned };
}

/** 半开区间判断：[start,end) 重叠才视为冲突，首尾相接（10:00-11:00 与 11:00-12:00）允许。 */
export function intervalsOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  return new Date(startA) < new Date(endB) && new Date(startB) < new Date(endA);
}
