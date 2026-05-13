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

  @ApiProperty({ description: 'Warehouses registered in the last 2 months' })
  warehousesDelta!: number;

  @ApiProperty()
  totalClients!: number;

  @ApiProperty({ description: 'Clients registered in the last 2 months' })
  clientsDelta!: number;

  @ApiProperty({
    description: 'Total commodity volume in metric tons (ACTIVE/PLEDGED/LIEN)',
  })
  totalCommodity!: number;

  @ApiProperty({
    description: 'Commodity (metric tons) collected in the last 2 months',
  })
  commodityDelta!: number;

  @ApiProperty()
  pendingRequests!: number;

  @ApiProperty({
    description: 'New pending requests raised in the last 2 months',
  })
  pendingRequestsDelta!: number;
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
