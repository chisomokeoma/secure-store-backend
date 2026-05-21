/**
 * Privileged roles that get an unrestricted (tenant-wide) view from
 * non-/me endpoints. Anyone else (i.e. CLIENT-only) gets auto-scoped to
 * their own data via the returned id.
 */
export const PRIVILEGED_ROLES = [
  'TENANT_ADMIN',
  'GLOBAL_ADMIN',
  'WAREHOUSE_MANAGER',
];

/**
 * Effective roles for the request:
 *   - if the caller sent X-Active-Role AND they actually have that role
 *     in their JWT, the request is down-scoped to that single role
 *     (no elevation — invalid hints are silently ignored)
 *   - otherwise their JWT roles stand
 */
export function effectiveRoles(
  actualRoles: string[] | undefined,
  activeRole?: string,
): string[] {
  if (!actualRoles) return [];
  if (activeRole && actualRoles.includes(activeRole)) return [activeRole];
  return actualRoles;
}

/**
 * Returns the client id to filter by, OR `undefined` for unrestricted view.
 *   - admin/manager (effective) → undefined
 *   - client-only (effective)   → the caller's own user id
 */
export function forClientScope(
  roles: string[] | undefined,
  userId: string,
  activeRole?: string,
): string | undefined {
  const eff = effectiveRoles(roles, activeRole);
  return eff.some((r) => PRIVILEGED_ROLES.includes(r)) ? undefined : userId;
}
