import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { FinancierOrgsService } from './financier-orgs.service';
import {
  CreateFinancierOrgDto,
  InviteFinancierUserDto,
  OffboardFinancierOrgDto,
  UpdateFinancierOrgDto,
} from './dto/financier-orgs.dto';

/**
 * Admin surface for provisioning and managing FinancierOrg entities.
 *
 * NOTE ON ROLE (2026-07-22): FinancierOrg is a PLATFORM-LEVEL entity
 * (peer to Tenant), created and administered by GLOBAL_ADMIN. During
 * the FE cutover from the old TA-side "Financiers" tab to the new
 * Global-Admin console, both roles are accepted here. Once the FE
 * moves fully off the TA path, TENANT_ADMIN can be dropped from the
 * @Roles decorator without any endpoint URL churn.
 *
 * Base path `/admin/financiers` is preserved so the currently-shipped
 * FE keeps working. If we later want a clean `/global-admin/financiers`
 * namespace, we add a mirror controller that delegates to this same
 * service — no service-layer changes needed.
 */
@ApiTags('Admin — Financiers')
@ApiBearerAuth()
// Class-level default: both roles can access the base surface (list, get,
// list users). Individual mutations narrow to GLOBAL_ADMIN via their
// own @Roles decorator per the FE spec (backend-spec-global-admin.md §7).
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/financiers')
export class FinancierOrgsController {
  constructor(private readonly service: FinancierOrgsService) {}

  @Post()
  @Roles('GLOBAL_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new financier (bank / FI) org and seed its first user in one atomic step. GLOBAL_ADMIN only. First user receives welcome email with system-issued alias + temp password; credentials also returned in response as email-delivery fallback.',
  })
  createFinancierOrg(@Body() dto: CreateFinancierOrgDto) {
    return this.service.createFinancierOrg(dto);
  }

  @Get()
  @ApiOperation({
    summary:
      "List financiers on the platform (no tenant scoping — financiers are platform-level entities). Powers the admin Financiers table. Each item includes `lienCount` (active liens) and `warehouseCount` (active warehouse links).",
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'SUSPENDED', 'OFFBOARDED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listFinancierOrgs(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierOrgs({ search, status, page, limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single financier with counts + basic-KYC block.' })
  @ApiParam({ name: 'id' })
  getFinancierOrg(@Param('id') id: string) {
    return this.service.getFinancierOrg(id);
  }

  @Patch(':id')
  @Roles('GLOBAL_ADMIN')
  @ApiOperation({
    summary:
      "Edit the financier's identity + basic-KYC fields (name, license, logo, contact block, TIN, regulator, website). GLOBAL_ADMIN only. Status transitions go through the dedicated verb endpoints (/suspend, /reactivate, /offboard), NOT this patch.",
  })
  @ApiParam({ name: 'id' })
  updateFinancierOrg(
    @Param('id') id: string,
    @Body() dto: UpdateFinancierOrgDto,
  ) {
    return this.service.updateFinancierOrg(id, dto);
  }

  @Get(':id/users')
  @ApiOperation({
    summary: 'List financier-role users belonging to this org (team tab).',
  })
  @ApiParam({ name: 'id' })
  listFinancierOrgUsers(@Param('id') id: string) {
    return this.service.listFinancierOrgUsers(id);
  }

  @Post(':id/suspend')
  @Roles('GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Suspend (disable) a financier org — reversible pause. GLOBAL_ADMIN only. Blocks new user invites and (once wired) the financier login flow. Existing liens remain manageable — you can still process releases against a suspended bank. Idempotent: suspending an already-suspended org returns the current state without error. Rejected if the org is OFFBOARDED (terminal).",
  })
  @ApiParam({ name: 'id' })
  suspendFinancierOrg(@Param('id') id: string) {
    return this.service.suspendFinancierOrg(id);
  }

  @Post(':id/reactivate')
  @Roles('GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reactivate a suspended financier org. GLOBAL_ADMIN only. Idempotent. Rejected if the org is OFFBOARDED — offboarding is terminal, a returning financier is a new org.",
  })
  @ApiParam({ name: 'id' })
  reactivateFinancierOrg(@Param('id') id: string) {
    return this.service.reactivateFinancierOrg(id);
  }

  @Post(':id/offboard')
  @Roles('GLOBAL_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Terminal offboard of a financier org. GLOBAL_ADMIN only. Blocked with 409 { code: "ACTIVE_LIENS_EXIST", activeLienCount } if the financier still holds active liens. Idempotent when the org is already OFFBOARDED. Reason is mandatory and lands in the notification body to the financier\'s users.',
  })
  @ApiParam({ name: 'id' })
  offboardFinancierOrg(
    @Param('id') id: string,
    @Body() dto: OffboardFinancierOrgDto,
  ) {
    return this.service.offboardFinancierOrg(id, dto);
  }

  @Post(':id/users')
  @Roles('GLOBAL_ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite an additional user to an existing financier org. GLOBAL_ADMIN only. Same invite pattern as first user. Blocked when the org is SUSPENDED or OFFBOARDED.',
  })
  @ApiParam({ name: 'id' })
  inviteFinancierUser(
    @Param('id') id: string,
    @Body() dto: InviteFinancierUserDto,
  ) {
    return this.service.inviteFinancierUser(id, dto);
  }
}
