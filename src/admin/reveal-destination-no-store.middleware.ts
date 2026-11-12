import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Sets no-store headers early for the reveal-destination route so guard-level
 * 401/403 responses (which bypass controller @Header) still cannot be cached.
 * Scoped only to this path via AdminModule.configure.
 */
@Injectable()
export class RevealDestinationNoStoreMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  }
}
