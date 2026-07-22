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
import { CurrentUser } from '../common/decorators/user.decorator';
import { PledgesService } from './pledges.service';
import { CreatePledgeDto } from './dto/pledges.dto';

/**
 * Client-side pledge + encumbrance surface under /me/*.
 * Contract: collateralRoutes in src/api/endpoints/collateral.ts.
 *
 * No role restriction — a CLIENT hits these. WM / TA / GA may also reach
 * some of them (e.g. when a WM acts on behalf of a client via on-behalf
 * flows), but pledge creation is client-only for now.
 */
@ApiTags('Me — Collateral')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class PledgesMeController {
  constructor(private readonly service: PledgesService) {}

  @Get('receipts/:id/encumbrance')
  @ApiOperation({
    summary:
      "Volume-accounting breakdown for a receipt: available / pledgePending / liened / releasePending. The single most important contract in the collateral flow — every guard downstream derives from these numbers. Also embeds active liens + pending pledges for the FE's receipt-detail view.",
  })
  @ApiParam({ name: 'id' })
  getReceiptEncumbrance(
    @CurrentUser('id') userId: string,
    @Param('id') receiptId: string,
  ) {
    return this.service.getReceiptEncumbrance(userId, receiptId);
  }

  @Get('receipts/:id/valuation')
  @ApiOperation({
    summary:
      "Current per-unit market price for a receipt's commodity. Powers the FE's 'Market price today' row and the live 'Estimated market worth' calculation as the client types a pledge quantity. Read-only mirror of the same lookup PledgesService.createPledge runs internally — same tenant, same commodity, same latest effectiveAt row. 404 with code NO_PRICE_ON_FILE when no price row exists so the FE silently collapses the price rows.",
  })
  @ApiParam({ name: 'id' })
  getReceiptValuation(
    @CurrentUser('id') userId: string,
    @Param('id') receiptId: string,
  ) {
    return this.service.getReceiptValuation(userId, receiptId);
  }

  @Get('financiers')
  @ApiOperation({
    summary:
      "Financiers with an ACTIVE WarehouseLink to the given warehouse. Feed for the pledge flow's 'pick a financier' dropdown.",
  })
  @ApiQuery({ name: 'warehouseId', required: true })
  financiersForWarehouse(
    @CurrentUser('id') userId: string,
    @Query('warehouseId') warehouseId: string,
  ) {
    return this.service.financiersForWarehouse(userId, warehouseId);
  }

  @Post('pledges')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit a pledge. Volume is held immediately (out of `available` into HELD_PLEDGE_PENDING); financier reviews and accepts / rejects. TTL applied per financier or platform default. Errors: INSUFFICIENT_AVAILABLE_VOLUME, FINANCIER_NOT_ONBOARDED, RECEIPT_NOT_PLEDGEABLE.',
  })
  createPledge(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePledgeDto,
  ) {
    return this.service.createPledge(userId, dto);
  }

  @Get('pledges')
  @ApiOperation({
    summary:
      "List the caller's pledges (status filterable). Items embed receipt + financier + warehouse summaries.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listMyPledges(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listMyPledges(userId, { status, page, limit });
  }

  @Post('pledges/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a pledge. Only allowed while PENDING. Releases the held volume back to available.',
  })
  @ApiParam({ name: 'id' })
  cancelPledge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.cancelPledge(userId, id);
  }
}
