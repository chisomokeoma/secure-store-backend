export class NotificationDto {
  id!: string;
  title!: string;
  message!: string;
  isRead!: boolean;
  createdAt!: Date;
}

export class NotificationResponseDto {
  success!: boolean;
  message!: string;
}
