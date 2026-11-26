//! One small HTTP client, using the operating system's own TLS.

use std::sync::Arc;
use std::time::Duration;

pub fn agent(timeout_secs: u64) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(timeout_secs)).redirects(3);
    if let Ok(tls) = native_tls::TlsConnector::new() {
        builder = builder.tls_connector(Arc::new(tls));
    }
    builder.build()
}
