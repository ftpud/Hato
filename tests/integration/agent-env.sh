# Source before running agent tests: drop API-key/nested-session variables inherited from the
# developer shell so adapters use the user's logged-in subscription (Claude Code / Codex login).
unset ANTHROPIC_API_KEY CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_EXECPATH CLAUDE_PID CLAUDE_CODE_SESSION_ATTENDED CLAUDE_EFFORT
