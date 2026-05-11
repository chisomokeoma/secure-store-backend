import { ApiProperty } from '@nestjs/swagger';

export enum ActivityType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
  LOAN = 'LOAN',
  TRADE = 'TRADE',
}

export class DashboardSummaryDto {
  @ApiProperty()
  totalWarehouses!: number;

  @ApiProperty()
  totalClients!: number;

  @ApiProperty()
  totalCommodity!: number; // Simplified to number for total volume

  @ApiProperty()
  pendingRequests!: number;
}

export class CommodityBreakdownDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  quantity!: number;
}

export class ActivityTrendDto {
  @ApiProperty()
  date!: string;

  @ApiProperty()
  deposits!: number;

  @ApiProperty()
  withdrawals!: number;

  @ApiProperty()
  activityCount!: number;
}

export class RecentActivityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ActivityType })
  type!: ActivityType;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  timestamp!: Date;

  @ApiProperty()
  reference!: string;

  @ApiProperty()
  status!: string;
}
