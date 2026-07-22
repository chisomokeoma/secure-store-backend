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
import { TransactionOtpPurpose } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { SecurityService } from '../security/security.service';
import { PledgesService } from './pledges.service';
import {
  AcceptPledgeDto,
  RejectPledgeDto,
  RequestFinancierOtpDto,
} from './dto/pledges.dto';

/**
 * Financier-side pledge inbox + 2FA-gated decisions on /financier/*.
 * All handlers scope implicitly to the caller's FinancierOrg.
 *
 * OTP request lives here too (POST /financier/otp/request) — the
 * FE calls it right before opening the accept/approve modal to
 * pre-fetch a code. Same infra as client OTPs; new purpose values
 * PLEDGE_ACCEPT / RELEASE_APPROVE keep them audit-distinct.
 */
@ApiTags('Financier — Pledges')
@ApiBearerAuth()
@Roles('FINANCIER')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financier')
export class PledgesFinancierController {
  constructor(
    private readonly service: PledgesService,
    private readonly security: SecurityService,
  ) {}

  @Get('pledges')
  @ApiOperation({
    summary:
      "Pledge inbox for this financier org. Defaults sort: PENDING first (by createdAt ASC — oldest at top so they don't age out), then everything else by createdAt DESC.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listPledges(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listFinancierPledges(userId, { status, page, limit });
  }

  @Get('pledges/:id')
  @ApiOperation({ summary: 'Pledge detail for the decision screen.' })
  @ApiParam({ name: 'id' })
  getPledgeDetail(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.getFinancierPledgeDetail(userId, id);
  }

  @Post('pledges/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Accept a pledge → atomically: pledge status ACCEPTED, Lien row created ACTIVE, receipt leaf HELD_PLEDGE_PENDING → HELD_LIEN. 2FA-gated (POST /financier/otp/request first).",
  })
  @ApiParam({ name: 'id' })
  acceptPledge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AcceptPledgeDto,
  ) {
    return this.service.acceptPledge(userId, id, dto);
  }

  @Post('pledges/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reject a pledge with a mandatory reason. Held volume returns to available.',
  })
  @ApiParam({ name: 'id' })
  rejectPledge(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: RejectPledgeDto,
  ) {
    return this.service.rejectPledge(userId, id, dto);
  }

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Request an OTP for a financier decision. Contexts: PLEDGE_ACCEPT, RELEASE_APPROVE. Delivered via email to the financier user's contactEmail. Returns { expiresIn } in seconds.",
  })
  async requestOtp(
    @CurrentUser('id') userId: string,
    @Body() dto: RequestFinancierOtpDto,
  ) {
    // Map the FE's `context` string to the DB enum. The two values match
    // one-for-one so no lookup table needed.
    const purpose = dto.context as TransactionOtpPurpose;
    // We don't strictly bind resourceId to the OTP — SecurityService's
    // OTP model tracks (user, purpose) tuples. resourceId is captured
    // in audit metadata via the ActivityLog fired downstream (Phase 6).
    await this.security.requestTransactionOtp({
      userId,
      purpose,
    });
    return { expiresIn: 300 };
  }
}
