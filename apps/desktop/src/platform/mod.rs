//! Everything that differs between macOS and Windows. Both sides offer the same functions.

use serde::Serialize;

/// Contract §2 `permissions()`: each is "granted" | "denied" | "ask" | "unsupported".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Permissions {
    pub screen: &'static str,
    pub mic: &'static str,
    pub speech: &'static str,
    pub notifications: &'static str,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;
