import type { MemberLevel } from "../types/operations";

export const LEVEL_META: Record<MemberLevel, { label: string; discount: number; tagType: "info" | "warning" | "danger" }> = {
  bronze: { label: "青铜会员", discount: 1.0, tagType: "info" },
  silver: { label: "白银会员", discount: 0.9, tagType: "warning" },
  gold: { label: "黄金会员", discount: 0.8, tagType: "danger" },
};

/** 表格插槽里的 row 类型为 any，用字符串安全索引。 */
export function levelMeta(level: string) {
  return LEVEL_META[level as MemberLevel] ?? LEVEL_META.bronze;
}

export function formatMoney(value: number): string {
  return `￥${value.toFixed(2)}`;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
