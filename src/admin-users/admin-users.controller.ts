import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { AdminUsersService } from './admin-users.service';
import { DisableUserDto } from './dto/admin-users.dto';

/**
 * Global-Admin person-level user administration. Distinct from the
 * tenant-level suspension endpoints — this is the tool for disabling
 * a single person regardless of their org affiliation.
 *
 * GLOBAL_ADMIN only. Works across every role (TA, WM, CLIENT,
 * FINANCIER, other GA). A disabled user cannot sign in.
 */
@ApiTags('Global Admin — Users')
@ApiBearerAuth()
@Roles('GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Post(':userId/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Disable an individual user's account. Blocks their next sign-in with USER_INACTIVE. GLOBAL_ADMIN only. Works across every role — TA/WM/CLIENT/FINANCIER/GA. Reversible via POST /admin/users/:id/enable. Refuses with CANNOT_DISABLE_SELF if the caller targets their own account.",
  })
  @ApiParam({ name: 'userId' })
  disableUser(
    @CurrentUser('id') callerId: string,
    @Param('userId') userId: string,
    @Body() dto: DisableUserDto,
  ) {
    return this.service.disableUser(callerId, userId, dto);
  }

  @Post(':userId/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Re-enable a disabled user. Idempotent. Note: this only affects User.status — if the user's tenant is SUSPENDED, they still cannot sign in until the tenant is reactivated.",
  })
  @ApiParam({ name: 'userId' })
  enableUser(
    @CurrentUser('id') callerId: string,
    @Param('userId') userId: string,
  ) {
    return this.service.enableUser(callerId, userId);
  }
}
