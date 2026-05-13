import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { GradingService } from './grading.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Admin Grading (Settings)')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/grading')
export class GradingController {
  constructor(private readonly gradingService: GradingService) {}

  // ─── COMMODITIES ───────────────────────────────────────────────────────────

  @Get('commodities')
  @ApiOperation({ summary: 'List commodities with grading configuration' })
  getCommodities(@CurrentUser('tenantId') tenantId: string) {
    return this.gradingService.getCommodities(tenantId);
  }

  @Post('commodities')
  @ApiOperation({ summary: 'Create a commodity' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'unitOfMeasure'],
      properties: {
        name: { type: 'string', example: 'Maize' },
        code: { type: 'string', example: 'MAIZE-001' },
        unitOfMeasure: {
          type: 'string',
          enum: ['METRIC_TON', 'KILOGRAM', 'BAG', 'LITRE', 'UNIT', 'METER'],
        },
        gradingLogic: {
          type: 'string',
          enum: ['PERCENTAGE', 'SCORE', 'PASS_FAIL'],
        },
        numberOfGrades: { type: 'integer', example: 3 },
        standardBagWeightKg: { type: 'number', example: 50 },
        description: { type: 'string' },
      },
    },
  })
  createCommodity(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: any,
  ) {
    return this.gradingService.createCommodity(tenantId, body);
  }

  @Patch('commodities/:id')
  @ApiOperation({ summary: 'Update a commodity' })
  @ApiParam({ name: 'id' })
  updateCommodity(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.gradingService.updateCommodity(tenantId, id, body);
  }

  // ─── PARAMETERS ────────────────────────────────────────────────────────────

  @Get('commodities/:id/parameters')
  @ApiOperation({ summary: 'Get grading parameters for a commodity' })
  @ApiParam({ name: 'id' })
  getParameters(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.gradingService.getParameters(tenantId, id);
  }

  @Post('commodities/:id/parameters')
  @ApiOperation({ summary: 'Add a grading parameter to a commodity' })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'unit', 'isDefective', 'thresholds'],
      properties: {
        name: { type: 'string', example: 'Foreign Matter' },
        unit: { type: 'string', example: '%' },
        isDefective: { type: 'boolean' },
        thresholds: {
          type: 'object',
          example: { 'Grade 1': 0.5, 'Grade 2': 1.0, 'Grade 3': 1.5 },
        },
      },
    },
  })
  addParameter(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.gradingService.addParameter(tenantId, id, body);
  }

  @Patch('parameters/:id')
  @ApiOperation({ summary: 'Update a grading parameter' })
  @ApiParam({ name: 'id' })
  updateParameter(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.gradingService.updateParameter(tenantId, id, body);
  }

  @Delete('parameters/:id')
  @ApiOperation({ summary: 'Delete a grading parameter' })
  @ApiParam({ name: 'id' })
  deleteParameter(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.gradingService.deleteParameter(tenantId, id);
  }

  // ─── BULK APPLY & SCORER ───────────────────────────────────────────────────

  @Post('apply-to-warehouses')
  @ApiOperation({ summary: 'Bulk-link a commodity to warehouses' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['commodityId'],
      properties: {
        commodityId: { type: 'string' },
        warehouseIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Omit to apply to ALL warehouses',
        },
      },
    },
  })
  applyToWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @Body('commodityId') commodityId: string,
    @Body('warehouseIds') warehouseIds?: string[],
  ) {
    return this.gradingService.applyToWarehouses(
      tenantId,
      commodityId,
      warehouseIds,
    );
  }

  @Post('score')
  @ApiOperation({
    summary: 'Preview computed grade for a sample (no data saved)',
    description:
      'Runs the grading scorer algorithm and returns the computed grade.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['commodityId', 'measurements'],
      properties: {
        commodityId: { type: 'string' },
        measurements: {
          type: 'object',
          example: {
            'Foreign Matter': 0.3,
            Moisture: 12.5,
            'Broken Kernels': 1.5,
          },
        },
      },
    },
  })
  scorePreview(
    @CurrentUser('tenantId') tenantId: string,
    @Body('commodityId') commodityId: string,
    @Body('measurements') measurements: Record<string, number>,
  ) {
    return this.gradingService.scorePreview(
      tenantId,
      commodityId,
      measurements,
    );
  }
}
