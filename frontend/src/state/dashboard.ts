import { localFeatures, localKpis, operationRecords } from "../data/workbench";
import type { OverviewResponse } from "../types";
import { APP_CODE, APP_NAME } from "../constants/app";

export function createFallbackOverview(): OverviewResponse {
  return {
    appName: APP_NAME,
    appCode: APP_CODE,
    description: "面向桌游爱好者，提供桌游库管理、组局拼车和战绩追踪的社交化桌游吧运营平台。",
    features: localFeatures,
    kpis: localKpis,
    records: operationRecords,
  };
}
