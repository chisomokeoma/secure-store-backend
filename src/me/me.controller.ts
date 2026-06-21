import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { MeService } from './me.service';
import { SecurityService } from '../security/security.service';
import { UsersService } from '../users/users.service';
import { UpdateProfileDto } from '../users/dto/users.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TransactionOtpPurpose } from '@prisma/client';

@ApiTags('Me (User Settings)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(
    private readonly meService: MeService,
    private readonly security: SecurityService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.meService.getProfile(userId);
  }

  @Get('dashboard')
  @ApiOperation({
    summary:
      "Current user's dashboard summary (cards + per-unit/per-commodity totals + recent activity), scoped to their own data",
  })
  getDashboard(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getDashboard(tenantId, userId);
  }

  @Get('activity-trend')
  @ApiOperation({
    summary: "Time-series of the caller's activity (powers the 1Y/6M/3M/1M chart)",
  })
  @ApiQuery({
    name: 'range',
    required: false,
    enum: ['7d', '1m', '3m', '6m', '1y'],
  })
  getActivityTrend(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('range') range?: string,
  ) {
    const r = (range || '1y') as '7d' | '1m' | '3m' | '6m' | '1y';
    return this.meService.getActivityTrend(tenantId, userId, r);
  }

  @Get('transactions/stats')
  @ApiOperation({
    summary: "Stats for the caller's transaction report (totals + counts)",
  })
  getTransactionStats(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getTransactionStats(tenantId, userId);
  }

  @Get('transactions')
  @ApiOperation({
    summary:
      "Caller's unified transaction history (?type=DEPOSIT|WITHDRAWAL|LOAN|PLEDGE|TRADE, ?from, ?to, ?search, ?page, ?limit)",
  })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.meService.listTransactions(tenantId, userId, {
      type,
      from,
      to,
      search,
      page,
      limit,
    });
  }

  @Get('transactions/:type/:id')
  @ApiOperation({
    summary:
      "Caller's transaction detail (record + receipt lineage + ledger trail)",
  })
  @ApiParam({ name: 'type' })
  @ApiParam({ name: 'id' })
  getTransactionDetail(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    return this.meService.getTransactionDetail(tenantId, userId, type, id);
  }

  @Get('inventory/warehouses')
  @ApiOperation({
    summary:
      "Step 1 of the deposit/withdraw selection flow: warehouses where the caller has eligible inventory",
  })
  getInventoryWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.meService.getInventoryWarehouses(tenantId, userId);
  }

  @Get('inventory/warehouses/:warehouseId/commodities')
  @ApiOperation({
    summary:
      'Step 2: commodities (with eligible quantity/unit) the caller holds in the chosen warehouse',
  })
  @ApiParam({ name: 'warehouseId' })
  getInventoryCommodities(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.meService.getInventoryCommodities(
      tenantId,
      userId,
      warehouseId,
    );
  }

  @Patch()
  @ApiOperation({
    summary:
      "Update the current user's profile fields (firstName, lastName, middleName, phoneNumber, profilePhotoUrl). Delegates to UsersService.updateMe so this endpoint is a strict alias of PATCH /users/me — same DTO, same validation (profilePhotoUrl must be a URL we issued via POST /storage/upload), same ClientProfile mirror. contactEmail changes require a step-up flow that isn't wired here; route those through support for now.",
  })
  updateProfile(
    @CurrentUser('id') userId: string,
    @Body() body: UpdateProfileDto,
  ) {
    return this.users.updateMe(body, userId);
  }

  @Post('change-password')
  @ApiOperation({
    summary:
      "User-initiated password change. Requires currentPassword AND a 6-digit OTP delivered to the user's contactEmail. Request the OTP via POST /me/transactions/request-otp with { purpose: 'CHANGE_PASSWORD' }. The OTP is required even if 2FA on transactions is off — this is the step-up gate that prevents anyone with session access from silently rotating the password.",
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['currentPassword', 'newPassword', 'otp'],
      properties: {
        currentPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
        otp: { type: 'string', minLength: 6, maxLength: 6 },
      },
    },
  })
  changePassword(
    @CurrentUser('id') userId: string,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
    @Body('otp') otp: string,
  ) {
    return this.meService.changePassword(
      userId,
      currentPassword,
      newPassword,
      otp,
    );
  }

  // ── Transaction PIN ─────────────────────────────────────────────────────

  @Post('transaction-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Set a 4-digit transaction PIN for the first time. Requires the account password.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password', 'pin'],
      properties: {
        password: { type: 'string' },
        pin: { type: 'string', minLength: 4, maxLength: 4 },
      },
    },
  })
  setTransactionPin(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
    @Body('pin') pin: string,
  ) {
    return this.security.setTransactionPin({ userId, password, pin });
  }

  @Patch('transaction-pin')
  @ApiOperation({
    summary:
      'Change the transaction PIN. Requires the account password AND the current PIN.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password', 'currentPin', 'newPin'],
      properties: {
        password: { type: 'string' },
        currentPin: { type: 'string', minLength: 4, maxLength: 4 },
        newPin: { type: 'string', minLength: 4, maxLength: 4 },
      },
    },
  })
  changeTransactionPin(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
    @Body('currentPin') currentPin: string,
    @Body('newPin') newPin: string,
  ) {
    return this.security.changeTransactionPin({
      userId,
      password,
      currentPin,
      newPin,
    });
  }

  @Delete('transaction-pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Clear the transaction PIN. Blocked while 2FA is on (PIN is a precondition). Requires the account password.",
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password'],
      properties: { password: { type: 'string' } },
    },
  })
  clearTransactionPin(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
  ) {
    return this.security.clearTransactionPin({ userId, password });
  }

  // ── Two-Factor Authentication ───────────────────────────────────────────

  @Post('two-factor/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Enable 2FA. Requires a PIN to already be set and the current account password. Once on, every withdrawal/loan/trade will require both PIN and an OTP delivered to the registered email.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password'],
      properties: { password: { type: 'string' } },
    },
  })
  enableTwoFactor(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
  ) {
    return this.security.enableTwoFactor({ userId, password });
  }

  @Post('two-factor/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Disable 2FA. Requires the account password AND a fresh DISABLE_2FA OTP (request one first via POST /me/transactions/request-otp with purpose=DISABLE_2FA). The OTP gate prevents a stolen JWT from silently turning protection off.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['password', 'otp'],
      properties: {
        password: { type: 'string' },
        otp: { type: 'string', minLength: 6, maxLength: 6 },
      },
    },
  })
  disableTwoFactor(
    @CurrentUser('id') userId: string,
    @Body('password') password: string,
    @Body('otp') otp: string,
  ) {
    return this.security.disableTwoFactor({ userId, password, otp });
  }

  // ── Transaction OTP request (client-initiated) ──────────────────────────

  @Post('transactions/request-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Request an OTP for an upcoming 2FA-gated transaction. Purposes: WITHDRAWAL, LOAN, TRADE, DISABLE_2FA. Always returns success — does not reveal whether the user has 2FA enabled.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['purpose'],
      properties: {
        purpose: {
          type: 'string',
          enum: ['WITHDRAWAL', 'LOAN', 'TRADE', 'DISABLE_2FA'],
        },
      },
    },
  })
  requestTransactionOtp(
    @CurrentUser('id') userId: string,
    @Body('purpose') purpose: TransactionOtpPurpose,
  ) {
    return this.security.requestTransactionOtp({ userId, purpose });
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
