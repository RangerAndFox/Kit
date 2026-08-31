-- Cover the composite workspace/project foreign key used to scope sessions.
create index managed_agent_sessions_workspace_project_idx
  on public.managed_agent_sessions (workspace_id, project_id)
  where project_id is not null;
