import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable, tap } from 'rxjs';

/** Adds an X-Response-Time header (ms) to every response produced by a Nest controller. */
@Injectable()
export class ResponseTimeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap(() => {
        if (!response.headersSent) {
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          response.setHeader('X-Response-Time', `${ms.toFixed(1)}ms`);
        }
      }),
    );
  }
}
