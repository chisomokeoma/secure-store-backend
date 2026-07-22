import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { FinancierSelfService } from './financier-self.service';
import { UpdateFinancierSettingsDto } from '../financier-orgs/dto/financier-orgs.dto';

/**
 * Financier-facing endpoints on /financier/*. Every handler in here
 * scopes to the caller's own FinancierOrg via the JWT — we never accept
 * a financierOrgId from the request. The FINANCIER role is required
 * globally; TENANT_ADMIN / GLOBAL_ADMIN are NOT allowed access to
 * these routes (they have their own admin-facing paths).
 *
 * Phase 2 responsibilities:
 *   GET  /financier/me                          — self + org profile
 *   GET  /financier/dashboard                   — empty-state summary
 *   GET  /financier/settings/pledge-config      — Q1 TTL settings read
 *   PATCH /financier/settings/pledge-config     — Q1 TTL settings write
 *
 * Phase 3–5 will grow this file (warehouse onboarding, pledge inbox,
 * lien portfolio, release approvals). Splitting into sub-controllers
 * once things sprawl is a straightforward refactor when the time comes.
 */
@ApiTags('Financier — Self')
@ApiBearerAuth()
@Roles('FINANCIER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financier')
export class FinancierSelfController {
  constructor(private readonly service: FinancierSelfService) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Get the signed-in financier user profile plus their FinancierOrg context (name, license, logo, status, per-org pledge-TTL override).',
  })
  getSelf(@CurrentUser('id') userId: string) {
    return this.service.getSelf(userId);
  }

  @Get('dashboard')
  @ApiOperation({
    summary:
      "Financier's dashboard summary. Shape matches FE FinancierDashboardSummary type. Phase 2 returns live counts for pending pledges + release requests + active warehouse links; other exposure figures return empty-state zeros until Phase 4/5 wires them.",
  })
  getDashboard(@CurrentUser('id') userId: string) {
    return this.service.getDashboard(userId);
  }

  @Get('settings')
  @ApiOperation({
    summary:
      "Read the org's settings — currently just the Q1 pledge-TTL override. Shape: { pledgeTtlDays, isDefault }. pledgeTtlDays=null + isDefault=true means the platform default (7d) is in force.",
  })
  getSettings(@CurrentUser('id') userId: string) {
    return this.service.getSettings(userId);
  }

  @Patch('settings')
  @ApiOperation({
    summary:
      "Update the org's settings. Send `pledgeTtlDays: null` to clear the override and revert to the platform default; send integer 1-90 to set a custom window. Snapshot rule: changes only affect pledges created AFTER save; existing pending pledges keep their expiresAt.",
  })
  updateSettings(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateFinancierSettingsDto,
  ) {
    return this.service.updateSettings(userId, dto);
  }
}
