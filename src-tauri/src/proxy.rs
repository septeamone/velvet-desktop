//! Локальный прокси: приложение просит видео и данные не напрямую, а через него.
//! Так сайты не могут отказать из-за правил браузера (CORS), а все куски HLS идут одним путём.
//! Слушает только 127.0.0.1 и требует секретный ключ, который известен лишь окну приложения.

use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde::Serialize;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_stream::{wrappers::UnboundedReceiverStream, Stream, StreamExt};
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

/// Общий безопасный клиент: свой DNS-фильтр (никаких внутренних адресов), проверка каждого перенаправления, без системного прокси.
pub fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .no_proxy()
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
        .tcp_keepalive(Duration::from_secs(15)) // мёртвое соединение замечаем сами, а не через минуты
        .build()
        .map_err(|e| e.to_string())
}

pub async fn start() -> Result<ProxyInfo, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = format!("{:032x}", rand::random::<u128>());

    let client = build_client()?;

    let state = AppState { client, port, token: Arc::from(token.as_str()) };
    let app = Router::new()
        .route("/{token}/{target}", get(handle))
        .route("/{token}/live/{target}", get(handle_live))
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
            o[0] == 0
                || v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_multicast()
                || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => {
            // адреса IPv4 внутри IPv6 (::ffff:127.0.0.1) проверяем как обычный IPv4
            if let Some(v4) = v.to_ipv4_mapped().or_else(|| v.to_ipv4()) {
                return private_ip(IpAddr::V4(v4));
            }
            let seg = v.segments();
            v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || (seg[0] == 0x64 && seg[1] == 0xff9b)
        }
    }
}

/// Имена сайтов, которые ведут на внутренние адреса (в том числе через подмену DNS), не разрешаем.
struct SafeResolver;

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let mut addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| !private_ip(a.ip())).collect();
            addrs.sort_by_key(|a| a.is_ipv6()); // IPv4 первым: у части провайдеров IPv6 «кривой» и подключение зависает
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

async fn handle(State(st): State<AppState>, Path((token, target)): Path<(String, String)>, req_headers: HeaderMap) -> Response {
    serve(st, token, target, req_headers, None).await
}

