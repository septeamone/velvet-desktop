//! Журнал радио: короткие строки про обрывы и переподключения, чтобы по факту видеть, какие станции падают.
//! Лежит в папке логов приложения (radio.log); при росте больше 512 КБ старый файл уступает место новому.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 512 * 1024;
static FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("radio.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("radio.old.log"));
    }
    let _ = FILE.set(path);
}

pub fn line(text: &str) {
    let Some(path) = FILE.get() else { return };
    let text: String = text.chars().filter(|c| !c.is_control()).take(400).collect();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {}", stamp(), text);
    }
}

/// Последние строки журнала (для кнопки «Скопировать журнал»): не больше 300 строк и 64 КБ.
pub fn tail() -> Option<String> {
    let text = fs::read_to_string(FILE.get()?).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.len().saturating_sub(300);
    let joined = lines[from..].join("\n");
    let skip = joined.len().saturating_sub(64 * 1024);
    let start = (skip..joined.len()).find(|i| joined.is_char_boundary(*i)).unwrap_or(0);
    Some(joined[start..].to_string())
}

/// Время по Гринвичу в виде 2026-10-13T11:02:03Z (без внешних библиотек).
fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn stamp_has_iso_shape() {
        let s = super::stamp();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z') && &s[10..11] == "T");
    }
}
