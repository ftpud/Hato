//! Architectural gate (M1): the Rust kernel must not contain project/task/Git/ACP/MCP domain logic
//! or application SQL. Comments are ignored; code and string literals are scanned.
use std::path::Path;

const FORBIDDEN: &[&str] = &[
    // domain types / managers
    "struct Project", "struct Task", "struct Workspace", "struct Conversation", "GitRepository", "McpTool", "McpServer",
    "ProjectManager", "GitManager", "ACPManager", "AcpManager", "ConversationManager", "createTask", "create_task", "startCodex", "start_codex",
    "create_project", "createProject", "save_conversation", "mcpModulesBuild",
    // application SQL / schema
    "CREATE TABLE", "ai_conversations", "ai_messages", "workspace_views", "acp_profiles",
    // git workflow / agent protocol / providers
    "worktree", "rev-parse", "check-ref-format", "session/new", "session/prompt", "request_permission", "tools/call", "tools/list",
    "\"initialize\"", "codex", "claude", "jsonrpc",
];

fn scan(dir: &Path, hits: &mut Vec<String>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            scan(&p, hits);
            continue;
        }
        if p.extension().and_then(|x| x.to_str()) != Some("rs") {
            continue;
        }
        let src = std::fs::read_to_string(&p).unwrap();
        for (i, line) in src.lines().enumerate() {
            let code = match line.find("//") {
                Some(pos) if !line[..pos].contains('"') => &line[..pos],
                _ => line,
            };
            for f in FORBIDDEN {
                if code.to_lowercase().contains(&f.to_lowercase()) {
                    hits.push(format!("{}:{}: '{f}' in: {}", p.display(), i + 1, line.trim()));
                }
            }
        }
    }
}

#[test]
fn kernel_has_no_application_domain_logic() {
    let mut hits = Vec::new();
    scan(&Path::new(env!("CARGO_MANIFEST_DIR")).join("kernel/src"), &mut hits);
    assert!(hits.is_empty(), "architecture violations:\n{}", hits.join("\n"));
}

#[test]
fn first_party_grants_are_well_formed() {
    let g = hato_kernel::grants::GrantRegistry::load(std::env::temp_dir().join("hato-gate-approved.json")).unwrap();
    for id in ["persistence", "workspace", "projects", "git-tasks", "files", "terminals", "acp", "ai-sessions", "internal-mcp", "module-dev",
               "workspace-layout", "projects-panel", "explorer", "viewer", "terminal-panel", "ai"] {
        assert!(g.install_grant(id).is_some(), "missing grant for {id}");
    }
    // UI modules hold no OS-level capabilities beyond the folder dialog.
    for id in ["workspace-layout", "explorer", "viewer", "terminal-panel", "ai"] {
        assert!(g.install_grant(id).unwrap().capabilities.is_empty(), "{id} should have no native capabilities");
    }
    assert!(!g.install_grant("projects-panel").unwrap().capabilities.iter().any(|c| c != "ui.dialog"));
}
