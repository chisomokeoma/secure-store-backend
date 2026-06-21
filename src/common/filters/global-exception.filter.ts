import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let technicalMessage = exception?.message || 'Unknown error';
    // Any extra structured fields the throwing code supplied on the response
    // object — `code`, `attemptsRemaining`, etc. Forwarded as top-level keys
    // so the FE can branch on them without parsing the message text.
    let extras: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resObj = exceptionResponse as any;

        // Handle class-validator generic errors seamlessly
        if (Array.isArray(resObj.message)) {
          message = `Validation failed: ${resObj.message.join('. ')}`;
          technicalMessage = message; // Matches the example given by the user
        } else {
          message = resObj.message || message;
        }

        // Pass through everything except the keys Nest / this filter own.
        // This lets a service throw new BadRequestException({
        //   code: 'OTP_INVALID', attemptsRemaining: 3, message: '...' })
        // and have `code` + `attemptsRemaining` reach the client verbatim.
        const reserved = new Set([
          'message',
          'statusCode',
          'error',
          'status',
          'state',
          'technicalMessage',
        ]);
        for (const k of Object.keys(resObj)) {
          if (!reserved.has(k)) extras[k] = resObj[k];
        }
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      }

      // If technical logic failed but didn't have DTO validations,
      // the base message falls back gracefully
      if (!Array.isArray((exceptionResponse as any)?.message)) {
        technicalMessage = exception.message || message;
      }
    }

    // Return exact signature requested, with any structured extras the
    // throwing code attached. `state: 'error'` and `status` always last so
    // they can't be clobbered by extras.
    response.status(status).json({
      technicalMessage,
      message,
      ...extras,
      status,
      state: 'error',
    });
  }
}
