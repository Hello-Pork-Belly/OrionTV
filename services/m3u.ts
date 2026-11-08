/**
 * 兼容层：保留旧的导出名，内部换成容错解析器（services/livePlaylist）。
 *
 * 旧代码用的是扁平的 `Channel[]`（一个频道一条 URL），新解析器会把"同一频道的多条源"
 * 聚合成 candidates。这里把候选展开成多条、第一条优先，让旧调用方行为不变，
 * 同时把 headers / 协议不支持的信息带出去。
 */
import Logger from '@/utils/Logger';
import {
  LiveChannel,
  currentCandidate,
  parseLivePlaylist,
} from '@/services/livePlaylist';

const logger = Logger.withTag('M3U');

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
  headers?: Record<string, string>;
}

const toChannel = (ch: LiveChannel): Channel => ({
  id: ch.id,
  name: ch.name,
  url: currentCandidate(ch)?.url ?? ch.candidates[0]?.url ?? '',
  logo: ch.logo,
  group: ch.group,
  headers: currentCandidate(ch)?.headers,
});

export const parseM3U = (m3uText: string): Channel[] => parseLivePlaylist(m3uText).map(toChannel);

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  try {
    const response = await fetch(m3uUrl);
    if (!response.ok) throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    return parseM3U(await response.text());
  } catch (error) {
    logger.info('Error fetching or parsing M3U:', error);
    return [];
  }
};

/**
 * 直播流地址原样使用（现在的解析器已经在 parse 阶段做了 percent-encode），
 * 不再拼服务端代理 —— 之前那段注释掉的 `/proxy` 端点在这个 MoonTV fork 里根本不存在。
 */
export const getPlayableUrl = (originalUrl: string | null): string | null => originalUrl || null;
