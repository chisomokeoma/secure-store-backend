import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AdminConfigService } from '../services/admin-config.service';
import { CreateGradingParameterDto } from '../dto/grading.dto';
import { CreateStorageFeePolicyDto } from '../dto/storage-fee.dto';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Config')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get('grading-parameters')
  @ApiOperation({ summary: 'Get grading parameters' })
  @ApiQuery({ name: 'commodityId', required: false })
  getGradingParameters(
    @CurrentUser('tenantId') tenantId: string,
    @Query('commodityId') commodityId?: string,
  ) {
    return this.adminConfigService.getGradingParameters(tenantId, commodityId);
  }

  @Post('grading-parameters')
  @ApiOperation({ summary: 'Create or update a grading parameter' })
  upsertGradingParameter(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: CreateGradingParameterDto,
  ) {
    return this.adminConfigService.upsertGradingParameter(tenantId, dto);
  }

  @Get('storage-fee-policies')
  @ApiOperation({ summary: 'Get storage fee policies' })
  getStorageFeePolicies(@CurrentUser('tenantId') tenantId: string) {
    return this.adminConfigService.getStorageFeePolicies(tenantId);
  }

  @Post('storage-fee-policies')
  @ApiOperation({ summary: 'Create a storage fee policy' })
  createStorageFeePolicy(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: CreateStorageFeePolicyDto,
  ) {
    return this.adminConfigService.createStorageFeePolicy(tenantId, dto);
  }
}
