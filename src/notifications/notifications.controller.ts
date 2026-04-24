import { Controller, Get, Patch, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationDto, NotificationResponseDto } from './dto/notifications.dto';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of notifications' })
  @ApiResponse({ status: 200, type: [NotificationDto] })
  getNotifications() {
    return this.notificationsService.getNotifications();
  }

  @Patch('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, type: NotificationResponseDto })
  markAllRead() {
    return { success: true, message: 'All notifications marked as read' };
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a specific notification as read' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: NotificationResponseDto })
  markRead(@Param('id') id: string) {
    return { success: true, message: 'Notification marked as read' };
  }
}
