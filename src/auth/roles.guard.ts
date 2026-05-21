import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { effectiveRoles } from '../common/scope.util';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles) {
      return true;
    }
    const req = context.switchToHttp().getRequest();
    const user = req.user ?? {};
    // Honor X-Active-Role for down-scoping: if a user with multiple roles
    // explicitly acts as one, that's the role we check against the route's
    // required set. Invalid hints (role not in their JWT) are ignored.
    const activeRole = req.headers?.['x-active-role'];
    const effective = effectiveRoles(user.roles, activeRole);
    return requiredRoles.some((role) => effective.includes(role));
  }
}
