import {
  Controller,
  Post,
  Body,
  Get,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';

import {
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  AuthResponseDto,
  BaseResponseDto,
  UserProfileDto,
  WarehouseLoginDto,
  WarehouseChangePasswordDto,
  WarehouseSelectManagerDto,
} from './dto/auth.dto';
import { AuthService } from './auth.service';
import { WarehouseAuthService } from './warehouse-auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly warehouseAuth: WarehouseAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  @ApiOperation({ summary: 'Log in to the system' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  login(@Body() body: LoginDto): Promise<AuthResponseDto> | any {
    return this.authService.login(body.email, body.password);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  refresh(): AuthResponseDto {
    return {
      success: true,
      message: 'Refresh endpoint stub',
      accessToken: 'new-token-here',
    };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Log out of the system' })
  @ApiResponse({ status: 200, type: BaseResponseDto })
  logout(): BaseResponseDto {
    return { success: true, message: 'Logout endpoint stub' };
  }

  @Post('forgot-password')
  @ApiOperation({
    summary:
      "Send a password-reset email. Always returns 200 with a generic message — we never confirm or deny whether an account exists for the given address, to prevent account enumeration. The email contains a one-time link valid for 30 minutes.",
  })
  @ApiResponse({ status: 200, type: BaseResponseDto })
  forgotPassword(@Body() body: ForgotPasswordDto): Promise<BaseResponseDto> {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @ApiOperation({
    summary:
      "Consume a reset token from the email link. On success the user's password is updated, the token is marked used, all other outstanding reset tokens are invalidated, and every active refresh token for the user is revoked (forces a re-login on other devices).",
  })
  @ApiResponse({ status: 200, type: BaseResponseDto })
  resetPassword(@Body() body: ResetPasswordDto): Promise<BaseResponseDto> {
    return this.authService.resetPassword(body.token, body.newPassword);
  }

  // ── Warehouse shared-credential login ───────────────────────────────────

  @Post('warehouse-login')
  @ApiOperation({
    summary:
      "Step 1 of the warehouse shared-credential flow. Verifies the warehouse email + password. If mustChangePassword=true (just-assigned, or initial setup): returns { mustChangePassword: true, changeToken } — call /warehouse-login/change-password next. Otherwise: returns { managers, selectToken } — show the 'Who are you?' picker and call /warehouse-login/select-manager next.",
  })
  warehouseLogin(@Body() body: WarehouseLoginDto) {
    return this.warehouseAuth.warehouseLogin(body.email, body.password);
  }

  @Post('warehouse-login/change-password')
  @ApiOperation({
    summary:
      "Step 1b: consume a `changeToken` from /warehouse-login, set a new warehouse password (min 8 chars, mixed case + digit), and progress to the select step. Returns { managers, selectToken } on success.",
  })
  warehouseChangePassword(@Body() body: WarehouseChangePasswordDto) {
    return this.warehouseAuth.changeWarehousePassword(
      body.changeToken,
      body.newPassword,
    );
  }

  @Post('warehouse-login/select-manager')
  @ApiOperation({
    summary:
      "Step 2: consume a `selectToken` + the chosen manager's id. The chosen manager must be currently assigned to the warehouse. Returns a full session JWT with sub=managerUserId — every CurrentUser('id') downstream resolves to the specific human, preserving the audit chain.",
  })
  warehouseSelectManager(@Body() body: WarehouseSelectManagerDto) {
    return this.warehouseAuth.selectManager(body.selectToken, body.managerId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Get the current JWT bearer's user profile. Re-reads from the DB on every call so role / status changes are picked up without forcing a re-login.",
  })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async getMe(@CurrentUser('id') userId: string): Promise<UserProfileDto | any> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) {
      // JWT references a deleted user — force a re-login.
      throw new UnauthorizedException('User no longer exists');
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tenantId: user.tenantId,
      status: user.status,
      roles: user.roles.map((ur) => ur.role.name),
    };
  }
}
