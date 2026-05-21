import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { forClientScope } from '../scope.util';

/**
 * Resolves the client id to filter the request by, accounting for the
 * `X-Active-Role` header (persona down-scoping):
 *   - admin/manager (effective) → `undefined` (unrestricted)
 *   - CLIENT (effective)        → the caller's own user id
 *
 * Down-scoping is honored only if the requested role is in the user's
 * actual JWT roles — no elevation is possible.
 */
export const ClientScopeId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user ?? {};
    const activeRole = req.headers?.['x-active-role'];
    return forClientScope(user.roles, user.id, activeRole);
  },
);
