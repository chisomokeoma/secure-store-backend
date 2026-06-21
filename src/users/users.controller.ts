import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  UpdateProfileDto,
  ChangePasswordDto,
  UserPreferencesDto,
} from './dto/users.dto';
import { UserProfileDto, BaseResponseDto } from '../auth/dto/auth.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('User Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  getMe(@CurrentUser('id') userId: string) {
    return this.usersService.getMe(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update user profile' })
  @ApiResponse({ status: 200, type: UserProfileDto })
  updateMe(@CurrentUser('id') userId: string, @Body() body: UpdateProfileDto) {
    return this.usersService.updateMe(body, userId);
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Change the current user's password. Requires the current password AND a 6-digit OTP delivered to the user's contactEmail (request one via POST /me/transactions/request-otp { purpose: 'CHANGE_PASSWORD' }). The OTP is required regardless of whether 2FA on transactions is enabled — it's a step-up gate that prevents a WM or session-thief from silently rotating someone else's password.",
  })
  @ApiResponse({ status: 200, type: BaseResponseDto })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() body: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(
      userId,
      body.currentPassword,
      body.newPassword,
      body.otp,
    );
  }

  @Get('me/preferences')
  @ApiOperation({ summary: 'Get user notifications preferences' })
  @ApiResponse({ status: 200, type: UserPreferencesDto })
  getPreferences(@CurrentUser('id') userId: string) {
    return this.usersService.getPreferences(userId);
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Update user preferences' })
  @ApiResponse({ status: 200, type: UserPreferencesDto })
  updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() body: Partial<UserPreferencesDto>,
  ) {
    return this.usersService.updatePreferences(userId, body);
  }
}
