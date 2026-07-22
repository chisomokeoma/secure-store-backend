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
import { OnboardWarehouseDto } from '../financier-orgs/dto/financier-orgs.dto';

/**
 * Financier-facing warehouse endpoints on /financier/warehouses/*.
 * Contract: FE financierRoutes in src/api/endpoints/collateral.ts.
 */
@ApiTags('Financier — Warehouses')
@ApiBearerAuth()
@Roles('FINANCIER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financier')
export class FinancierWarehousesController {
  constructor(private readonly service: WarehouseLinksService) {}

  @Get('warehouses/available')
  @ApiOperation({
    summary:
      'Warehouses in this tenant that this financier could still onboard — excludes warehouses that already have a PENDING or ACTIVE link with this org. Powers the Onboard Warehouse modal picker.',
  })
  listAvailableWarehouses(@CurrentUser('id') userId: string) {
    return this.service.listAvailableWarehouses(userId);
  }

  @Get('warehouses')
  @ApiOperation({
    summary:
      "The financier's own warehouse links (all statuses, filtered). Powers the Warehouses screen table. Phase 4 populates totalStockValue / lienedValue / clientCount; Phase 3 returns them as null.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'ACTIVE', 'OFFBOARDED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listFinancierWarehouses(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierWarehouses(userId, { status, page, limit });
  }

  @Post('warehouses/:warehouseId/onboard')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Submit a warehouse-onboarding request. `agreementDocUrl` must be a URL from POST /storage/upload?kind=AGREEMENT_DOC. Creates a PENDING WarehouseLink; notifies the tenant admins for approval.",
  })
  @ApiParam({ name: 'warehouseId' })
  onboardWarehouse(
    @CurrentUser('id') userId: string,
    @Param('warehouseId') warehouseId: string,
    @Body() dto: OnboardWarehouseDto,
  ) {
    return this.service.onboardWarehouse(userId, warehouseId, dto.agreementDocUrl);
  }

  @Post('warehouse-links/:id/offboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Offboard an ACTIVE warehouse link. Blocked (409 ACTIVE_LIENS_EXIST) when the financier still holds active liens in that warehouse — release them first.',
  })
  @ApiParam({ name: 'id' })
  offboardWarehouse(
    @CurrentUser('id') userId: string,
    @Param('id') linkId: string,
  ) {
    return this.service.offboardWarehouse(userId, linkId);
  }
}
