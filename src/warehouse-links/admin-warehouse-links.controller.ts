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
import { WarehouseLinksService } from './warehouse-links.service';
import { RejectWarehouseLinkDto } from '../financier-orgs/dto/financier-orgs.dto';

/**
 * TA-facing warehouse-link approval queue on /admin/warehouse-links/*.
 * Contract: FE adminFinancierRoutes.warehouseLinks in
 * src/api/endpoints/collateral.ts.
 *
 * Rejection semantics: PENDING → OFFBOARDED with `decisionReason` set
 * (the FE type enum has no REJECTED state, so rejection folds into
 * OFFBOARDED with the reason capturing intent).
 */
@ApiTags('Admin — Warehouse Onboarding Requests')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/warehouse-links')
export class AdminWarehouseLinksController {
  constructor(private readonly service: WarehouseLinksService) {}

  @Get()
  @ApiOperation({
    summary:
      "List warehouse-onboarding submissions across the tenant. Defaults to filtering PENDING (the FE queue defaults to 'Awaiting Review'). Each item embeds the financier + warehouse for the FE table.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'ACTIVE', 'OFFBOARDED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listAdminWarehouseLinks(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAdminWarehouseLinks(tenantId, {
      status,
      page,
      limit,
    });
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Approve a pending warehouse-onboarding request → ACTIVE. Sets signedAt = now. Notifies all financier-org users. From this point the financier is visible in this warehouse's client-pledge dropdown.",
  })
  @ApiParam({ name: 'id' })
  approveWarehouseLink(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') adminUserId: string,
    @Param('id') linkId: string,
  ) {
    return this.service.approveWarehouseLink(tenantId, adminUserId, linkId);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reject a pending onboarding request → OFFBOARDED with `decisionReason` captured. The financier can re-submit later (a new PENDING row).",
  })
  @ApiParam({ name: 'id' })
  rejectWarehouseLink(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') adminUserId: string,
    @Param('id') linkId: string,
    @Body() dto: RejectWarehouseLinkDto,
  ) {
    return this.service.rejectWarehouseLink(
      tenantId,
      adminUserId,
      linkId,
      dto.reason,
    );
  }
}
