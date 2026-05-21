import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary:
      "Paginated notifications for the current user. Response.meta.unreadCount drives the bell badge — read it on every poll. ?unreadOnly=true narrows the list (handy for the dropdown).",
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  getNotifications(
    @CurrentUser('id') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notificationsService.getNotifications(userId, {
      page,
      limit,
      unreadOnly,
    });
  }

  @Patch('mark-all-read')
  @ApiOperation({ summary: 'Mark all unread notifications as read' })
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllRead(userId);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a specific notification as read' })
  @ApiParam({ name: 'id' })
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notificationsService.markRead(userId, id);
  }
}
