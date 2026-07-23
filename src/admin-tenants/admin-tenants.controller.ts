import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminTenantsService } from './admin-tenants.service';
import {
  CreateTenantDto,
  SuspendTenantDto,
} from './dto/admin-tenants.dto';

/**
 * Global-Admin surface for managing tenants (institutions).
 * Base path `/admin/tenants` matches the FE's adminGlobalRoutes contract.
 *
 * GLOBAL_ADMIN only — a tenant admin cannot see or manage other tenants.
 */
@ApiTags('Global Admin — Tenants')
@ApiBearerAuth()
@Roles('GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(private readonly service: AdminTenantsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List all tenants on the platform (institutions). Powers the GA Institutions table. Row shape: TenantAdminItem with warehouseCount / managerCount / clientCount rollups.',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'SUSPENDED'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listTenants(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listTenants({ search, status, page, limit });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Create a tenant AND its first TENANT_ADMIN in one atomic step. Slug is derived from name when omitted. Response includes one-time credentials for the hand-off screen; welcome email is also delivered to the admin's real inbox.",
  })
  createTenant(@Body() dto: CreateTenantDto) {
    return this.service.createTenant(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Rich tenant detail: TenantAdminItem + commercial contact block + rollups (receiptCount, activeLienCount, storedValue, lienedValue in NGN).',
  })
  @ApiParam({ name: 'id' })
  getTenantDetail(@Param('id') id: string) {
    return this.service.getTenantDetail(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Suspend a tenant — blocks new sign-ins for its users; existing sessions expire naturally. Stored commodities and existing liens are untouched. Reversible. Idempotent (suspending an already-suspended tenant returns current state). Reason lands on the audit trail.",
  })
  @ApiParam({ name: 'id' })
  suspendTenant(
    @Param('id') id: string,
    @Body() dto: SuspendTenantDto,
  ) {
    return this.service.suspendTenant(id, dto);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended tenant. Idempotent.' })
  @ApiParam({ name: 'id' })
  reactivateTenant(@Param('id') id: string) {
    return this.service.reactivateTenant(id);
  }

  @Get(':id/managers')
  @ApiOperation({
    summary:
      "Warehouse managers employed by this tenant. Read-only drill-down for the GA — the GA does not hire/manage; the TA does.",
  })
  @ApiParam({ name: 'id' })
  listTenantManagers(@Param('id') id: string) {
    return this.service.listTenantManagers(id);
  }

  @Get(':id/warehouses')
  @ApiOperation({
    summary:
      'Warehouses owned by this tenant with utilisation meter + rollups (managerCount / clientCount / activeReceipts). Read-only.',
  })
  @ApiParam({ name: 'id' })
  listTenantWarehouses(@Param('id') id: string) {
    return this.service.listTenantWarehouses(id);
  }
}
