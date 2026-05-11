import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { ManagersService } from './managers.service';
import {
  CreateManagerDto,
  UpdateManagerDto,
  AssignWarehousesDto,
} from './dto/manager.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Admin Managers')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/managers')
export class ManagersController {
  constructor(private readonly managersService: ManagersService) {}

  @Get()
  @ApiOperation({ summary: 'List all warehouse managers with stats and pagination' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DEACTIVATED'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getManagers(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.managersService.getManagers(tenantId, { status, search, page, limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single manager by ID' })
  @ApiParam({ name: 'id' })
  getManagerById(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.getManagerById(tenantId, id);
  }

  @Get(':id/warehouses')
  @ApiOperation({ summary: 'Get warehouses currently assigned to a manager' })
  @ApiParam({ name: 'id' })
  getManagerWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.getManagerWarehouses(tenantId, id);
  }

  @Get(':id/clients')
  @ApiOperation({ summary: 'Get clients whose receipts are in warehouses managed by this manager' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getManagerClients(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.managersService.getManagerClients(tenantId, id, { status, page, limit });
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new warehouse manager',
    description: 'Auto-generates login email, manager code, and temporary password. Returns credentials ONCE.',
  })
  createManager(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: CreateManagerDto,
  ) {
    return this.managersService.createManager(tenantId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update manager profile or permissions' })
  @ApiParam({ name: 'id' })
  updateManager(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateManagerDto,
  ) {
    return this.managersService.updateManager(tenantId, id, dto);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate a manager account' })
  @ApiParam({ name: 'id' })
  activateManager(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.activateManager(tenantId, id);
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a manager account' })
  @ApiParam({ name: 'id' })
  deactivateManager(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.deactivateManager(tenantId, id);
  }

  @Post(':id/suspend')
  @ApiOperation({ summary: 'Suspend a manager account' })
  @ApiParam({ name: 'id' })
  suspendManager(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.suspendManager(tenantId, id);
  }

  @Post(':id/assign-warehouses')
  @ApiOperation({ summary: 'Bulk assign warehouses to a manager (additive, idempotent)' })
  @ApiParam({ name: 'id' })
  assignWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AssignWarehousesDto,
  ) {
    return this.managersService.assignWarehouses(tenantId, id, dto, userId);
  }

  @Delete(':id/warehouses/:warehouseId')
  @ApiOperation({ summary: 'Unassign a manager from a warehouse (soft delete)' })
  @ApiParam({ name: 'id', description: 'Manager ID' })
  @ApiParam({ name: 'warehouseId' })
  unassignWarehouse(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.managersService.unassignWarehouse(tenantId, id, warehouseId);
  }

  @Post(':id/reset-password')
  @ApiOperation({
    summary: 'Reset manager password',
    description: 'Generates a new temp password. Returns credentials ONCE.',
  })
  @ApiParam({ name: 'id' })
  resetPassword(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.managersService.resetPassword(tenantId, id);
  }
}