/// Прямой эфир (Icecast/Shoutcast): если станция оборвала соединение, прокси сам тихо переподключается.
async fn handle_live(
    State(st): State<AppState>,
    Path((token, target)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    req_headers: HeaderMap,
) -> Response {
    serve(st, token, target, req_headers, Some(prefill_from(&q))).await
}

/// «Range: bytes=0-» (так браузер всегда просит звук) — это запрос «с самого начала», а не перемотка.
fn from_start(v: &HeaderValue) -> bool {
    v.to_str().map(|s| s.trim() == "bytes=0-").unwrap_or(false)
}

/// Сколько секунд эфира копить перед стартом: приложение просит через ?p=…; по умолчанию 6, не больше 15.
fn prefill_from(q: &HashMap<String, String>) -> Duration {
    Duration::from_secs(q.get("p").and_then(|v| v.parse::<u64>().ok()).unwrap_or(6).min(15))
}

/// `live`: Some(запас) — прямой эфир станции (с переподключением), None — обычный запрос.
async fn serve(st: AppState, token: String, target: String, req_headers: HeaderMap, live: Option<Duration>) -> Response {
    let prefill = live.unwrap_or_default();
    let live = live.is_some();
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
    // браузер просит аудио с «Range: bytes=0-» — для живого эфира это просто «с начала»; станции в ответ всё равно шлют поток целиком
    if let Some(r) = req_headers.get(header::RANGE).filter(|r| !(live && from_start(r))) {
        rq = rq.header(header::RANGE, r);
    }
    // у GitHub в кеше может залежаться сжатая копия файла, а несжатая свежая: просим несжатую
    if url.host_str() == Some("raw.githubusercontent.com") {
        rq = rq.header(header::ACCEPT_ENCODING, "identity");
    }
    // название песни прямо из потока (Icecast/ICY)
    if let Some(r) = req_headers.get("icy-metadata") {
        rq = rq.header("icy-metadata", r);
    }
    if live {
        rq = rq.header(header::ACCEPT_ENCODING, "identity"); // у звука сжатия нет, а лишняя распаковка только задерживает
    }
    let sent = if live {
        match tokio::time::timeout(LIVE_OPEN_TIMEOUT, rq.send()).await {
            Ok(r) => r.map_err(|e| e.to_string()),
            Err(_) => Err("нет ответа 10 с".to_string()),
        }
    } else {
        rq.send().await.map_err(|e| e.to_string())
    };
    let resp = match sent {
        Ok(r) => r,
        Err(e) => {
            if live {
                crate::log::line(&format!("поток {}: не открылся ({e})", label(&url)));
            }
            return status(StatusCode::BAD_GATEWAY, &format!("upstream: {e}"));
        }
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

    // живой эфир без длины: перекачиваем сами, с переподключением при обрыве
    let open_ended = resp.headers().get(header::CONTENT_LENGTH).is_none();
    let chained = ctype.contains("ogg") || ctype.contains("opus"); // у цепочек Ogg после стыка другой заголовок
    let pump = live
        && code.is_success()
        && open_ended
        && !chained
        && req_headers.get(header::RANGE).is_none_or(from_start)
        && !req_headers.contains_key("icy-metadata");

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
        if let Some(Ok(v)) = resp.headers().get(&name).map(|v| HeaderValue::from_bytes(v.as_bytes())) {
            out = out.header(name, v);
        }
    }
    if pump {
        let (tx, rx) = live_channel();
        let client = st.client.clone();
        tauri::async_runtime::spawn(pump_live(client, url, resp, tx, LiveCfg { prefill, ..LiveCfg::default() }));
        return out.body(Body::from_stream(rx)).unwrap();
    }
    out.body(Body::from_stream(resp.bytes_stream())).unwrap()
}

const LIVE_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// Предел копилки запаса в байтах (на случай очень тяжёлого потока).
const HOLD_CAP: usize = 4 * 1024 * 1024;
/// Сколько эфира (в байтах) может ждать в очереди, пока плеер его не заберёт; больше — читать станцию притормаживаем.
const QUEUE_CAP: usize = 3 * 1024 * 1024;

/// Очередь между станцией и плеером. Браузер сам держит впереди лишь 2–3 секунды, поэтому настоящий запас лежит здесь:
/// станцию мы дочитываем всегда, а плеер забирает данные по мере надобности.
#[derive(Clone)]
struct LiveTx {
    tx: mpsc::UnboundedSender<Result<Bytes, std::io::Error>>,
    queued: Arc<AtomicUsize>,
}

impl LiveTx {
    fn send(&self, b: Bytes) -> bool {
        self.queued.fetch_add(b.len(), Ordering::Relaxed);
        self.tx.send(Ok(b)).is_ok()
    }
    fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
    fn full(&self) -> bool {
        self.queued.load(Ordering::Relaxed) > QUEUE_CAP
    }
}

fn live_channel() -> (LiveTx, impl Stream<Item = Result<Bytes, std::io::Error>>) {
    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, std::io::Error>>();
    let queued = Arc::new(AtomicUsize::new(0));
    let counted = queued.clone();
    let stream = UnboundedReceiverStream::new(rx).map(move |item| {
        if let Ok(b) = &item {
            counted.fetch_sub(b.len(), Ordering::Relaxed);
        }
        item
    });
    (LiveTx { tx, queued }, stream)
}

#[derive(Clone, Copy)]
struct LiveCfg {
    /// сколько ждём новых данных, прежде чем считать соединение мёртвым
    silence: Duration,
    /// сколько всего без данных, после чего сдаёмся (плеер сам подключится заново)
    give_up: Duration,
    /// сколько эфира копим в начале и отдаём плееру разом: это его запас на случай просадки сети
    prefill: Duration,
}

impl Default for LiveCfg {
    fn default() -> Self {
        Self { silence: Duration::from_secs(3), give_up: Duration::from_secs(25), prefill: Duration::from_secs(6) }
    }
}

fn label(u: &Url) -> String {
    u.host_str().unwrap_or("?").to_string()
}

/// Перекачивает эфир станции плееру. Если станция оборвала соединение, замолчала или закрыла поток —
/// открывает его заново и продолжает в том же канале, чтобы плеер ничего не заметил.
async fn pump_live(client: reqwest::Client, url: Url, first: reqwest::Response, tx: LiveTx, cfg: LiveCfg) {
    let who = label(&url);
    let mut resp = first;
    let mut last_data = tokio::time::Instant::now();
    let mut drops = 0u32;
    let mut holding = !cfg.prefill.is_zero(); // пока копим запас, плееру ничего не отдаём
    let mut hold: Vec<Bytes> = Vec::new();
    let mut held = 0usize;
    let mut hold_since: Option<tokio::time::Instant> = None;
    loop {
        let why = loop {
            while tx.full() {
                if tx.is_closed() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await; // плеер давно не забирает: станцию пока не читаем
            }
            match tokio::time::timeout(cfg.silence, resp.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    last_data = tokio::time::Instant::now();
                    if tx.is_closed() {
                        return; // плеер закрыл поток
                    }
                    if holding {
                        held += chunk.len();
                        hold.push(chunk);
                        let since = *hold_since.get_or_insert(last_data);
                        if since.elapsed() >= cfg.prefill || held >= HOLD_CAP {
                            holding = false;
                            crate::log::line(&format!("поток {who}: запас накоплен ({} КБ за {} мс), отдаю плееру", held / 1024, since.elapsed().as_millis()));
                            for c in hold.drain(..) {
                                if !tx.send(c) {
                                    return;
                                }
                            }
                        }
                    } else if !tx.send(chunk) {
                        return;
                    }
                }
                Ok(Ok(None)) => break "станция закрыла поток".to_string(),
                Ok(Err(e)) => break format!("обрыв: {e}"),
                Err(_) => break format!("тишина {} с", cfg.silence.as_secs()),
            }
        };
        drops += 1;
        crate::log::line(&format!("поток {who}: {why}, переподключаю (обрыв №{drops})"));
        let mut wait = Duration::from_millis(200);
        resp = loop {
            if last_data.elapsed() > cfg.give_up {
                crate::log::line(&format!("поток {who}: не вернулся за {} с, отпускаю плеер", cfg.give_up.as_secs()));
                return;
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(2));
            if tx.is_closed() {
                return;
            }
            match tokio::time::timeout(LIVE_OPEN_TIMEOUT.min(cfg.give_up), client.get(url.clone()).header(header::ACCEPT_ENCODING, "identity").send()).await {
                Ok(Ok(r)) if r.status().is_success() => {
                    crate::log::line(&format!("поток {who}: переподключён, тишина была {} мс", last_data.elapsed().as_millis()));
                    break r;
                }
                _ => continue,
            }
        };
    }
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
        for bad in ["http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.0.1/x", "http://169.254.1.1/x", "http://100.64.0.5/x", "http://[::1]/x", "http://[fd00::1]/x", "http://[fe80::1]/x", "http://[::ffff:127.0.0.1]/x", "http://[::ffff:10.0.0.1]/x", "http://[::127.0.0.1]/x", "http://[64:ff9b::7f00:1]/x", "http://0.0.0.0/x", "http://0.1.2.3/x", "http://224.0.0.1/x", "http://[ff02::1]/x", "http://localhost/x", "file:///etc/passwd", "ftp://example.com/x"] {
            assert!(blocked(&u(bad)), "{bad} должен быть заблокирован");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for ok in ["https://example.com/a.m3u8", "http://45.153.24.78/TNT/index.m3u8", "https://[2606:4700::1111]/x"] {
            assert!(!blocked(&u(ok)), "{ok} должен быть разрешён");
        }
    }

    /// Станция-пустышка: n-е соединение получает plan[n] и закрывается; когда план кончился, соединения не принимаются.
    async fn fake_station(plan: Vec<&'static [u8]>) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let count = std::sync::Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            for body in plan {
                let (mut sock, _) = listener.accept().await.unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n").await;
                let _ = sock.write_all(body).await;
                let _ = sock.shutdown().await;
            }
        });
        (port, count)
    }

    #[tokio::test]
    async fn live_stream_reconnects_after_drop_and_gives_up() {
        let (port, count) = fake_station(vec![b"AAAA", b"BBBB"]).await;
        let url = u(&format!("http://127.0.0.1:{port}/live"));
        let client = reqwest::Client::new();
        let first = client.get(url.clone()).send().await.unwrap();
        let (tx, rx) = live_channel();
        tokio::pin!(rx);
        let cfg = LiveCfg { silence: Duration::from_secs(1), give_up: Duration::from_millis(1500), prefill: Duration::ZERO };
        tokio::spawn(pump_live(client, url, first, tx, cfg));
        let mut got = Vec::new();
        while let Some(chunk) = rx.next().await {
            got.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(got, b"AAAABBBB", "после обрыва данные должны продолжиться в том же потоке");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2, "станцию открывали дважды");
        // поток закрылся сам, когда станция не вернулась (цикл выше закончился)
    }

    /// Настоящий прокси и настоящая станция (нужен интернет): cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_route_streams_real_station() {
        let info = start().await.unwrap();
        let target = B64.encode("http://ep128server.streamr.ru:8030/ep128");
        // как настоящий браузер: просит звук с «Range: bytes=0-»; запас (по умолчанию 6 с) должен сработать и для такого запроса
        let started = std::time::Instant::now();
        let mut resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{}/{}/live/{target}?p=3", info.port, info.token))
            .header("Range", "bytes=0-")
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success());
        assert!(resp.headers().get("content-length").is_none(), "эфир идёт без длины");
        let mut got = 0;
        while got < 64 * 1024 {
            got += resp.chunk().await.unwrap().expect("поток не должен заканчиваться").len();
        }
        assert!(started.elapsed() >= Duration::from_secs(3), "запас не накопился: прокси не включил режим эфира для запроса с Range");
        let wrong = reqwest::get(format!("http://127.0.0.1:{}/bad/live/{target}", info.port)).await.unwrap();
        assert_eq!(wrong.status(), 404, "без ключа прокси не отвечает");
    }

    /// Станция, которая отдаёт части с задержками: (пауза в мс перед частью, данные); потом держит соединение открытым.
    async fn slow_station(parts: Vec<(u64, &'static [u8])>) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n").await;
            for (pause, data) in parts {
                tokio::time::sleep(Duration::from_millis(pause)).await;
                let _ = sock.write_all(data).await;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        port
    }

    #[tokio::test]
    async fn live_stream_holds_prefill_then_sends_it_at_once() {
        let port = slow_station(vec![(0, b"AAAA"), (400, b"BBBB"), (400, b"CCCC"), (400, b"DDDD")]).await;
        let url = u(&format!("http://127.0.0.1:{port}/live"));
        let client = reqwest::Client::new();
        let first = client.get(url.clone()).send().await.unwrap();
        let (tx, rx) = live_channel();
        tokio::pin!(rx);
        let cfg = LiveCfg { silence: Duration::from_secs(2), give_up: Duration::from_secs(5), prefill: Duration::from_millis(1000) };
        let started = tokio::time::Instant::now();
        tokio::spawn(pump_live(client, url, first, tx, cfg));
        let first_chunk = rx.next().await.unwrap().unwrap();
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(900), "плеер получил данные слишком рано: {waited:?}");
        assert_eq!(&first_chunk[..], b"AAAA", "копилка отдаётся с самого начала");
        let second = tokio::time::timeout(Duration::from_millis(100), rx.next()).await.expect("накопленное идёт сразу пачкой").unwrap().unwrap();
        assert_eq!(&second[..], b"BBBB");
    }

    /// Запас в прокси прячет просадку станции: плеер забирает данные в реальном времени (100 Б каждые 100 мс),
    /// станция на секунду замолкает, а плеер всё равно не видит паузы.
    #[tokio::test]
    async fn queue_hides_upstream_stall_from_player() {
        // 20 кусков по 100 мс; потом станция молчит 1 с и продолжает ещё 10 кусков
        let mut parts: Vec<(u64, &'static [u8])> = (0..20).map(|_| (100, &b"0123456789"[..])).collect();
        parts.push((1000, b"0123456789"));
        parts.extend((0..9).map(|_| (100, &b"0123456789"[..])));
        let port = slow_station(parts).await;
        let url = u(&format!("http://127.0.0.1:{port}/live"));
        let client = reqwest::Client::new();
        let first = client.get(url.clone()).send().await.unwrap();
        let (tx, rx) = live_channel();
        tokio::pin!(rx);
        let cfg = LiveCfg { silence: Duration::from_secs(3), give_up: Duration::from_secs(5), prefill: Duration::from_millis(1200) };
        tokio::spawn(pump_live(client, url, first, tx, cfg));
        // плеер забирает по куску каждые 100 мс, как играющий звук
        let mut last = tokio::time::Instant::now();
        let mut worst = Duration::ZERO;
        let mut got = 0;
        while got < 30 {
            let chunk = tokio::time::timeout(Duration::from_secs(3), rx.next()).await.expect("поток встал").unwrap().unwrap();
            got += chunk.len() / 10;
            if got > 12 {
                worst = worst.max(last.elapsed()); // самый долгий промежуток между порциями
            }
            last = tokio::time::Instant::now();
            tokio::time::sleep(Duration::from_millis(100 * (chunk.len() / 10) as u64)).await; // играем то, что взяли
        }
        assert!(worst < Duration::from_millis(400), "плеер увидел паузу {worst:?}, а запас должен был её спрятать");
    }

    #[test]
    fn range_from_zero_counts_as_live_start() {
        let h = |v: &str| HeaderValue::from_str(v).unwrap();
        assert!(from_start(&h("bytes=0-")));
        assert!(from_start(&h(" bytes=0- ")));
        assert!(!from_start(&h("bytes=1000-")));
        assert!(!from_start(&h("bytes=0-99")));
    }

    #[test]
    fn prefill_comes_from_query_with_limits() {
        let q = |v: &str| HashMap::from([("p".to_string(), v.to_string())]);
        assert_eq!(prefill_from(&HashMap::new()), Duration::from_secs(6));
        assert_eq!(prefill_from(&q("0")), Duration::ZERO);
        assert_eq!(prefill_from(&q("9")), Duration::from_secs(9));
        assert_eq!(prefill_from(&q("999")), Duration::from_secs(15));
        assert_eq!(prefill_from(&q("abc")), Duration::from_secs(6));
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
