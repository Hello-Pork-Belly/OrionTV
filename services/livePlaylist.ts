/**
 * 直播播放列表解析与"可播放候选"整理。
 *
 * 设计目标（只解决播放，不改播放源）：
 *  1. 容错解析：tvg-* / group-title / #EXTGRP / #EXTVLCOPT / #KODIPROP / `|User-Agent=`
 *  2. URL 规范化：percent-encode（修中文/空格路径），保留已有 %XX
 *  3. 协议识别：非 http(s)（rtmp/rtsp/rtp/mms…）标记为不支持，避免"黑屏无线索"
 *  4. 同名频道聚合：同一频道在列表里的多条 URL 变成"候选序列"，播放失败自动换下一条
 *  5. 剔除脏行（生成器把 "OK" 之类响应体写进列表的常见坑）
 */
import Logger from '@/utils/Logger';

const logger = Logger.withTag('LivePlaylist');

export interface LiveChannel {
  /** 稳定 id：优先 tvg-id，否则用清洗后的频道名 */
  id: string;
  name: string;
  group: string;
  logo: string;
  /** 按优先级排序的可播放候选（同频道可能有多条源） */
  candidates: LiveCandidate[];
  /** 选中的候选（默认第一条） */
  index: number;
}

export interface LiveCandidate {
  url: string;
  headers?: Record<string, string>;
  /** 非 http(s) 协议（rtmp/rtsp/rtp…）在 expo-av 上无法播放 */
  unsupported?: string;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const JUNK_RE = /^(?:ok|true|false|null|undefined|success|error|not found|\{.*\}|<.*>)$/i;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

/** 把 URL 里的非 ASCII / 空格做 percent-encode，但保留合法的 %XX 转义 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  // 拆出 `|Header=Value&...` 后缀（iptv-org / Kodi 风格）
  const sep = trimmed.indexOf('|');
  const base = sep >= 0 ? trimmed.slice(0, sep) : trimmed;
  const suffix = sep >= 0 ? trimmed.slice(sep + 1) : '';

  const encoded = base.replace(/%(?![0-9A-Fa-f]{2})|[^\x20-\x7E]/gu, (m) =>
    m === '%' ? '%25' : encodeURIComponent(m)
  ).replace(/ /g, '%20');

  return suffix ? `${encoded}|${suffix}` : encoded;
}

/** 从 `|User-Agent=x&Referer=y` 后缀里提取请求头 */
export function headersFromSuffix(raw: string): Record<string, string> | undefined {
  const sep = raw.indexOf('|');
  if (sep < 0) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.slice(sep + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = decodeURIComponent(part.slice(eq + 1).trim());
    if (/^(user-agent|referer|referrer|origin|cookie)$/i.test(k)) {
      out[k.toLowerCase() === 'referrer' ? 'Referer' : k.replace(/\b\w/g, (c) => c.toUpperCase())] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function stripSuffix(raw: string): string {
  const sep = raw.indexOf('|');
  return sep >= 0 ? raw.slice(0, sep) : raw;
}

/**
 * 切分 `#EXTINF:...attrs...,显示名`。
 * 用**第一个引号外的逗号**（M3U 惯例）：属性里的 `tvg-name="A,B"` 不会被误切，
 * 而显示名本身含逗号（如 `CCTV-1, 综合`）也不会被截断。
 */
export function splitExtinf(line: string): { attrs: string; name: string } {
  let inQuote = false;
  for (let i = 8; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      return { attrs: line.slice(8, i), name: line.slice(i + 1).trim() };
    }
  }
  return { attrs: line.slice(8), name: '' };
}

export function parseLivePlaylist(text: string): LiveChannel[] {
  const lines = text.split(/\r?\n/);
  const byKey = new Map<string, LiveChannel>();
  const order: string[] = [];
  let cur: { attrs: Record<string, string>; name: string; group?: string; headers?: Record<string, string> } | null = null;
  // 有些列表把 #EXTVLCOPT / #EXTGRP 写在 #EXTINF 之前，先缓冲给下一个频道
  const pending: { group?: string; headers?: Record<string, string> } = {};
  let junk = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const { attrs, name } = splitExtinf(line);
      const map: Record<string, string> = {};
      let m: RegExpExecArray | null;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(attrs))) map[m[1].toLowerCase()] = m[2];
      cur = {
        attrs: map,
        name: name || map['tvg-name'] || '未知频道',
        group: pending.group,
        headers: pending.headers,
      };
      pending.group = undefined;
      pending.headers = undefined;
      continue;
    }
    if (line.startsWith('#EXTGRP')) {
      const g = line.slice(line.indexOf(':') + 1).trim();
      if (cur) cur.group = g;
      else pending.group = g;
      continue;
    }
    if (line.toUpperCase().startsWith('#EXTVLCOPT')) {
      const body = line.split(':').slice(1).join(':').trim();
      const eq = body.indexOf('=');
      if (eq > 0) {
        const k = body.slice(0, eq).toLowerCase().replace(/^http-/, '');
        const v = body.slice(eq + 1).trim();
        if (k === 'user-agent' || k === 'referrer' || k === 'referer') {
          const key = k === 'user-agent' ? 'User-Agent' : 'Referer';
          if (cur) cur.headers = { ...(cur.headers || {}), [key]: v };
          else pending.headers = { ...(pending.headers || {}), [key]: v };
        }
      }
      continue;
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXTM3U')) continue;
      // #KODIPROP 等：不影响播放，忽略
      continue;
    }

