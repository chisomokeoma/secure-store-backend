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
import { ReleaseRequestsService } from './release-requests.service';
import { CreateReleaseRequestDto } from './dto/release-requests.dto';

/**
 * Client-side release-request surface under /me/*.
 * Contract: collateralRoutes in src/api/endpoints/collateral.ts (§2.6-2.8).
 */
@ApiTags('Me — Release Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/release-requests')
export class ReleaseRequestsMeController {
  constructor(private readonly service: ReleaseRequestsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Submit a release request. Multi-line: target one or more liens (all from the same financier) with per-line quantities. Marks the covered volume as `releasePending` in encumbrance. Errors: QUANTITY_EXCEEDS_LIEN, LIEN_NOT_ACTIVE, RELEASE_ALREADY_PENDING, LIEN_FINANCIER_MISMATCH.",
  })
  createReleaseRequest(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReleaseRequestDto,
  ) {
    return this.service.createReleaseRequest(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List the caller's release requests. Items embed lines + receipt summaries.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listMyReleaseRequests(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listMyReleaseRequests(userId, {
      status,
      page,
      limit,
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a release request. Only allowed while PENDING.',
  })
  @ApiParam({ name: 'id' })
  cancelReleaseRequest(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.cancelReleaseRequest(userId, id);
  }
}
