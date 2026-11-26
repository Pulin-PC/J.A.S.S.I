//! Build settings.

use url::Url;

/// The web app this shell wraps. Change it at build time:
/// `JASSI_URL=http://localhost:3000 cargo run` (the address `npm start` prints).
const DEFAULT_URL: &str = "https://jassi.pulin-chaudhari.workers.dev";

pub fn jassi_url() -> Url {
    let raw = option_env!("JASSI_URL").map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_URL);
    Url::parse(raw).expect("JASSI_URL must be a full address, for example https://example.com")
}

/// Dev builds may talk to a server on localhost over plain HTTP. Release builds never do.
pub const DEV: bool = cfg!(debug_assertions);

pub const PLATFORM: &str = if cfg!(target_os = "macos") { "macos" } else { "windows" };

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
