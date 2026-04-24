import { Controller, Get, Patch, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto, ChangePasswordDto, UserPreferencesDto } from './dto/users.dto';
import { UserProfileDto, BaseResponseDto } from '../auth/dto/auth.dto';

@ApiTags('User Settings')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  getMe() {
    return this.usersService.getMe();
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  updateMe(@Body() body: UpdateProfileDto) {
    return this.usersService.updateMe(body);
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, type: BaseResponseDto })
  changePassword(@Body() body: ChangePasswordDto) {
    return { success: true, message: 'Password changed successfully' };
  }

  @Get('me/preferences')
  @ApiOperation({ summary: 'Get user notifications preferences' })
  @ApiResponse({ status: 200, type: UserPreferencesDto })
  getPreferences() {
    return { emailNotifications: true, smsNotifications: false };
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Update user preferences' })
  @ApiResponse({ status: 200, type: UserPreferencesDto })
  updatePreferences(@Body() body: Partial<UserPreferencesDto>) {
    return { emailNotifications: true, smsNotifications: false };
  }
}