import type { FeatureItem, KpiItem, OperationRecord } from "../types";

export const localFeatures: FeatureItem[] = [
  {
    "id": 1,
    "title": "桌游库管理与分类",
    "description": "录入桌游信息（名称、类型、适合人数、时长、难度、简介），上传封面图，按类型（策略/聚会/角色扮演/卡牌）分类管理，记录库存数量。",
    "status": "已上线",
    "metric": "88%"
  },
  {
    "id": 2,
    "title": "组局拼车与缺人招募",
    "description": "玩家发起组局（选择桌游、时间、人数），发布到拼车广场招募队友，其他玩家可报名加入，满员后自动锁定。",
    "status": "排期中",
    "metric": "31 单"
  },
  {
    "id": 3,
    "title": "战绩记录与排行榜",
    "description": "记录每局桌游的参与者、胜负结果、时长，生成个人胜率排行榜和常用桌游统计，玩家可查看自己的桌游生涯数据。",
    "status": "巡检中",
    "metric": "10 项"
  },
  {
    "id": 4,
    "title": "包厢预约与会员储值",
    "description": "展示桌游吧包厢信息（容纳人数、设施），支持按时段预约，会员可充值储值，消费时享受会员折扣和积分累积。",
    "status": "优化中",
    "metric": "4 级"
  },
  {
    "id": 5,
    "title": "活动赛事发布",
    "description": "门店发布桌游赛事活动（如狼人杀锦标赛、剧本杀推理赛），玩家报名参赛，系统自动分组和记录比赛成绩，颁发虚拟奖牌。",
    "status": "可导出",
    "metric": "28 条"
  }
];

export const localKpis: KpiItem[] = [
  {
    "label": "今日处理",
    "value": "118",
    "trend": "+12%",
    "tone": "primary"
  },
  {
    "label": "预约/订单",
    "value": "61",
    "trend": "+8%",
    "tone": "warm"
  },
  {
    "label": "履约率",
    "value": "89%",
    "trend": "+3%",
    "tone": "cool"
  },
  {
    "label": "待处理",
    "value": "10",
    "trend": "需跟进",
    "tone": "neutral"
  }
];

export const operationRecords: OperationRecord[] = [
  {
    "key": "lpboardgame-1",
    "name": "桌游库管理与分类",
    "owner": "运营组",
    "status": "已上线",
    "metric": "88%",
    "priority": "高"
  },
  {
    "key": "lpboardgame-2",
    "name": "组局拼车与缺人招募",
    "owner": "管理员",
    "status": "排期中",
    "metric": "31 单",
    "priority": "中"
  },
  {
    "key": "lpboardgame-3",
    "name": "战绩记录与排行榜",
    "owner": "服务台",
    "status": "巡检中",
    "metric": "10 项",
    "priority": "低"
  },
  {
    "key": "lpboardgame-4",
    "name": "包厢预约与会员储值",
    "owner": "财务组",
    "status": "优化中",
    "metric": "4 级",
    "priority": "高"
  },
  {
    "key": "lpboardgame-5",
    "name": "活动赛事发布",
    "owner": "审核组",
    "status": "可导出",
    "metric": "28 条",
    "priority": "中"
  }
];
