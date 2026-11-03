//! 对外请求统一从这里创建客户端。
//!
//! 问题：reqwest 的 rustls 默认用系统证书校验（rustls-platform-verifier）。在 Android 上这个
//! 校验器必须先经过 JNI 初始化，否则第一次 TLS 握手就会 panic。测速、更新检查、所在地区
//! 判断都会因此失败，表现为「两条线路测速失败」、进不去应用。
//!
//! 做法：Android 上改用内置的 Mozilla 根证书（webpki-roots），不再碰系统校验器；
//! 其他平台保持原来的系统证书，行为不变。

use std::sync::Arc;

/// 新建客户端的构建器。调用方继续设置超时、User-Agent 等。
pub fn client_builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "android")]
    {
        let config = bundled_roots_config().expect(
            "内置根证书的 TLS 配置应当总能创建（aws-lc-rs 和 webpki-roots 都是编译进来的）",
        );
        return reqwest::Client::builder().tls_backend_preconfigured(config);
    }
    #[cfg(not(target_os = "android"))]
    reqwest::Client::builder()
}

/// 只信任内置的公共根证书。只在 Android 上真正使用，其他平台保留给测试检查。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn bundled_roots_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_roots_config_builds_with_public_roots() {
        // 配置能创建，且内置的根证书不是空的；否则 Android 上所有 https 请求都会失败
        assert!(bundled_roots_config().is_ok());
        assert!(webpki_roots::TLS_SERVER_ROOTS.len() > 100);
    }

    #[test]
    fn client_builds_on_this_platform() {
        assert!(client_builder().build().is_ok());
    }
}
