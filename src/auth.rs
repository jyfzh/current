use md5::{Digest, Md5};
use worker::*;

/// Constant-time string equality to reduce timing side-channel leakage.
fn secure_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let max_len = a_bytes.len().max(b_bytes.len());
    let mut diff: u8 = (a_bytes.len() ^ b_bytes.len()) as u8;
    for i in 0..max_len {
        let av = a_bytes.get(i).copied().unwrap_or(0);
        let bv = b_bytes.get(i).copied().unwrap_or(0);
        diff |= av ^ bv;
    }
    diff == 0
}

/// Validates the given api_key per the Fever API authentication protocol.
/// The client sends api_key = md5("email:password").
pub fn is_authenticated(api_key: Option<&str>, env: &Env) -> bool {
    let password = match env.var("CURRENT_FEVER_PASSWORD") {
        Ok(key) => key.to_string(),
        Err(_) => {
            crate::log_error!("CURRENT_FEVER_PASSWORD not configured — denying all requests");
            return false;
        }
    };

    let email = env
        .var("CURRENT_FEVER_EMAIL")
        .map(|s| s.to_string())
        .unwrap_or_else(|_| {
            crate::log_warn!("CURRENT_FEVER_EMAIL not configured — defaulting to 'admin'");
            "admin".into()
        });

    if let Some(request_key) = api_key {
        // Compute md5("{email}:{password}") per Fever API spec
        let expected = format!("{}:{}", email, password);
        let hash = format!("{:x}", Md5::digest(expected.as_bytes()));
        let ok = secure_eq(request_key, &hash);
        return ok;
    }

    crate::log_warn!("auth: authentication failed — no api_key provided");
    false
}

#[cfg(test)]
mod tests {
    use super::secure_eq;

    #[test]
    fn test_secure_eq_matches() {
        assert!(secure_eq("secret", "secret"));
    }

    #[test]
    fn test_secure_eq_mismatch() {
        assert!(!secure_eq("secret", "secreT"));
    }

    #[test]
    fn test_secure_eq_length_mismatch() {
        assert!(!secure_eq("short", "longer"));
    }
}
