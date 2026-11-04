-- M2.2: project repository registration. The base clone and worktree layout
-- (§12.2) need to know where the project's local repository lives and which
-- branch a worktree starts from. Roles keep their JSON doc; the existing
-- (project_id, role_id, role_version) key already makes versions immutable.
ALTER TABLE projects ADD COLUMN repo_path TEXT;
ALTER TABLE projects ADD COLUMN base_branch TEXT;
