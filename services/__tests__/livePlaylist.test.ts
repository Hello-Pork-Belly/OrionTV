import {
  advanceCandidate,
  currentCandidate,
  headersFromSuffix,
  normalizeUrl,
  parseLivePlaylist,
  splitExtinf,
} from '@/services/livePlaylist';

describe('normalizeUrl', () => {
  it('对中文路径做 percent-encode', () => {
    expect(normalizeUrl('https://a.com/视频/第1集.m3u8')).toBe(
      'https://a.com/%E8%A7%86%E9%A2%91/%E7%AC%AC1%E9%9B%86.m3u8'
    );
  });
  it('保留已有的 %XX 与 ASCII', () => {
    expect(normalizeUrl('https://a.com/a%20b/1.m3u8?x=1')).toBe('https://a.com/a%20b/1.m3u8?x=1');
  });
  it('把空格编码为 %20', () => {
    expect(normalizeUrl('https://a.com/a b.m3u8')).toBe('https://a.com/a%20b.m3u8');
  });
  it('保留 |Header= 后缀', () => {
    expect(normalizeUrl('https://a.com/视频.m3u8|User-Agent=x')).toBe(
      'https://a.com/%E8%A7%86%E9%A2%91.m3u8|User-Agent=x'
    );
  });
});

describe('headersFromSuffix', () => {
  it('解析 User-Agent 与 Referer', () => {
    expect(headersFromSuffix('http://a/b.m3u8|User-Agent=Mozilla&Referer=https://x/')).toEqual({
      'User-Agent': 'Mozilla',
      Referer: 'https://x/',
    });
  });
  it('Referrer 归一化为 Referer', () => {
    expect(headersFromSuffix('http://a/b.m3u8|referrer=https://y/')).toEqual({ Referer: 'https://y/' });
  });
  it('无后缀返回 undefined', () => {
    expect(headersFromSuffix('http://a/b.m3u8')).toBeUndefined();
  });
});

describe('splitExtinf', () => {
  it('名字里的逗号不会截断', () => {
    const { name } = splitExtinf('#EXTINF:-1 tvg-id="x",CCTV-1, 综合');
    expect(name).toBe('CCTV-1, 综合');
  });
  it('引号内的逗号被忽略', () => {
    const { attrs, name } = splitExtinf('#EXTINF:-1 tvg-name="A,B" group-title="g",A,B');
    expect(attrs).toContain('tvg-name="A,B"');
    expect(name).toBe('A,B');
  });
});

describe('parseLivePlaylist', () => {
  const sample = [
    '#EXTM3U x-tvg-url="https://epg.example/e.xml"',
    '#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV-1" tvg-logo="https://l/1.png" group-title="央视",CCTV-1',
    'http://100.111.48.90:18798/m/CCTV-1.m3u8',
    '#EXTINF:-1 tvg-id="cctv1" tvg-logo="https://l/1.png" group-title="央视",CCTV-1',
    'https://migu.example/cctv1/index.m3u8',
    'OK',
    '#EXTINF:-1 group-title="香港",無綫新聞台',
    'https://tv.example/hktv/tvbnews.m3u8',
    '#EXTVLCOPT:http-user-agent=SpecialUA',
    '#EXTVLCOPT:http-referrer=https://ref/',
    '#EXTINF:-1 group-title="测试",需要UA的台',
    'https://ua.example/x.m3u8',
    '#EXTINF:-1 group-title="测试",RTMP台',
    'rtmp://rtmp.example/live/stream',
    '#EXTGRP:分组覆盖',
    '#EXTINF:-1,无分组但有EXTGRP',
    'https://plain.example/a.m3u8',
  ].join('\n');

  const channels = parseLivePlaylist(sample);
  const byName = (n: string) => channels.find((c) => c.name === n)!;

  it('同 tvg-id 的多条源聚合成候选（CCTV-1 两条）', () => {
    expect(byName('CCTV-1').candidates).toHaveLength(2);
    expect(byName('CCTV-1').candidates[0].url).toContain('100.111.48.90');
  });

  it('脏行 OK 不会成为频道', () => {
    expect(channels.some((c) => c.candidates.some((x) => x.url.includes('OK')))).toBe(false);
  });

  it('#EXTVLCOPT 的 UA/Referer 落到 headers', () => {
    expect(byName('需要UA的台').candidates[0].headers).toEqual({
      'User-Agent': 'SpecialUA',
      Referer: 'https://ref/',
    });
  });

  it('非 http(s) 协议标记为 unsupported，currentCandidate 返回 null', () => {
    const rtmp = byName('RTMP台');
    expect(rtmp.candidates[0].unsupported).toBe('rtmp');
    expect(currentCandidate(rtmp)).toBeNull();
  });

  it('#EXTGRP 覆盖 group', () => {
    expect(byName('无分组但有EXTGRP').group).toBe('分组覆盖');
  });

  it('advanceCandidate 切到下一个可用源，用尽后返回 false', () => {
    const ch = byName('CCTV-1');
    expect(advanceCandidate(ch)).toBe(true);
    expect(currentCandidate(ch)?.url).toContain('migu.example');
    expect(advanceCandidate(ch)).toBe(false);
  });
});
