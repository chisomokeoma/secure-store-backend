import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiBody } from '@nestjs/swagger';
import { StorageFeesService } from './storage-fees.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Admin Storage Fees (Settings)')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/storage-fees')
export class StorageFeesController {
  constructor(private readonly storageFeesService: StorageFeesService) {}

  @Get()
  @ApiOperation({ summary: 'List storage fee policies' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'commodityId', required: false })
  @ApiQuery({ name: 'isActive', required: false })
  getPolicies(
    @CurrentUser('tenantId') tenantId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('commodityId') commodityId?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.storageFeesService.getPolicies(tenantId, { warehouseId, commodityId, isActive });
  }

  @Post()
  @ApiOperation({ summary: 'Create a storage fee policy' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['feeType', 'rate', 'billingFrequency', 'gracePeriodDays', 'latePenaltyPct'],
      properties: {
        feeType: { type: 'string', enum: ['PER_MT_PER_MONTH', 'PER_BAG_PER_WEEK', 'PER_MT_PER_DAY', 'FLAT_RATE'] },
        warehouseId: { type: 'string', nullable: true },
        commodityId: { type: 'string', nullable: true },
        rate: { type: 'number', example: 500 },
        billingFrequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'] },
        gracePeriodDays: { type: 'integer', example: 7 },
        latePenaltyPct: { type: 'number', example: 5 },
        currency: { type: 'string', default: 'NGN' },
      },
    },
  })
  createPolicy(@CurrentUser('tenantId') tenantId: string, @Body() body: any) {
    return this.storageFeesService.createPolicy(tenantId, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a storage fee policy' })
  updatePolicy(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.storageFeesService.updatePolicy(tenantId, id, body);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate a policy' })
  activate(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.storageFeesService.activate(tenantId, id);
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a policy' })
  deactivate(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.storageFeesService.deactivate(tenantId, id);
  }
}
