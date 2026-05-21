import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { ReferenceService } from './reference.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@ApiTags('Reference Data')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reference')
export class ReferenceController {
  constructor(private readonly service: ReferenceService) {}

  @Get('countries')
  @ApiOperation({
    summary: 'ISO 3166-1 country list (name, alpha-2 code, dial code)',
  })
  getCountries() {
    return this.service.getCountries();
  }

  @Get('nigerian-states')
  @ApiOperation({
    summary: 'Nigeria — 36 states + FCT, with NIPOST code, region, capital',
  })
  getNigerianStates() {
    return this.service.getNigerianStates();
  }

  @Get('lgas')
  @ApiOperation({
    summary:
      'Local Government Areas for a Nigerian state (canonical: INEC). Returns 200 with empty data + provenance.note if the state is real but not yet hydrated.',
  })
  @ApiQuery({ name: 'state', required: true, example: 'Lagos' })
  getLgasByState(@Query('state') state: string) {
    return this.service.getLgasForState(state);
  }

  // Convenience path form for FE consumers that prefer it.
  @Get('lgas/:state')
  @ApiOperation({ summary: 'Same as ?state= but as a path parameter' })
  @ApiParam({ name: 'state', example: 'Lagos' })
  getLgasByStateParam(@Param('state') state: string) {
    return this.service.getLgasForState(state);
  }

  @Get('banks')
  @ApiOperation({
    summary:
      'Nigerian banks. Proxied from Paystack when PAYSTACK_SECRET_KEY is set (cached 24h server-side); otherwise a static fallback. `meta.source` tells you which.',
  })
  getBanks() {
    return this.service.getBanks();
  }
}
