import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminClientService } from '../services/admin-client.service';
import { JwtAuthGuard } from '../../auth/jwt.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../common/decorators/user.decorator';

@ApiTags('Admin Clients')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/clients')
export class AdminClientController {
  constructor(private readonly adminClientService: AdminClientService) {}

  @Get()
  @ApiOperation({ summary: 'List all clients for the tenant' })
  getClients(@CurrentUser('tenantId') tenantId: string) {
    return this.adminClientService.getClients(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Onboard a new client' })
  createClient(
    @CurrentUser('tenantId') tenantId: string,
    @Body() body: any,
  ) {
    return this.adminClientService.createClient(tenantId, body);
  }
}
