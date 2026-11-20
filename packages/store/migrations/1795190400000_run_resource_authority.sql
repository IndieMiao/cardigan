-- Controller-only signing identity shared by launch, MCP and subsequent restarts.
CREATE TABLE run_resource_authority (singleton INTEGER PRIMARY KEY CHECK (singleton=1), pem TEXT NOT NULL);
