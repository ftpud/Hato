CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON ai_conversations(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON ai_messages(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_acp_profiles_machine ON acp_profiles(machine_id);