    if (!URL_RE.test(line)) {
      if (JUNK_RE.test(line) || line.length < 48) junk += 1;
      continue;
    }
    if (!cur) continue;

    const suffixHeaders = headersFromSuffix(line);
    const headers = { ...(cur.headers || {}), ...(suffixHeaders || {}) };
    const url = normalizeUrl(line);
    const scheme = stripSuffix(url).split('://')[0].toLowerCase();
    const candidate: LiveCandidate = {
      url,
      headers: Object.keys(headers).length ? headers : undefined,
      unsupported: scheme === 'http' || scheme === 'https' ? undefined : scheme,
    };

    const key = (cur.attrs['tvg-id'] || cur.name || '').trim().toLowerCase() || url;
    let ch = byKey.get(key);
    if (!ch) {
      ch = {
        id: key,
        name: cur.name,
        group: cur.group || cur.attrs['group-title'] || 'Other',
        logo: cur.attrs['tvg-logo'] || '',
        candidates: [],
        index: 0,
      };
      byKey.set(key, ch);
      order.push(key);
    }
    // 同一 URL 不重复加入
    if (!ch.candidates.some((c) => c.url === candidate.url)) ch.candidates.push(candidate);
    cur = null;
  }

  if (junk) logger.info(`忽略了 ${junk} 行无法识别的内容（脏行/非 URL）`);
  const channels = order.map((k) => byKey.get(k)!).filter((c) => c.candidates.length > 0);
  const unsupportedOnly = channels.filter((c) => c.candidates.every((x) => x.unsupported));
  if (unsupportedOnly.length) {
    logger.info(`${unsupportedOnly.length} 个频道只有不支持的协议（无法在 expo-av 播放）`);
  }
  return channels;
}

/** 取当前候选；全部不可用时返回 null */
export function currentCandidate(ch: LiveChannel): LiveCandidate | null {
  const c = ch.candidates[ch.index];
  if (!c || c.unsupported) return null;
  return c;
}

/** 切到下一个候选，返回是否切换成功 */
export function advanceCandidate(ch: LiveChannel): boolean {
  for (let i = ch.index + 1; i < ch.candidates.length; i++) {
    if (!ch.candidates[i].unsupported) {
      ch.index = i;
      return true;
    }
  }
  return false;
}
