import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response } from 'express';

export interface StandardResponse<T> {
  responseData: T;
  statusCode: number;
  status: boolean;
  responseMessage: string;
  responseCode: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, StandardResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<StandardResponse<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();
    const method = request.method;
    
    // Provide a smart generic message based on the HTTP request method
    let defaultMessage = 'Request processed successfully';
    if (method === 'POST') defaultMessage = 'Resource created successfully';
    else if (method === 'DELETE') defaultMessage = 'Resource deleted successfully';
    else if (method === 'PATCH' || method === 'PUT') defaultMessage = 'Resource updated successfully';

    return next.handle().pipe(
      map(data => ({
        // We ensure data is passed appropriately
        responseData: data === undefined ? null : data,
        statusCode: response.statusCode || 200,
        status: true,
        // If a specific message was attached to response.locals, use it. Otherwise default.
        responseMessage: response.locals.message || defaultMessage,
        responseCode: "00" // the custom success code exactly as requested
      }))
    );
  }
}
