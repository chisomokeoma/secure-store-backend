export class DashboardSummaryDto {
  totalVolume!: number;
  activeReceipts!: number;
  totalValue!: number;
}

export class CommodityBreakdownDto {
  commodityName!: string;
  percentage!: number;
}

export class ActivityTrendDto {
  date!: string;
  activityCount!: number;
}

export class SystemStatusDto {
  isOperational!: boolean;
  lastChecked!: Date;
}
