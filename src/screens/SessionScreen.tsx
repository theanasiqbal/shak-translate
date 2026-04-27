import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import Animated, {
  useSharedValue, useAnimatedStyle,
  withRepeat, withSequence, withTiming, Easing,
} from 'react-native-reanimated';

import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useWebSocket, TranslatedAudioPayload } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';

interface SessionScreenProps {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
  onEnd: () => void;
}

interface TranscriptEntry {
  id: string;
  direction: 'sent' | 'received';
  original: string;
  translated: string;
  timestamp: number;
}

export function SessionScreen({
  sessionId,
  role,
  myLang,
  partnerLang,
  onEnd,
}: SessionScreenProps) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentSentText, setCurrentSentText] = useState<string | null>(null);
  const [currentReceivedText, setCurrentReceivedText] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const silenceCallbackRef = useRef<(() => void) | undefined>(undefined);

  // ── Audio Playback ──────────────────────────────────────────────────────────
  const playBase64Audio = useCallback(async (audioBase64: string) => {
    try {
      if (sound) {
        await sound.stopAsync();
        await sound.unloadAsync();
        setSound(null);
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: `data:audio/wav;base64,${audioBase64}` },
        { shouldPlay: true }
      );
      setSound(newSound);
      setIsPlayingAudio(true);

      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setIsPlayingAudio(false);
        }
      });
    } catch (e) {
      console.error('[SessionScreen] Playback error:', e);
      setIsPlayingAudio(false);
    }
  }, [sound]);

  // ── WebSocket ───────────────────────────────────────────────────────────────
  const { status, isProcessing, sendAudioChunk, endSession } = useWebSocket({
    onTranslatedAudio: useCallback((payload: TranslatedAudioPayload) => {
      // Show the received translation
      setCurrentReceivedText(payload.translatedText);
      setTranscript(prev => [
        {
          id: `recv-${Date.now()}`,
          direction: 'received',
          original: payload.originalText,
          translated: payload.translatedText,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      // Play the audio
      playBase64Audio(payload.audioBase64);
    }, [playBase64Audio]),

    onTranscript: useCallback((original: string, translated: string) => {
      setCurrentSentText(`${original} → ${translated}`);
    }, []),

    onPartnerDisconnected: useCallback(() => {
      Alert.alert(
        'Partner Disconnected',
        'Your partner has left the session.',
        [{ text: 'OK', onPress: onEnd }]
      );
    }, [onEnd]),

    onError: useCallback((msg: string) => {
      Alert.alert('Error', msg);
    }, []),
  });

  // ── Recording ───────────────────────────────────────────────────────────────
  const handleSilenceDetected = useCallback(() => {
    if (silenceCallbackRef.current) {
      silenceCallbackRef.current();
    }
  }, []);

  const { isRecording, startRecording, stopRecording, audioLevel } =
    useAudioRecorder(handleSilenceDetected);

  const handleRecordPress = async () => {
    if (isRecording) {
      try {
        const { base64, mimeType } = await stopRecording();
        if (base64 && base64.length > 100) {
          sendAudioChunk(base64, mimeType, myLang, partnerLang, role, sessionId);
        }
      } catch (e) {
        console.warn('[SessionScreen] Stop recording error:', e);
      }
    } else {
      setCurrentSentText(null);
      setCurrentReceivedText(null);
      await startRecording();
    }
  };

  const handleSilenceStop = useCallback(async () => {
    if (!isRecording) return;
    try {
      const { base64, mimeType } = await stopRecording();
      if (base64 && base64.length > 100) {
        sendAudioChunk(base64, mimeType, myLang, partnerLang, role, sessionId);
      }
    } catch (e) {
      console.warn('[SessionScreen] Silence stop error:', e);
    }
  }, [isRecording, stopRecording, sendAudioChunk, myLang, partnerLang, role, sessionId]);

  useEffect(() => {
    silenceCallbackRef.current = handleSilenceStop;
  }, [handleSilenceStop]);

  // ── Pulse animation ─────────────────────────────────────────────────────────
  const pulseAnim = useSharedValue(1);
  useEffect(() => {
    if (isRecording) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1.6, { duration: 800, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 800, easing: Easing.in(Easing.ease) })
        ),
        -1, false
      );
    } else {
      pulseAnim.value = withTiming(1, { duration: 300 });
    }
  }, [isRecording]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseAnim.value }],
    opacity: isRecording ? 1 - (pulseAnim.value - 1) * 1.2 : 0,
  }));

  // ── End Session ─────────────────────────────────────────────────────────────
  const handleEnd = () => {
    Alert.alert('End Session', 'Are you sure you want to end this conversation?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End',
        style: 'destructive',
        onPress: () => {
          endSession(role, sessionId);
          onEnd();
        },
      },
    ]);
  };

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [transcript]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      sound?.unloadAsync();
    };
  }, [sound]);

  const canRecord = status === 'connected' && !isProcessing && !isPlayingAudio;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      {/* Header */}
      <View style={styles.header}>
        <StatusBadge status={status} role={role} />
        <View style={styles.langPair}>
          <Text style={styles.langText}>{myLang}</Text>
          <Feather name="arrow-right" size={12} color="rgba(255,255,255,0.3)" />
          <Text style={styles.langText}>{partnerLang}</Text>
        </View>
        <TouchableOpacity onPress={handleEnd} style={styles.endBtn}>
          <Feather name="phone-off" size={16} color="#ef4444" />
        </TouchableOpacity>
      </View>

      {/* Main content */}
      <View style={styles.mainContent}>

        {/* Live status panel */}
        {isRecording && (
          <View style={styles.livePanel}>
            <View style={styles.barsRow}>
              {[...Array(6)].map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.audioBar,
                    { height: 12 + Math.random() * (audioLevel || 0.1) * 64 },
                  ]}
                />
              ))}
            </View>
            <Text style={styles.listeningLabel}>LISTENING...</Text>
          </View>
        )}

        {isProcessing && (
          <View style={styles.processingPanel}>
            <ActivityIndicator size="small" color="#39FF14" />
            <Text style={styles.processingLabel}>TRANSLATING...</Text>
          </View>
        )}

        {isPlayingAudio && (
          <View style={styles.processingPanel}>
            <Feather name="volume-2" size={16} color="#39FF14" />
            <Text style={styles.processingLabel}>PLAYING...</Text>
          </View>
        )}

        {/* Current translation preview */}
        {currentSentText && !isRecording && !isProcessing && (
          <View style={styles.previewCard}>
            <Text style={styles.previewLabel}>YOU SAID</Text>
            <Text style={styles.previewText}>{currentSentText}</Text>
          </View>
        )}

        {currentReceivedText && !isProcessing && (
          <View style={[styles.previewCard, styles.previewCardReceived]}>
            <Text style={[styles.previewLabel, { color: '#39FF14' }]}>PARTNER SAID</Text>
            <Text style={styles.previewText}>{currentReceivedText}</Text>
          </View>
        )}

        {/* Empty state */}
        {!isRecording && !isProcessing && !currentSentText && !currentReceivedText && !isPlayingAudio && (
          <View style={styles.emptyState}>
            <Feather name="mic" size={40} color="rgba(255,255,255,0.1)" />
            <Text style={styles.emptyTitle}>
              {status === 'connected' ? 'Tap the mic to speak' : 'Waiting for connection...'}
            </Text>
            <Text style={styles.emptySub}>
              {status === 'connected'
                ? `Speak in ${myLang} — your partner hears ${partnerLang}`
                : 'Make sure the other device has scanned the QR code.'}
            </Text>
          </View>
        )}

        {/* Transcript */}
        {transcript.length > 0 && (
          <View style={styles.transcriptSection}>
            <View style={styles.transcriptHeader}>
              <Feather name="message-square" size={12} color="rgba(255,255,255,0.3)" />
              <Text style={styles.transcriptHeaderText}> CONVERSATION HISTORY</Text>
              <TouchableOpacity onPress={() => setTranscript([])}>
                <Text style={styles.clearText}>Clear</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              ref={scrollRef}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              {transcript.map((item) => (
                <View
                  key={item.id}
                  style={[
                    styles.transcriptBubble,
                    item.direction === 'sent' ? styles.bubbleSent : styles.bubbleReceived,
                  ]}
                >
                  <Text style={styles.bubbleOriginal}>{item.original}</Text>
                  <Text style={styles.bubbleTranslated}>{item.translated}</Text>
                  <Text style={styles.bubbleTime}>
                    {new Date(item.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <View style={styles.micWrapper}>
          {isRecording && <Animated.View style={[styles.micPulseRing, pulseStyle]} />}
          <TouchableOpacity
            style={[
              styles.micBtn,
              isRecording && styles.micBtnRecording,
              !canRecord && !isRecording && styles.micBtnDisabled,
            ]}
            onPress={handleRecordPress}
            disabled={!canRecord && !isRecording}
            activeOpacity={0.8}
          >
            <Feather
              name={isRecording ? 'mic-off' : 'mic'}
              size={32}
              color={isRecording ? '#fff' : !canRecord ? 'rgba(0,0,0,0.4)' : '#000'}
            />
          </TouchableOpacity>
        </View>
        <Text style={styles.micHint}>
          {isRecording ? 'Tap to stop  ·  Silence auto-stops' : canRecord ? 'Tap to speak' : 'Please wait...'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 240, height: 240, borderRadius: 120,
    backgroundColor: '#39FF14', opacity: 0.04,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 40 : 16, paddingBottom: 16,
    borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  langPair: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  langText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '600' },
  endBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    justifyContent: 'center', alignItems: 'center',
  },
  mainContent: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  livePanel: {
    alignItems: 'center', paddingVertical: 24,
    backgroundColor: 'rgba(57,255,20,0.04)',
    borderRadius: 16, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(57,255,20,0.1)',
  },
  barsRow: {
    flexDirection: 'row', alignItems: 'center', height: 64, marginBottom: 12,
  },
  audioBar: {
    width: 5, backgroundColor: '#39FF14', borderRadius: 3, marginHorizontal: 3,
  },
  listeningLabel: {
    color: '#39FF14', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 3,
  },
  processingPanel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, marginBottom: 16,
  },
  processingLabel: {
    color: 'rgba(255,255,255,0.5)', fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 3,
  },
  previewCard: {
    backgroundColor: '#1A1A1A', borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  previewCardReceived: { borderColor: 'rgba(57,255,20,0.2)' },
  previewLabel: {
    color: 'rgba(255,255,255,0.3)', fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5, marginBottom: 6,
  },
  previewText: { color: '#fff', fontSize: 15, fontWeight: '500', lineHeight: 22 },
  emptyState: {
    flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40, gap: 12,
  },
  emptyTitle: {
    color: 'rgba(255,255,255,0.35)', fontSize: 16, fontWeight: '500',
  },
  emptySub: {
    color: 'rgba(255,255,255,0.2)', fontSize: 13, textAlign: 'center', lineHeight: 18,
  },
  transcriptSection: { flex: 1 },
  transcriptHeader: {
    flexDirection: 'row', alignItems: 'center',
    marginBottom: 12,
  },
  transcriptHeaderText: {
    color: 'rgba(255,255,255,0.3)', fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 1.5, flex: 1,
  },
  clearText: { color: 'rgba(255,255,255,0.2)', fontSize: 11 },
  transcriptBubble: {
    borderRadius: 14, padding: 12, marginBottom: 8,
    borderWidth: 1,
  },
  bubbleSent: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.06)',
    marginLeft: 24,
  },
  bubbleReceived: {
    backgroundColor: 'rgba(57,255,20,0.04)',
    borderColor: 'rgba(57,255,20,0.1)',
    marginRight: 24,
  },
  bubbleOriginal: {
    color: 'rgba(255,255,255,0.45)', fontSize: 12, fontStyle: 'italic', marginBottom: 4,
  },
  bubbleTranslated: { color: '#fff', fontSize: 14, fontWeight: '500' },
  bubbleTime: {
    color: 'rgba(255,255,255,0.2)', fontSize: 10, marginTop: 6,
  },
  controls: {
    alignItems: 'center',
    paddingTop: 20, paddingBottom: Platform.OS === 'ios' ? 24 : 40,
    borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  micWrapper: {
    position: 'relative', justifyContent: 'center', alignItems: 'center', marginBottom: 12,
  },
  micPulseRing: {
    position: 'absolute', width: 90, height: 90, borderRadius: 45,
    backgroundColor: '#ef4444',
  },
  micBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  micBtnRecording: { backgroundColor: '#ef4444' },
  micBtnDisabled: { backgroundColor: 'rgba(57,255,20,0.25)' },
  micHint: {
    color: 'rgba(255,255,255,0.25)', fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 0.5,
  },
});
