import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let technicalMessage = exception?.message || 'Unknown error';

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
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      }
      
      // If technical logic failed but didn't have DTO validations, 
      // the base message falls back gracefully
      if (!Array.isArray((exceptionResponse as any)?.message)) {
           technicalMessage = exception.message || message;
      }
    }

    // Return exact signature requested
    response.status(status).json({
      technicalMessage,
      message,
      status,
      state: "error"
    });
  }
}
