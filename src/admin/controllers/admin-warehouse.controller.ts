import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
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

  // --- Warehouse CRUD ---

  @Get()
  @ApiOperation({ summary: 'List all warehouses for the tenant' })
  getWarehouses(@CurrentUser('tenantId') tenantId: string) {
    return this.adminWarehouseService.getWarehouses(tenantId);
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
        code: { type: 'string' },
        capacityMt: { type: 'number' },
      },
    },
  })
  createWarehouse(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: any,
  ) {
    return this.adminWarehouseService.createWarehouse(tenantId, body);
  }

  // --- Warehouse Manager User Management ---

  @Get('managers')
  @ApiOperation({ summary: 'List all Warehouse Managers in the tenant' })
  getManagers(@CurrentUser('tenantId') tenantId: string) {
    return this.adminWarehouseService.getManagers(tenantId);
  }

  @Post('managers')
  @ApiOperation({ summary: 'Create a new Warehouse Manager user account' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'firstName', 'lastName', 'password'],
      properties: {
        email: { type: 'string', example: 'manager@warehouse.com' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        password: { type: 'string', example: 'SecurePass123!' },
        phoneNumber: { type: 'string' },
      },
    },
  })
  createManager(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: any,
  ) {
    return this.adminWarehouseService.createManager(tenantId, body);
  }

  // --- Manager Assignment to Warehouse ---

  @Post(':id/managers')
  @ApiOperation({ summary: 'Assign an existing Warehouse Manager to a warehouse' })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['managerId'],
      properties: {
        managerId: { type: 'string' },
      },
    },
  })
  assignManager(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('managerId') managerId: string,
  ) {
    return this.adminWarehouseService.assignManager(tenantId, id, managerId, userId);
  }

  @Delete(':id/managers/:managerId')
  @ApiOperation({ summary: 'Unassign a Warehouse Manager from a warehouse' })
  @ApiParam({ name: 'id', description: 'Warehouse ID' })
  @ApiParam({ name: 'managerId', description: 'Manager User ID' })
  unassignManager(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') warehouseId: string,
    @Param('managerId') managerId: string,
  ) {
    return this.adminWarehouseService.unassignManager(tenantId, warehouseId, managerId);
  }
}
