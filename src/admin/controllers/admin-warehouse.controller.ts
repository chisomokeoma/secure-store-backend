import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
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
  constructor(private readonly adminWarehouseService: AdminWarehouseService) {}

  @Get()
  @ApiOperation({ summary: 'List all warehouses for the tenant' })
  getWarehouses(@CurrentUser('tenantId') tenantId: string) {
    return this.adminWarehouseService.getWarehouses(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new warehouse' })
  createWarehouse(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: any,
  ) {
    return this.adminWarehouseService.createWarehouse(tenantId, body);
  }

  @Post(':id/managers')
  @ApiOperation({ summary: 'Assign a manager to a warehouse' })
  assignManager(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('managerId') managerId: string,
  ) {
    return this.adminWarehouseService.assignManager(
      tenantId,
      id,
      managerId,
      userId,
    );
  }
}
