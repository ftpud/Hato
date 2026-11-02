//! Hato Rust microkernel: primitives and resource lifetimes only. No project/task/Git/ACP/MCP
//! semantics live here — those are hot-swappable TypeScript modules under `modules/`.
pub mod approvals;
pub mod artifacts;
pub mod audit;
pub mod bridge;
pub mod config;
pub mod grants;
pub mod handles;
pub mod headless;
pub mod host;
pub mod js;
pub mod kernel;
pub mod ops;
pub mod quoting;
pub mod router;
pub mod ui;
pub mod util;
