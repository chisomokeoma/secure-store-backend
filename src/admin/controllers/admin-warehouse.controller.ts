import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam, ApiBody } from '@nestjs/swagger';
import { AdminWarehouseService } from '../services/admin-warehouse.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Warehouses')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/warehouses')
export class AdminWarehouseController {
  constructor(private readonly service: AdminWarehouseService) {}

  @Get()
  @ApiOperation({ summary: 'List all warehouses with stats and filters' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getWarehouses(tenantId, { status, search, page, limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get full warehouse detail with managers, summary, recent receipts' })
  getWarehouseById(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getWarehouseById(tenantId, id);
  }

  @Get(':id/receipts')
  @ApiOperation({ summary: 'Get receipts for a specific warehouse' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'approvalStatus', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getWarehouseReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('approvalStatus') approvalStatus?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getWarehouseReceipts(tenantId, id, { status, approvalStatus, page, limit });
  }

  @Get(':id/managers')
  @ApiOperation({ summary: 'Get managers currently assigned to a warehouse' })
  getWarehouseManagers(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getWarehouseManagers(tenantId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new warehouse' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'location'],
      properties: {
        name: { type: 'string' },
        location: { type: 'string' },
        code: { type: 'string', example: 'WHS-001' },
        type: { type: 'string', example: 'DRY_GOODS' },
        state: { type: 'string', example: 'Kano State' },
        address: { type: 'string' },
        capacityMt: { type: 'number' },
        commodityIds: { type: 'array', items: { type: 'string' } },
        managerIds: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  createWarehouse(@CurrentUser('tenantId') tenantId: string, @Body() body: any) {
    return this.service.createWarehouse(tenantId, body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update warehouse details' })
  updateWarehouse(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.service.updateWarehouse(tenantId, id, body);
  }

  @Post(':id/assign-managers')
  @ApiOperation({ summary: 'Bulk assign managers to a warehouse' })
  @ApiBody({ schema: { type: 'object', properties: { managerIds: { type: 'array', items: { type: 'string' } } } } })
  assignManagers(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('managerIds') managerIds: string[],
  ) {
    return this.service.assignManagers(tenantId, id, managerIds, userId);
  }

  @Post(':id/commodities')
  @ApiOperation({ summary: 'Link a commodity to a warehouse' })
  @ApiBody({ schema: { type: 'object', properties: { commodityId: { type: 'string' } } } })
  addCommodity(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body('commodityId') commodityId: string,
  ) {
    return this.service.addCommodity(tenantId, id, commodityId);
  }

  @Delete(':id/commodities/:commodityId')
  @ApiOperation({ summary: 'Unlink a commodity from a warehouse' })
  removeCommodity(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Param('commodityId') commodityId: string,
  ) {
    return this.service.removeCommodity(tenantId, id, commodityId);
  }
}
