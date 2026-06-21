import {
  Controller,
  Get,
  Post,
  Patch,
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
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { TransactionOtpPurpose } from '@prisma/client';
import { WarehouseManagerService } from './warehouse-manager.service';
import {
  CreateClientDto,
  UpdateClientDto,
  CreateDepositDto,
  EditDepositDto,
  PreviewGradingDto,
  GetMovementDto,
} from './dto/wm.dto';
import { CreateWithdrawalDto } from '../withdrawals/dto/withdrawals.dto';
import { CreateLoanDto } from '../loans/dto/loans.dto';
import { CreateTradeDto } from '../trades/dto/trades.dto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Warehouse Manager')
@ApiBearerAuth()
@Roles('WAREHOUSE_MANAGER', 'TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('manager')
export class WarehouseManagerController {
  constructor(private readonly service: WarehouseManagerService) {}

  @Get('warehouses')
  @ApiOperation({ summary: "Warehouses assigned to the current manager (+ accepted commodities)" })
  getMyWarehouses(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.getMyWarehouses(tenantId, userId);
  }

  @Get('dashboard')
  @ApiOperation({
    summary:
      'Dashboard summary (warehouse-scoped, live): cards + status overview + distribution + capacity + recent activity + movement',
  })
  getDashboard(@CurrentUser('tenantId') tenantId: string) {
    return this.service.getDashboard(tenantId);
  }

  @Get('dashboard/movement')
  @ApiOperation({
    summary:
      "Filtered commodity-movement chart data. Three filter axes: ?period (preset window: 7d|30d|90d|6m|1y|ytd|all|custom), ?granularity (bucket size: day|week|month|quarter|year), and ?commodityIds (csv or repeated). When period=custom, pass ?from=YYYY-MM-DD&to=YYYY-MM-DD. Defaults: period=6m, granularity=month, all commodities — same numbers as the main dashboard's `commodityMovement`.",
  })
  @ApiQuery({ name: 'period', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'granularity', required: false })
  @ApiQuery({
    name: 'commodityIds',
    required: false,
    description: 'comma-separated list of commodity ids',
  })
  getCommodityMovement(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: GetMovementDto,
  ) {
    return this.service.getCommodityMovement(tenantId, query);
  }

  @Get('clients')
  @ApiOperation({ summary: 'List clients' })
  listClients(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listClients(tenantId, userId, {
      search,
      type,
      page,
      limit,
    });
  }

  @Get('clients/stats')
  @ApiOperation({ summary: 'Client stat cards: total / active / inactive' })
  getClientStats(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.getClientStats(tenantId, userId);
  }

  @Get('clients/:id')
  @ApiOperation({ summary: 'Client detail + receipt stats' })
  getClient(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getClient(tenantId, id);
  }

  @Get('clients/:id/receipts')
  @ApiOperation({
    summary:
      "List a client's receipts (tree-backed; ?group=ACTIVE|LIENED|CANCELLED, ?search, ?page, ?limit)",
  })
  getClientReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('group') group?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getClientReceipts(tenantId, id, {
      group,
      search,
      page,
      limit,
    });
  }

  @Get('clients/:id/transactions')
  @ApiOperation({
    summary:
      "A client's unified transaction history (?type=DEPOSIT|WITHDRAWAL|LOAN|TRADE, ?page, ?limit)",
  })
  getClientTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getClientTransactions(tenantId, id, {
      type,
      page,
      limit,
    });
  }

  @Post('clients')
  @ApiOperation({ summary: 'Register a new client (returns login credentials ONCE)' })
  createClient(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateClientDto,
  ) {
    return this.service.createClient(tenantId, userId, dto);
  }

  @Patch('clients/:id')
  @ApiOperation({ summary: 'Update a client profile' })
  updateClient(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.service.updateClient(tenantId, id, dto);
  }

  @Get('commodities/:id/grading-parameters')
  @ApiOperation({
    summary:
      "Grading parameters for a commodity — drives the deposit form's dynamic inputs (one per parameter id)",
  })
  getCommodityGradingParameters(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getCommodityGradingParameters(tenantId, id);
  }

  @Get('receipts/:id')
  @ApiOperation({
    summary:
      'Explicit receipt detail: node + provenance (path-to-root) + descendants + ledger timeline',
  })
  getReceiptDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getReceiptDetail(tenantId, id);
  }

  @Post('withdrawals/:id/dispatch')
  @ApiOperation({
    summary:
      'Dispatch (complete) an admin-approved withdrawal — fires CONSUMED on the ledger and recomputes fees at dispatch time. Alias for /withdrawals/:id/complete with WM scope assertion.',
  })
  dispatchWithdrawal(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') managerUserId: string,
    @Param('id') id: string,
  ) {
    return this.service.dispatchWithdrawal(tenantId, managerUserId, id);
  }

  @Get('withdrawals')
  @ApiOperation({
    summary:
      'Withdrawal requests list (?tab=all|pending|completed, ?status, ?search, ?page, ?limit)',
  })
  listWithdrawals(
    @CurrentUser('tenantId') tenantId: string,
    @Query('tab') tab?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listWithdrawals(tenantId, {
      tab,
      status,
      search,
      page,
      limit,
    });
  }

  @Get('withdrawals/stats')
  @ApiOperation({
    summary: 'Withdrawal cards: all / pending / approved / completed / rejected',
  })
  getWithdrawalStats(@CurrentUser('tenantId') tenantId: string) {
    return this.service.getWithdrawalStats(tenantId);
  }

  @Get('withdrawals/:id')
  @ApiOperation({
    summary:
      'Explicit withdrawal detail: request + receipt lineage + ledger trail',
  })
  getWithdrawalDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getWithdrawalDetail(tenantId, id);
  }

  @Get('transactions')
  @ApiOperation({
    summary:
      'Transaction report list (?type=DEPOSIT|WITHDRAWAL|LOAN|PLEDGE|TRADE, ?search, ?page, ?limit)',
  })
  listTransactions(
    @CurrentUser('tenantId') tenantId: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listTransactions(tenantId, {
      type,
      search,
      page,
      limit,
    });
  }

  @Get('transactions/stats')
  @ApiOperation({
    summary: 'Transaction cards: total / deposit / pledges / dispatches',
  })
  getTransactionStats(@CurrentUser('tenantId') tenantId: string) {
    return this.service.getTransactionStats(tenantId);
  }

  @Get('transactions/:type/:id')
  @ApiOperation({
    summary:
      'Explicit transaction detail (record + receipt lineage + ledger trail)',
  })
  getTransactionDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('type') type: string,
    @Param('id') id: string,
  ) {
    return this.service.getTransactionDetail(tenantId, type, id);
  }

  @Get('commodity-stats')
  @ApiOperation({
    summary: 'Commodity Management cards: total volume / deposits / withdrawals',
  })
  getCommodityStats(@CurrentUser('tenantId') tenantId: string) {
    return this.service.getCommodityStats(tenantId);
  }

  @Get('commodity-receipts')
  @ApiOperation({
    summary:
      'Registered receipts (?status=ACTIVE|CANCELLED|PLEDGE, ?commodityId, ?search, ?page, ?limit)',
  })
  listCommodityReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Query('status') status?: string,
    @Query('commodityId') commodityId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listCommodityReceipts(tenantId, {
      status,
      commodityId,
      search,
      page,
      limit,
    });
  }

  @Get('commodities')
  @ApiOperation({ summary: 'Commodities (+ active volume) — filter dropdown / overview' })
  listCommodities(@CurrentUser('tenantId') tenantId: string) {
    return this.service.listCommodities(tenantId);
  }

  @Get('commodities/:id')
  @ApiOperation({
    summary: 'Commodity detail + summary (total / withdrawn / loaned / traded)',
  })
  getCommodityDetail(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getCommodityDetail(tenantId, id);
  }

  // ── on-behalf transactions (manager acting for a client) ─────────────────

  @Get('financiers')
  @ApiOperation({ summary: 'List financiers available for loans' })
  listFinanciers(@CurrentUser('tenantId') tenantId: string) {
    return this.service.listFinanciers(tenantId);
  }

  @Get('clients/:id/eligible-receipts')
  @ApiOperation({
    summary: "Client's receipts eligible for a withdrawal (ACTIVE+APPROVED leaves in your warehouses)",
  })
  getClientEligibleReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.service.getClientEligibleReceipts(tenantId, id);
  }

  @Get('clients/:id/pledgeable-receipts')
  @ApiOperation({
    summary: "Client's receipts pledgeable for a loan (?commodity= optional filter)",
  })
  getClientPledgeableReceipts(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('commodity') commodity?: string,
  ) {
    return this.service.getClientPledgeableReceipts(tenantId, id, commodity);
  }

  @Post('clients/:id/transactions/request-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Request a 2FA OTP for an on-behalf transaction. OTP is delivered to the CLIENT (not the WM) — the WM asks the client to read it back so they can submit it with the create-on-behalf request. Always returns success (doesn't reveal whether the client has 2FA on).",
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['purpose'],
      properties: {
        purpose: {
          type: 'string',
          enum: ['WITHDRAWAL', 'LOAN', 'TRADE'],
        },
      },
    },
  })
  requestClientTransactionOtp(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') managerUserId: string,
    @Param('id') clientUserId: string,
    @Body('purpose') purpose: TransactionOtpPurpose,
  ) {
    return this.service.requestClientTransactionOtp(
      tenantId,
      managerUserId,
      clientUserId,
      purpose,
    );
  }

  @Post('clients/:id/withdrawals')
  @ApiOperation({ summary: 'Create a withdrawal request on a client’s behalf' })
  createWithdrawalOnBehalf(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') managerUserId: string,
    @Param('id') id: string,
    @Body() dto: CreateWithdrawalDto,
  ) {
    return this.service.createWithdrawalOnBehalf(
      tenantId,
      id,
      managerUserId,
      dto,
    );
  }

  @Post('clients/:id/loans')
  @ApiOperation({ summary: 'Create a loan application on a client’s behalf (pledges the receipt)' })
  createLoanOnBehalf(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') managerUserId: string,
    @Param('id') id: string,
    @Body() dto: CreateLoanDto,
  ) {
    return this.service.createLoanOnBehalf(tenantId, id, managerUserId, dto);
  }

  @Post('clients/:id/trades')
  @ApiOperation({ summary: 'Push a client’s receipt to the exchange (trade) on their behalf' })
  createTradeOnBehalf(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') managerUserId: string,
    @Param('id') id: string,
    @Body() dto: CreateTradeDto,
  ) {
    return this.service.createTradeOnBehalf(tenantId, id, managerUserId, dto);
  }

  @Post('deposits/preview-grading')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Stateless preview of the computed grade for a set of measurements — call this on the deposit review screen so the WM (and client) see the grade BEFORE submit. Uses the same scoring as `POST /manager/deposits`, so preview/submit can't disagree.",
  })
  previewGrading(
    @CurrentUser('tenantId') tenantId: string,
    @Body() dto: PreviewGradingDto,
  ) {
    return this.service.previewGrading(tenantId, dto);
  }

  @Post('deposits')
  @ApiOperation({
    summary:
      'Create a graded deposit for a client (scoped to the manager’s warehouse + accepted commodity). Result is PENDING_APPROVAL.',
  })
  createDeposit(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('roles') roles: string[],
    @Body() dto: CreateDepositDto,
  ) {
    return this.service.createDeposit(tenantId, userId, roles ?? [], dto);
  }

  @Patch('deposits/:receiptId')
  @ApiOperation({
    summary:
      "Edit a deposit the WM filed. Permitted ONLY while the receipt is PENDING_APPROVAL — once a tenant admin has approved it, further corrections are the TA's responsibility via PATCH /admin/receipts/:id/deposit-edit. All deposit fields are editable in this state: quantity, commodityId, warehouseId, grade, dateOfDeposit, measurements. If measurements are supplied without an explicit grade, the deposit is re-scored and the new computed grade is stamped. Every edit writes an ActivityLog row with before/after of changed fields.",
  })
  editDeposit(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('roles') roles: string[],
    @Param('receiptId') receiptId: string,
    @Body() dto: EditDepositDto,
  ) {
    return this.service.editDeposit(
      tenantId,
      userId,
      roles ?? [],
      receiptId,
      dto,
    );
  }
}
