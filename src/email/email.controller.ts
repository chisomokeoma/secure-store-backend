import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EmailService } from './email.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

/**
 * Email-pipeline smoke test. Admin-only because:
 *   (a) it touches the same SMTP credential prod will use, and
 *   (b) it sends a real outbound email, which counts against Gmail's
 *       daily quota and burns a real send each call.
 *
 * Recipient is configured at the env layer via `TEST_EMAIL_TO`. This is
 * deliberately not a body parameter — the endpoint is for "is the chain
 * healthy?" not "send arbitrary mail to arbitrary addresses." If you want
 * to retarget, change the env value and restart.
 */
@ApiTags('Admin · Email')
@ApiBearerAuth()
@Roles('TENANT_ADMIN', 'GLOBAL_ADMIN')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/email')
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Enqueue a test email to TEST_EMAIL_TO. Verifies the Redis → BullMQ → EmailProcessor → Nodemailer → Gmail chain end-to-end without triggering a real domain flow (password reset, OTP, etc.). Watch the server logs for the job lifecycle: enqueued → started → delivered.",
  })
  @ApiResponse({
    status: 200,
    description: 'Job enqueued; check the configured inbox and server logs.',
  })
  async sendTest() {
    const to = process.env.TEST_EMAIL_TO;
    if (!to) {
      throw new BadRequestException(
        'TEST_EMAIL_TO is not set in .env — add it and restart the server.',
      );
    }
    const { jobId } = await this.email.enqueueTest({ to });
    return {
      success: true,
      message: `Test email enqueued. If the pipeline is healthy, it should arrive at ${to} within a few seconds. Tail the server logs to see job ${jobId} progress through "started" → "delivered".`,
      jobId,
      to,
    };
  }
}
