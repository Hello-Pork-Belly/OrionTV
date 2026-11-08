import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, StyleSheet, Text, ActivityIndicator, Pressable } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";
import type { LiveCandidate } from "@/services/livePlaylist";

interface LivePlayerProps {
  candidate: LiveCandidate | null;
  channelTitle?: string | null;
  /** 加载/播放失败时通知父组件（换下一个候选源，或提示用户） */
  onFailed?: (reason: string) => void;
  onPlaybackStatusUpdate?: (status: AVPlaybackStatus) => void;
}

const PLAYBACK_TIMEOUT = 15000;

export default function LivePlayer({
  candidate,
  channelTitle,
  onFailed,
  onPlaybackStatusUpdate,
}: LivePlayerProps) {
  const video = useRef<Video>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  useKeepAwake();

  const fail = useCallback(
    (reason: string) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setIsLoading(false);
      setErrorText(reason);
      onFailed?.(reason);
    },
    [onFailed]
  );

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setErrorText(null);

    if (!candidate) {
      setIsLoading(false);
      return;
    }
    if (candidate.unsupported) {
      setErrorText(`该频道使用 ${candidate.unsupported.toUpperCase()} 协议，本播放器不支持`);
      onFailed?.(`unsupported:${candidate.unsupported}`);
      return;
    }

    setIsLoading(true);
    timeoutRef.current = setTimeout(() => fail("加载超时（15s）"), PLAYBACK_TIMEOUT);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [candidate, fail, onFailed]);

  const handleStatus = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      if (status.isPlaying) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setIsLoading(false);
        setErrorText(null);
      } else if (status.isBuffering) {
        setIsLoading(true);
      }
    } else if (status.error) {
      fail(`播放错误：${status.error}`);
    }
    onPlaybackStatusUpdate?.(status);
  };

  if (!candidate) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按向下键选择频道</Text>
      </View>
    );
  }

  if (errorText) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>{errorText}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={() => {
            setErrorText(null);
            setIsLoading(true);
            video.current?.replayAsync().catch(() => fail("重试失败"));
          }}
        >
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
        <Text style={styles.hintText}>按 ← / → 换台，按 ↓ 打开频道列表</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Video
        ref={video}
        key={candidate.url}
        style={styles.video}
        source={{ uri: candidate.url, headers: candidate.headers }}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay
        useNativeControls={false}
        onPlaybackStatusUpdate={handleStatus}
        onError={(e) => fail(`无法播放：${e}`)}
      />
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>加载中…</Text>
        </View>
      )}
      {channelTitle && !isLoading && (
        <View style={styles.overlay}>
          <Text style={styles.title}>{channelTitle}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#000" },
  video: { flex: 1, alignSelf: "stretch" },
  overlay: { position: "absolute", top: 20, left: 20, backgroundColor: "rgba(0,0,0,0.5)", padding: 10, borderRadius: 5 },
  title: { color: "#fff", fontSize: 18 },
  messageText: { color: "#fff", fontSize: 16, marginTop: 10 },
  hintText: { color: "#999", fontSize: 12, marginTop: 12 },
  retryButton: { marginTop: 14, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 6, backgroundColor: "#2f6fed" },
  retryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.5)" },
});
