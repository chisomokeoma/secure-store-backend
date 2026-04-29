import { Controller, Post, Body, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import {
    LoginDto,
    ForgotPasswordDto,
    ResetPasswordDto,
    AuthResponseDto,
    BaseResponseDto,
    UserProfileDto
} from './dto/auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

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
        return { success: true, message: 'Refresh endpoint stub', accessToken: 'new-token-here' };
    }

    @Post('logout')
    @ApiOperation({ summary: 'Log out of the system' })
    @ApiResponse({ status: 200, type: BaseResponseDto })
    logout(): BaseResponseDto {
        return { success: true, message: 'Logout endpoint stub' };
    }

    @Post('forgot-password')
    @ApiOperation({ summary: 'Request password reset email' })
    @ApiResponse({ status: 200, type: BaseResponseDto })
    forgotPassword(@Body() body: ForgotPasswordDto): BaseResponseDto {
        return { success: true, message: 'Forgot password endpoint stub' };
    }

    @Post('reset-password')
    @ApiOperation({ summary: 'Reset password using token' })
    @ApiResponse({ status: 200, type: BaseResponseDto })
    resetPassword(@Body() body: ResetPasswordDto): BaseResponseDto {
        return { success: true, message: 'Reset password endpoint stub' };
    }

    @Get('me')
    @ApiOperation({ summary: 'Get current logged-in user profile' })
    @ApiResponse({ status: 200, type: UserProfileDto })
    getMe(): UserProfileDto | any {
        return {
            id: '123',
            email: 'demo@securestore.com',
            firstName: 'John',
            lastName: 'Doe',
            roles: []
        };
    }
}