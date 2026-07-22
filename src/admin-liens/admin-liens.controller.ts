import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { AdminLiensService } from './admin-liens.service';
import { ForceReleaseDto } from './dto/force-release.dto';

/**
 * Admin lien operations on /admin/liens/*.
 *
 * ⚠ Force-release is intentionally GLOBAL_ADMIN only (not TENANT_ADMIN).
 *   It's an exceptional court-order override that lifts a lien outside
 *   the normal financier-approved release flow. Concentrating this
 *   power at the platform level prevents tenant-side operators from
 *   quietly voiding a bank's collateral position.
 */
@ApiTags('Admin — Liens')
@ApiBearerAuth()
@Roles('GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/liens')
export class AdminLiensController {
  constructor(private readonly service: AdminLiensService) {}

  @Post(':id/force-release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Force-release a lien with a mandatory court order (§4). Both `reason` and `courtOrderDocUrl` required. Lien → FORCE_RELEASED; held volume returns to ACTIVE. Immutable ForceRelease audit row created. Notifies both financier and client. Idempotent — re-posting the same lien returns the existing force-release state.",
  })
  @ApiParam({ name: 'id' })
  forceReleaseLien(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') adminUserId: string,
    @Param('id') lienId: string,
    @Body() dto: ForceReleaseDto,
  ) {
    return this.service.forceReleaseLien(tenantId, adminUserId, lienId, dto);
  }

  @Get(':id/force-release')
  @ApiOperation({
    summary:
      "Read the force-release audit for a lien. Returns null in `forceRelease` if the lien wasn't force-released.",
  })
  @ApiParam({ name: 'id' })
  getForceReleaseDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') lienId: string,
  ) {
    return this.service.getForceReleaseDetail(tenantId, lienId);
  }
}
