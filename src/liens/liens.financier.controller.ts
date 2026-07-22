import {
  Controller,
  Get,
  Param,
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
import { LiensService } from './liens.service';

/**
 * Financier's Lien Portfolio (/financier/liens/*). Read-only in Phase 4;
 * writes (release-approval, force-release) come in Phase 5 / 6.
 */
@ApiTags('Financier — Liens')
@ApiBearerAuth()
@Roles('FINANCIER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financier/liens')
export class LiensFinancierController {
  constructor(private readonly service: LiensService) {}

  @Get()
  @ApiOperation({
    summary:
      "Lien portfolio for this financier. Filterable by status / client / warehouse / commodity. Each item includes original vs remaining quantity, current valuation (per Q2 automatic per market data), and status.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED', 'FORCE_RELEASED'],
  })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'commodity', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listFinancierLiens(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('clientId') clientId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('commodity') commodity?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierLiens(userId, {
      status,
      clientId,
      warehouseId,
      commodity,
      page,
      limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lien detail. Same shape as list items.' })
  @ApiParam({ name: 'id' })
  getFinancierLienDetail(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.getFinancierLienDetail(userId, id);
  }
}
