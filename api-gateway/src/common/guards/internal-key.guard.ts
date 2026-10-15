import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Protects operational endpoints (e.g. GET /internal/routes).
 * Callers must send the INTERNAL_GATEWAY_SECRET in the x-internal-key header.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_GATEWAY_SECRET;
    if (!expected) throw new UnauthorizedException('Internal API is disabled');

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-key'];
    if (typeof provided !== 'string') throw new UnauthorizedException('Missing internal key');

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid internal key');
    }
    return true;
  }
}
