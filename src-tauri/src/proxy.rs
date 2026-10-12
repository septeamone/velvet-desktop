//! Локальный прокси: приложение просит видео и данные не напрямую, а через него.
//! Так сайты не могут отказать из-за правил браузера (CORS), а все куски HLS идут одним путём.
//! Слушает только 127.0.0.1 и требует секретный ключ, который известен лишь окну приложения.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::Serialize;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tower_http::cors::CorsLayer;
use url::{Host, Url};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_PLAYLIST: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    port: u16,
    token: Arc<str>,
}

pub async fn start() -> Result<ProxyInfo, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = format!("{:032x}", rand::random::<u128>());

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .dns_resolver(Arc::new(SafeResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if blocked(attempt.url()) {
                attempt.error("blocked redirect")
            } else if attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let state = AppState { client, port, token: Arc::from(token.as_str()) };
    let app = Router::new()
        .route("/{token}/{target}", get(handle))
        .layer(CorsLayer::permissive())
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(ProxyInfo { port, token })
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_loopback() || v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => {
            let seg = v.segments();
            v.is_loopback() || v.is_unspecified() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Имена сайтов, которые ведут на внутренние адреса (в том числе через подмену DNS), не разрешаем.
struct SafeResolver;

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| !private_ip(a.ip())).collect();
            if addrs.is_empty() {
                return Err("address is not allowed".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn blocked(u: &Url) -> bool {
    if !matches!(u.scheme(), "http" | "https") {
        return true;
    }
    match u.host() {
        Some(Host::Ipv4(ip)) => private_ip(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => private_ip(IpAddr::V6(ip)),
        Some(Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
        None => true,
    }
}

fn status(code: StatusCode, text: &str) -> Response {
    Response::builder().status(code).body(Body::from(text.to_string())).unwrap()
}

async fn handle(
    State(st): State<AppState>,
    Path((token, target)): Path<(String, String)>,
    req_headers: HeaderMap,
) -> Response {
    if token != *st.token {
        return status(StatusCode::NOT_FOUND, "not found");
    }
    let Some(url) = B64.decode(target.as_bytes()).ok().and_then(|b| String::from_utf8(b).ok()).and_then(|s| Url::parse(&s).ok()) else {
        return status(StatusCode::BAD_REQUEST, "bad target");
    };
    if blocked(&url) {
        return status(StatusCode::FORBIDDEN, "blocked");
    }

    let mut rq = st.client.get(url.clone());
    if let Some(r) = req_headers.get(header::RANGE) {
        rq = rq.header(header::RANGE, r);
    }
    // название песни прямо из потока (Icecast/ICY)
    if let Some(r) = req_headers.get("icy-metadata") {
        rq = rq.header("icy-metadata", r);
    }
    let resp = match rq.send().await {
        Ok(r) => r,
        Err(e) => return status(StatusCode::BAD_GATEWAY, &format!("upstream: {e}")),
    };

    let code = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let ctype = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let is_playlist = url.path().ends_with(".m3u8") || ctype.contains("mpegurl");

    if is_playlist && code.is_success() {
        let mut resp = resp;
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_PLAYLIST => bytes.extend_from_slice(&chunk),
                Ok(None) => break,
                _ => return status(StatusCode::BAD_GATEWAY, "playlist"),
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let body = rewrite(&text, &url, st.port, &st.token);
        return Response::builder()
            .status(code)
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(body))
            .unwrap();
    }

    let mut out = Response::builder().status(code);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CONTENT_LENGTH,
        HeaderName::from_static("cache-control"),
        HeaderName::from_static("icy-metaint"),
        HeaderName::from_static("icy-name"),
        HeaderName::from_static("icy-br"),
    ] {
        if let Some(v) = resp.headers().get(&name) {
            if let Ok(v) = HeaderValue::from_bytes(v.as_bytes()) {
                out = out.header(name, v);
            }
        }
    }
    out.body(Body::from_stream(resp.bytes_stream())).unwrap()
}

fn prox(base: &Url, reference: &str, port: u16, token: &str) -> String {
    match base.join(reference) {
        Ok(abs) => format!("http://127.0.0.1:{port}/{token}/{}", B64.encode(abs.as_str())),
        Err(_) => reference.to_string(),
    }
}

/// Переписываем адреса внутри плейлиста так, чтобы они вели обратно на прокси.
fn rewrite(body: &str, base: &Url, port: u16, token: &str) -> String {
    let mut out = String::with_capacity(body.len() + 512);
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
        } else if t.starts_with('#') {
            match t.find("URI=\"") {
                Some(i) => {
                    let start = i + 5;
                    match t[start..].find('"') {
                        Some(len) => {
                            out.push_str(&t[..start]);
                            out.push_str(&prox(base, &t[start..start + len], port, token));
                            out.push_str(&t[start + len..]);
                        }
                        None => out.push_str(t),
                    }
                }
                None => out.push_str(t),
            }
            out.push('\n');
        } else {
            out.push_str(&prox(base, t, port, token));
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn blocks_internal_addresses() {
        for bad in ["http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.0.1/x", "http://169.254.1.1/x", "http://100.64.0.5/x", "http://[::1]/x", "http://[fd00::1]/x", "http://[fe80::1]/x", "http://localhost/x", "file:///etc/passwd", "ftp://example.com/x"] {
            assert!(blocked(&u(bad)), "{bad} должен быть заблокирован");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for ok in ["https://example.com/a.m3u8", "http://45.153.24.78/TNT/index.m3u8", "https://[2606:4700::1111]/x"] {
            assert!(!blocked(&u(ok)), "{ok} должен быть разрешён");
        }
    }

    #[test]
    fn rewrites_playlist_urls_through_proxy() {
        let base = u("http://example.com/live/index.m3u8");
        let out = rewrite("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nseg1.ts\n", &base, 1234, "tok");
        assert!(out.contains("http://127.0.0.1:1234/tok/"));
        assert!(!out.contains("seg1.ts\n"));
        assert!(out.lines().count() == 3);
    }
}
