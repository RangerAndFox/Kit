/**
 * Permission scoping system for Kit
 * Determines what projects and data a user can access based on role
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { TeamRole } from '@/types/database';

export interface ScopeResult {
  projectIds: string[] | 'all';
}

/**
 * Get the scope of projects a user can access
 * Returns 'all' for founders, specific project IDs for others
 */
export async function scopeQuery(
  userId: string,
  workspaceId: string,
  role: TeamRole
): Promise<ScopeResult> {
  // Founders have access to all projects in the workspace
  if (role === 'founder') {
    return { projectIds: 'all' };
  }

  // Other roles get only their assigned projects
  const admin = createAdminClient();

  const { data: projectAccess, error } = await admin
.from('project_access')
    .select('project_id')
    .eq('team_member_id', userId)
    .eq('workspace_id', workspaceId);

  if (error) {
    console.error('Failed to fetch project access:', error);
    return { projectIds: [] };
  }

  const projectIds = projectAccess?.map((p: any) => p.project_id) || [];
  return { projectIds };
}

/**
 * Check if a user can access a specific project
 * Returns true if user has access, false otherwise
 */
export async function canAccessProject(
  userId: string,
  projectId: string,
  workspaceId: string
): Promise<boolean> {
  const admin = createAdminClient();

  // First, get the user's role
  const { data: teamMember, error: memberError } = await admin
.from('team_members')
    .select('role')
        .eq('auth_user_id', userId)
    .eq('workspace_id', workspaceId)
    .single();

  if (memberError || !teamMember) {
    return false;
  }

  // Founders can access all projects
  if (teamMember.role === 'founder') {
    return true;
  }

  // Check project_access table for other roles
  const { data: access, error: accessError } = await admin
.from('project_access')
    .select('id')
    .eq('team_member_id', userId)
    .eq('project_id', projectId)
    .eq('workspace_id', workspaceId)
    .single();

  return !accessError && !!access;
}

/**
 * Check if a role can view financial information
 * Only founders and producers can see budget/cost data
 */
export function canViewFinancials(role: TeamRole): boolean {
  return role === 'founder' || role === 'producer';
}

/**
 * Check if a role can edit project details
 * Only founders and producers can modify projects
 */
export function canEditProject(role: TeamRole): boolean {
  return role === 'founder' || role === 'producer';
}

/**
 * Check if a role can manage team members
 * Only founders can add/remove/manage team members
 */
export function canManageTeam(role: TeamRole): boolean {
  return role === 'founder';
}

/**
 * Enhanced permission check with multiple conditions
 * Useful for complex permission scenarios
 */
export async function checkPermission(
  userId: string,
  workspaceId: string,
  projectId: string | null,
  action: 'read' | 'write' | 'delete' | 'admin'
): Promise<boolean> {
  const admin = createAdminClient();

  // Get team member info
  const { data: teamMember, error: memberError } = await admin
.from('team_members')
    .select('role')
        .eq('auth_user_id', userId)
    .eq('workspace_id', workspaceId)
    .single();

  if (memberError || !teamMember) {
    return false;
  }

  const role = teamMember.role;

  // Admins can do everything
  if (role === 'founder') {
    return true;
  }

  // Producers can read and write (but not delete or admin)
  if (role === 'producer') {
    if (action === 'delete' || action === 'admin') {
      return false;
    }
    // For read/write, check project access if applicable
    if (projectId) {
      return await canAccessProject(userId, projectId, workspaceId);
    }
    return true;
  }

  // Artists and freelancers have limited permissions
  if (action === 'delete' || action === 'admin' || action === 'write') {
    return false; // Can only read
  }

  // For read, check project access
  if (projectId) {
    return await canAccessProject(userId, projectId, workspaceId);
  }

  return true;
}

/**
 * Get user's effective workspace role
 * Used for UI permission checks and authorization
 */
export async function getUserRole(
  userId: string,
  workspaceId: string
): Promise<TeamRole | null> {
  const admin = createAdminClient();

  const { data: teamMember, error } = await admin
.from('team_members')
    .select('role')
        .eq('auth_user_id', userId)
    .eq('workspace_id', workspaceId)
    .single();

  if (error || !teamMember) {
    return null;
  }

  return teamMember.role as TeamRole;
}

/**
 * Permission check utilities for UI rendering
 * Returns an object with boolean flags for common permission checks
 */
export async function getPermissionFlags(
  userId: string,
  workspaceId: string,
  projectId?: string
): Promise<{
  canEditProject: boolean;
  canViewFinancials: boolean;
  canManageTeam: boolean;
  canDeleteProject: boolean;
  canAccessProject: boolean;
}> {
  const role = await getUserRole(userId, workspaceId);

  if (!role) {
    return {
      canEditProject: false,
      canViewFinancials: false,
      canManageTeam: false,
      canDeleteProject: false,
      canAccessProject: false,
    };
  }

  const canAccess = projectId
    ? await canAccessProject(userId, projectId, workspaceId)
    : true;

  return {
    canEditProject: canEditProject(role) && canAccess,
    canViewFinancials: canViewFinancials(role),
    canManageTeam: canManageTeam(role),
    canDeleteProject: role === 'founder',
    canAccessProject: canAccess,
  };
}
