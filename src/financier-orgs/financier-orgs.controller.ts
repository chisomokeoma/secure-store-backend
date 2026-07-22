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
import { CurrentUser } from '../common/decorators/user.decorator';
import { FinancierOrgsService } from './financier-orgs.service';
import {
  CreateFinancierOrgDto,
  InviteFinancierUserDto,
} from './dto/financier-orgs.dto';

/**
 * Tenant-Admin surface for provisioning and managing FinancierOrg
 * entities. Base path `/admin/financiers` matches the FE's
 * adminFinancierRoutes contract; the DB model is FinancierOrg but the
 * URL / user-facing term is "financier" throughout.
 *
 * Suspend / reactivate are POST endpoints (not PATCH status flips) —
 * matches FE and gives intent-carrying URLs for audit clarity.
 */
@ApiTags('Admin — Financiers')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/financiers')
export class FinancierOrgsController {
  constructor(private readonly service: FinancierOrgsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new financier (bank / FI) org and seed its first user in one atomic step. First user receives welcome email with system-issued alias + temp password; credentials also returned in response as email-delivery fallback.',
  })
  createFinancierOrg(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: CreateFinancierOrgDto,
  ) {
    return this.service.createFinancierOrg(tenantId, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      "List financiers in this tenant. Powers the FE's Financiers tab table. Each item includes `lienCount` (active liens) and `warehouseCount` (active warehouse links).",
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'SUSPENDED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listFinancierOrgs(
    @CurrentUser('tenantId') tenantId: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierOrgs(tenantId, {
      search,
      status,
      page,
      limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single financier with counts.' })
  @ApiParam({ name: 'id' })
  getFinancierOrg(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getFinancierOrg(tenantId, id);
  }

  @Get(':id/users')
  @ApiOperation({
    summary: 'List financier-role users belonging to this org (team tab).',
  })
  @ApiParam({ name: 'id' })
  listFinancierOrgUsers(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.listFinancierOrgUsers(tenantId, id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Suspend a financier org — blocks user invites and (once wired) the financier login flow. Idempotent: suspending an already-suspended org returns the current state without error.',
  })
  @ApiParam({ name: 'id' })
  suspendFinancierOrg(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.suspendFinancierOrg(tenantId, id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a suspended financier org. Idempotent.',
  })
  @ApiParam({ name: 'id' })
  reactivateFinancierOrg(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.reactivateFinancierOrg(tenantId, id);
  }

  @Post(':id/users')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite an additional user to an existing financier org. Same invite pattern as first user. Blocked when the org is SUSPENDED.',
  })
  @ApiParam({ name: 'id' })
  inviteFinancierUser(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: InviteFinancierUserDto,
  ) {
    return this.service.inviteFinancierUser(tenantId, id, dto);
  }
}
