import { Controller, Get, Patch, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { MeService } from './me.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Me (User Settings)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.meService.getProfile(userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update current user profile fields' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        middleName: { type: 'string' },
        phoneNumber: { type: 'string' },
        contactEmail: { type: 'string' },
        profilePhotoUrl: { type: 'string' },
      },
    },
  })
  updateProfile(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.meService.updateProfile(userId, body);
  }

  @Post('change-password')
  @ApiOperation({ summary: 'User-initiated password change' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      properties: {
        currentPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
  })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.meService.changePassword(userId, currentPassword, newPassword);
  }

  @Patch('notification-prefs')
  @ApiOperation({ summary: 'Update notification preferences' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'boolean' },
        sms: { type: 'boolean' },
        inApp: { type: 'boolean' },
      },
    },
  })
  updateNotificationPrefs(
    @CurrentUser('id') userId: string,
    @Body() body: any,
  ) {
    return this.meService.updateNotificationPrefs(userId, body);
  }
}
