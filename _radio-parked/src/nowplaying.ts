// @ts-nocheck — копия nowplaying.js из расширения (генерируется tools/gen-radio.mjs, руками не править)
import { viaProxy } from "./net";
// «Что играет сейчас» — берём из тех же источников, что и официальные сайты станций.
// Каждый источник возвращает { artist, title } или null; если у станции источника нет — названия песни не будет.

const getJson = async (url) => {
  const r = await fetch(viaProxy(url), { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

const mskDate = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// Бэкенд группы Europa Plus Media: Europa Plus, Ретро FM, Радио 7, Дорожное радио
const emg = (code) => async () => {
  const url = `https://meta.hostingradio.ru/emg/${code}/history?date=${mskDate()}&from=00:00&to=23:59&format=native&types=3&order=desc`;
  const [t] = await getJson(url);
  return t && { artist: t.artist, title: t.title };
};

// Radio Record: один запрос на все каналы, нужный — id 15016
const record = async () => {
  const { result } = await getJson('https://www.radiorecord.ru/api/stations/now/');
  const t = result.find((s) => s.id === 15016)?.track;
  return t && { artist: t.artist, title: t.song, caps: true };
};

// BBC Sounds
const bbc = async () => {
  const { data } = await getJson('https://rms.api.bbc.co.uk/v2/services/bbc_1xtra/segments/latest?limit=1');
  const t = data?.[0];
  // BBC иногда ставит «играет сейчас» с задержкой — берём и только что закончившийся трек
  const fresh = t?.offset?.now_playing || t?.offset?.label === 'Less Than a Minute Ago';
  if (!t || t.segment_type !== 'music' || !fresh) return null;
  return { artist: t.titles.primary, title: t.titles.secondary };
};

// Сеть станций Gazprom-Media: у них один формат
const fmgid = (slug) => async () => {
  const t = await getJson(`https://meta.fmgid.com/stations/${slug}/current.json`);
  return t.title ? { artist: t.artist, title: t.title } : null; // джингл/реклама — пропускаем
};
const nextApi = (host, slug) => async () => {
  const { result } = await getJson(`https://${host}/api/n/current`);
  const t = result.data[slug]?.current;
  if (!t?.title || t.title === 'Реклама') return null;
  return { artist: t.artist, title: t.title };
};

// Комик-радио и Relax FM: JSON с их хостинга, в нём бывают рекламы и джинглы (type != 3)
const gpm = (path) => async () => {
  const { current: t } = await getJson(`https://hls-01-gpm.hostingradio.ru/${path}/metadata.json`);
  return t?.type === 3 && t.title ? { artist: t.artist, title: t.title } : null;
};

// Название песни прямо из потока (ICY): открываем поток, читаем первый блок метаданных и закрываем.
const icy = (url, clean = (x) => x) => async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(viaProxy(url), { headers: { 'Icy-MetaData': '1' }, signal: ctrl.signal });
    const every = +r.headers.get('icy-metaint');
    if (!every) return null;
    const reader = r.body.getReader();
    let buf = new Uint8Array(0);
    const need = () => (buf.length > every ? every + 1 + buf[every] * 16 : every + 1);
    while (buf.length < need()) {
      const { value, done } = await reader.read();
      if (done) return null;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf); next.set(value, buf.length);
      buf = next;
    }
    const text = new TextDecoder().decode(buf.subarray(every + 1, need()));
    const m = /StreamTitle='(.*?)';/s.exec(text);
    const title = m && clean(m[1].trim());
    if (!title) return null;
    const [artist, ...rest] = title.split(' - ');
    return rest.length ? { artist, title: rest.join(' - ') } : { artist: null, title };
  } finally { clearTimeout(timer); ctrl.abort(); }
};

const SOURCES = {
  ultra: fmgid('ultra'),
  nashe: fmgid('nashe'),
  rusradio: nextApi('rusradio.ru', 'russkoe-radio'),
  dfm: nextApi('dfm.ru', 'dfm'),
  maximum: nextApi('maximum.ru', 'maximum'),
  hitfm: nextApi('hitfm.ru', 'hit-fm'),
  montecarlo: nextApi('montecarlo.ru', 'radio-monte-carlo'),
  comedy: gpm('comedyradio495'),
  relax: icy('https://pub0201.101.ru/stream/trust/mp3/128/24', (x) => x.replace(/ - \d+:\d{2}$/, '')),
  love: icy('https://stream2.n340.com/12_love_64_reg_44?type=aac&UID=1C254BF561F74C9BFDBAF0957371CB7B'),
  europaplus: emg('europaplus'),
  retro: emg('retrofm'),
  radio7: emg('radio7'),
  dorognoe: emg('dorognoe'),
  record,
  bbc1xtra: bbc,
};

// Для списка «что играет везде» берём только лёгкие источники (запрос JSON); ICY открывает сам поток, это тяжело.
export const LIVE = new Set(Object.keys(SOURCES).filter((id) => !['relax', 'love'].includes(id)));

const nice = (s) => s.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase());

export async function fetchTrack(stationId) {
  const t = await SOURCES[stationId]?.();
  if (!t || !t.title) return null;
  const artist = t.caps && t.artist === t.artist.toUpperCase() ? nice(t.artist) : t.artist;
  return artist ? `${artist} — ${t.title}` : t.title;
}
