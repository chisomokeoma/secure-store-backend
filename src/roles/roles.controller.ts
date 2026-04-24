import { Controller, Post, Param, Body, UseGuards } from '@nestjs/common';
import { RolesService } from './roles.service';
import { AppRole } from './role.enum';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('roles')
export class RolesController {
    constructor(private readonly rolesService: RolesService) {}

    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard)
    @Post('assign/:userId')
    assignRole(
        @Param('userId') userId: string,
        @Body('role') role: AppRole,
    ) {
        return this.rolesService.assignRole(userId, role);
    }
}
