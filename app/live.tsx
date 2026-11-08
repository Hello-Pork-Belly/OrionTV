import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Modal, useTVEventHandler, HWEvent, Text } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import LivePlayer from "@/components/LivePlayer";
import { parseLivePlaylist, currentCandidate, advanceCandidate, LiveChannel } from "@/services/livePlaylist";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import Logger from "@/utils/Logger";

const logger = Logger.withTag('Live');
const LAST_CHANNEL_KEY = "mytv_live_last_channel";

export default function LiveScreen() {
  const { m3uUrl } = useSettingsStore();

  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, LiveChannel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  /** 候选源切换后强制重绘（advanceCandidate 是原地修改） */
  const [version, setVersion] = useState(0);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const currentChannel = channels[currentChannelIndex] ?? null;
  const currentCand = currentChannel ? currentCandidate(currentChannel) : null;

  const showChannelTitle = useCallback((title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadChannels = async () => {
      if (!m3uUrl) {
        setLoadError("未配置直播源（设置里填 m3u 地址）");
        return;
      }
      setIsLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(m3uUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        // 让出一帧，避免大列表解析卡住 UI
        await new Promise((r) => setTimeout(r, 0));
        const parsed = parseLivePlaylist(text);
        if (cancelled) return;
        if (!parsed.length) throw new Error("解析不到任何频道");

        const groups: Record<string, LiveChannel[]> = {};
        for (const ch of parsed) (groups[ch.group || "Other"] ||= []).push(ch);
        const names = Object.keys(groups);

        setChannels(parsed);
        setGroupedChannels(groups);
        setChannelGroups(names);
        setSelectedGroup(names[0] ?? "");

        // 恢复上次看的频道
        let startIndex = 0;
        try {
          const last = await AsyncStorage.getItem(LAST_CHANNEL_KEY);
          const idx = last ? parsed.findIndex((c) => c.id === last) : -1;
          if (idx >= 0) startIndex = idx;
        } catch {
          /* ignore */
        }
        setCurrentChannelIndex(startIndex);
        showChannelTitle(parsed[startIndex]?.name ?? parsed[0].name);
        logger.info(`已载入 ${parsed.length} 个频道（${names.length} 组）`);
      } catch (e) {
        logger.info("载入直播源失败:", e);
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "载入失败");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    loadChannels();
    return () => {
      cancelled = true;
    };
  }, [m3uUrl, showChannelTitle]);

  const persistCurrent = useCallback((ch: LiveChannel) => {
    AsyncStorage.setItem(LAST_CHANNEL_KEY, ch.id).catch(() => {});
  }, []);

  const handleSelectChannel = (channel: LiveChannel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
      persistCurrent(channel);
    }
  };

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      if (channels.length === 0) return;
      const newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % channels.length
          : (currentChannelIndex - 1 + channels.length) % channels.length;
      setCurrentChannelIndex(newIndex);
      showChannelTitle(channels[newIndex].name);
      persistCurrent(channels[newIndex]);
    },
    [channels, currentChannelIndex, persistCurrent, showChannelTitle]
  );

  /** 当前候选源失败：自动换同频道的下一个源；没有了就提示 */
  const handlePlaybackFailed = useCallback(
    (reason: string) => {
      logger.info(`频道 ${currentChannel?.name ?? "-"} 播放失败: ${reason}`);
      if (currentChannel && advanceCandidate(currentChannel)) {
        logger.info(`已切换到备用源 ${currentChannel.index + 1}/${currentChannel.candidates.length}`);
        setVersion((v) => v + 1);
        return;
      }
      // 没有备用源了：提示（保留在屏幕上，等用户换台）
    },
    [currentChannel]
  );

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== 'tv') return;
      if (isChannelListVisible) return;
      if (event.eventType === "down") setIsChannelListVisible(true);
      else if (event.eventType === "left") changeChannel("prev");
      else if (event.eventType === "right") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderLiveContent = () => (
    <>
      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: "#fff", marginTop: 10 }}>正在载入频道…</Text>
        </View>
      ) : loadError ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#fff", fontSize: 16, textAlign: "center" }}>直播源载入失败：{loadError}</Text>
          <Text style={{ color: "#999", fontSize: 12, marginTop: 10, textAlign: "center" }}>
            检查设置里的 m3u 地址是否可访问（手机浏览器能打开才行）
          </Text>
        </View>
      ) : (
        <LivePlayer
          key={`${currentChannel?.id ?? "none"}-${currentChannel?.index ?? 0}-${version}`}
          candidate={currentCand}
          channelTitle={channelTitle}
          onFailed={handlePlaybackFailed}
        />
      )}
      <Modal
        animationType="slide"
        transparent={true}
        visible={isChannelListVisible}
        onRequestClose={() => setIsChannelListVisible(false)}
      >
        <View style={dynamicStyles.modalContainer}>
          <View style={dynamicStyles.modalContent}>
            <Text style={dynamicStyles.modalTitle}>选择频道（{channels.length}）</Text>
            <View style={dynamicStyles.listContainer}>
              <View style={dynamicStyles.groupColumn}>
                <FlatList
                  data={channelGroups}
                  keyExtractor={(item, index) => `group-${item}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item}
                      onPress={() => setSelectedGroup(item)}
                      isSelected={selectedGroup === item}
                      style={dynamicStyles.groupButton}
                      textStyle={dynamicStyles.groupButtonText}
                    />
                  )}
                />
              </View>
              <View style={dynamicStyles.channelColumn}>
                <FlatList
                  data={groupedChannels[selectedGroup] || []}
                  keyExtractor={(item, index) => `${item.id}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item.candidates.length > 1 ? `${item.name}（${item.candidates.length} 源）` : item.name}
                      onPress={() => handleSelectChannel(item)}
                      isSelected={currentChannel?.id === item.id}
                      hasTVPreferredFocus={currentChannel?.id === item.id}
                      style={dynamicStyles.channelItem}
                      textStyle={dynamicStyles.channelItemText}
                    />
                  )}
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  if (deviceType === 'tv') return content;

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: { flex: 1 },
    modalContainer: {
      flex: 1,
      flexDirection: "row",
      justifyContent: isMobile ? "center" : "flex-end",
      backgroundColor: "transparent",
    },
    modalContent: {
      width: isMobile ? '90%' : isTablet ? 400 : 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      padding: spacing,
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    listContainer: { flex: 1, flexDirection: isMobile ? "column" : "row" },
    groupColumn: { flex: isMobile ? 0 : 1, marginRight: isMobile ? 0 : spacing / 2, marginBottom: isMobile ? spacing : 0, maxHeight: isMobile ? 120 : undefined },
    channelColumn: { flex: isMobile ? 1 : 2 },
    groupButton: { paddingVertical: isMobile ? minTouchTarget / 4 : 8, paddingHorizontal: spacing / 2, marginVertical: isMobile ? 2 : 4, minHeight: isMobile ? minTouchTarget * 0.7 : undefined },
    groupButtonText: { fontSize: isMobile ? 14 : 13 },
    channelItem: { paddingVertical: isMobile ? minTouchTarget / 5 : 6, paddingHorizontal: spacing, marginVertical: isMobile ? 2 : 3, minHeight: isMobile ? minTouchTarget * 0.8 : undefined },
    channelItemText: { fontSize: isMobile ? 14 : 12 },
  });
};
