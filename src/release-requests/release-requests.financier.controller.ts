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
import { ReleaseRequestsService } from './release-requests.service';
import {
  ApproveReleaseRequestDto,
  RejectReleaseRequestDto,
} from './dto/release-requests.dto';

/**
 * Financier-side release-request approvals under /financier/release-requests/*.
 * Contract: financierRoutes in src/api/endpoints/collateral.ts (§3.5).
 *
 * Approvals are 2FA-gated (POST /financier/otp/request { context:
 * RELEASE_APPROVE } first). All-or-nothing per request per spec §1.3.
 */
@ApiTags('Financier — Release Requests')
@ApiBearerAuth()
@Roles('FINANCIER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financier/release-requests')
export class ReleaseRequestsFinancierController {
  constructor(private readonly service: ReleaseRequestsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Release-request inbox for this financier. Sorted PENDING first, then everything else newest-first.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listFinancierReleaseRequests(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierReleaseRequests(userId, {
      status,
      page,
      limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Release-request detail for the decision screen.' })
  @ApiParam({ name: 'id' })
  getFinancierReleaseRequestDetail(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.getFinancierReleaseRequestDetail(userId, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Approve a release request atomically (all lines). 2FA-gated. Per-line: full release (line.quantity === lien.remainingQuantity) flips the HELD_LIEN leaf to ACTIVE; partial release splits the HELD_LIEN into ACTIVE + smaller HELD_LIEN. Lien.remainingQuantity decrements; status transitions to PARTIALLY_RELEASED or RELEASED.",
  })
  @ApiParam({ name: 'id' })
  approveReleaseRequest(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ApproveReleaseRequestDto,
  ) {
    return this.service.approveReleaseRequest(userId, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reject a release request with a mandatory reason. Volume stays liened (releasePending leaves that bucket).',
  })
  @ApiParam({ name: 'id' })
  rejectReleaseRequest(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: RejectReleaseRequestDto,
  ) {
    return this.service.rejectReleaseRequest(userId, id, dto);
  }
}
