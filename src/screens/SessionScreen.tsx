import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ScrollView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import { useUser } from '@clerk/clerk-expo';
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
  const { user } = useUser();

  // Derive voice profile from Clerk metadata (set during onboarding)
  const meta = user?.publicMetadata as any;
  const speakerGender: string | undefined = meta?.gender;
  const speakerAge: number | undefined =
    meta?.age !== undefined ? Number(meta.age) : undefined;
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentSentText, setCurrentSentText] = useState<string | null>(null);
  const [currentReceivedText, setCurrentReceivedText] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [partnerSpeaking, setPartnerSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [hasError, setHasError] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  // ── Audio Playback ──────────────────────────────────────────────────────────
  const audioQueueRef = useRef<{ base64: string; index: number; text: string }[]>([]);
  const isPlayingQueueRef = useRef(false);

  const [isEchoGuardActive, setIsEchoGuardActive] = useState(false);

  const processAudioQueue = useCallback(async () => {
    if (isPlayingQueueRef.current || audioQueueRef.current.length === 0) return;

    isPlayingQueueRef.current = true;
    setIsPlayingAudio(true);

    // Set audio mode once at the start of the queue
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      });
    } catch (e) {
      console.warn('[SessionScreen] Audio mode error:', e);
    }

    while (audioQueueRef.current.length > 0) {
      audioQueueRef.current.sort((a, b) => a.index - b.index);
      const chunk = audioQueueRef.current.shift();
      if (!chunk) continue;

      if (chunk.index === 0) {
        setCurrentReceivedText(chunk.text);
      } else {
        setCurrentReceivedText((prev) => (prev ? prev + ' ' + chunk.text : chunk.text));
      }

      try {
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: `data:audio/wav;base64,${chunk.base64}` },
          { shouldPlay: true }
        );

        await new Promise((resolve) => {
          newSound.setOnPlaybackStatusUpdate((playbackStatus) => {
            if (playbackStatus.isLoaded && playbackStatus.didJustFinish) {
              resolve(true);
            }
          });
        });

        await newSound.unloadAsync();
      } catch (e) {
        console.error('[SessionScreen] Playback queue error:', e);
      }
    }

    setIsPlayingAudio(false);
    isPlayingQueueRef.current = false;

    // Echo Guard: Briefly prevent microphone from activating immediately after speaker stops
    setIsEchoGuardActive(true);
    setTimeout(() => {
      setIsEchoGuardActive(false);
    }, 800); // 800ms guard to let room echo dissipate
  }, []);

  // ── WebSocket ───────────────────────────────────────────────────────────────
  const { status, isProcessing, sendAudioChunk, endSession } = useWebSocket({
    onTranslatedAudioChunk: useCallback((payload: any) => {
      setPartnerSpeaking(false);
      // Ignore empty audio payloads (often caused by background noise rejection on backend)
      if (!payload.audioBase64 && !payload.text?.trim()) return;
      
      audioQueueRef.current.push({ base64: payload.audioBase64, index: payload.index, text: payload.text });
      processAudioQueue();
    }, [processAudioQueue]),

    onTranslatedAudioFinal: useCallback((original: string, translated: string) => {
      setPartnerSpeaking(false);
      // Ignore completely empty translations (e.g. background noise)
      if (!original.trim() && !translated.trim()) return;

      setTranscript(prev => [
        { id: `recv-${Date.now()}`, direction: 'received', original, translated, timestamp: Date.now() },
        ...prev,
      ]);
    }, []),

    onTranscript: useCallback((original: string, translated: string) => {
      // Ignore completely empty transcripts
      if (!original.trim() && !translated.trim()) return;
      setCurrentSentText(`${original} → ${translated}`);
    }, []),

    onPartnerDisconnected: useCallback(() => {
      setPartnerSpeaking(false);
      Alert.alert('Partner Disconnected', 'Your partner has left the session.', [{ text: 'OK', onPress: onEnd }]);
    }, [onEnd]),

    onError: useCallback((msg: string) => {
      setPartnerSpeaking(false);
      Alert.alert('Error', msg);
    }, []),

    // partner_speaking now ONLY fires when real audio arrives at the server.
    // No more false positives from VAD noise or cross-device leakage.
    onPartnerSpeaking: useCallback(() => {
      setPartnerSpeaking(true);
    }, []),

    // lock_released fires when server finishes processing (belt-and-suspenders
    // alongside translated_audio_final to guarantee partnerSpeaking clears).
    onLockReleased: useCallback(() => {
      setPartnerSpeaking(false);
    }, []),

    // turn_rejected is now a no-op — server ignores claim_turn entirely.
    onTurnRejected: useCallback(() => { }, []),
  });

  const silenceCallbackRef = useRef<(() => void) | undefined>(undefined);

  // VAD only drives the local UI (audio bars, "SPEECH DETECTED" text).
  // It no longer claims any server floor — audio_chunk arrival does that.
  const { isRecording, isCalibrating, isSpeaking, startRecording, stopRecording, audioLevel } =
    useAudioRecorder({
      onSpeechDetected: useCallback(() => {
        // No server call needed — visual feedback only via isSpeaking state
      }, []),
      onSilenceDetected: useCallback(() => {
        if (silenceCallbackRef.current) silenceCallbackRef.current();
      }, []),
      nearFieldOnly: true,
    });

  const handleSilenceStop = useCallback(async () => {
    try {
      const { base64, mimeType } = await stopRecording();
      if (base64 && base64.length > 100) {
        sendAudioChunk(base64, mimeType, myLang, partnerLang, role, sessionId, speakerGender, speakerAge);
      }
    } catch (e) {
      console.warn('[SessionScreen] Silence stop error:', e);
    }
  }, [stopRecording, sendAudioChunk, myLang, partnerLang, role, sessionId, speakerGender, speakerAge]);

  useEffect(() => {
    silenceCallbackRef.current = handleSilenceStop;
  }, [handleSilenceStop]);

  // ── Safety Watchdog ──────────────────────────────────────────────────────────
  // partnerSpeaking should self-clear via translated_audio / lock_released.
  // This is a last-resort 8s timeout for network hiccups or Gemini errors.
  const partnerSpeakingStartRef = useRef<number | null>(null);
  useEffect(() => {
    partnerSpeakingStartRef.current = partnerSpeaking ? Date.now() : null;
  }, [partnerSpeaking]);

  useEffect(() => {
    const watchdog = setInterval(() => {
      const lockedAt = partnerSpeakingStartRef.current;
      if (lockedAt && !isPlayingAudio && Date.now() - lockedAt > 8_000) {
        console.warn('[SessionScreen] Watchdog: partnerSpeaking >8s with no audio — force clearing.');
        setPartnerSpeaking(false);
        partnerSpeakingStartRef.current = null;
      }
    }, 2_000);
    return () => clearInterval(watchdog);
  }, [isPlayingAudio]);


  // ── Auto-Hands-Free Loop ────────────────────────────────────────────────────
  const canRecord = status === 'connected' && 
    !isProcessing && 
    !isPlayingAudio && 
    !partnerSpeaking && 
    !isEchoGuardActive && 
    !isPaused && 
    !hasError;

  const isTransitioningRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    const manageRecordingState = async () => {
      if (isTransitioningRef.current) return;
      
      if (canRecord && !isRecording) {
        try {
          isTransitioningRef.current = true;
          setCurrentSentText(null);
          setCurrentReceivedText(null);
          await startRecording();
        } catch (e) {
          console.warn('Auto start error:', e);
          if (mounted) setHasError(true);
        } finally {
          isTransitioningRef.current = false;
        }
      } else if (!canRecord && isRecording) {
        try {
          isTransitioningRef.current = true;
          await stopRecording();
        } catch (e) {
          // Ignore "No active recording" as it's a side-effect of quick state changes
          if (!(e instanceof Error && e.message.includes('No active recording'))) {
            console.warn('Auto stop error:', e);
          }
        } finally {
          isTransitioningRef.current = false;
        }
      }
    };
    manageRecordingState();
    return () => { mounted = false; };
  }, [canRecord, isRecording, startRecording, stopRecording]);


  // ── Pulse animation ─────────────────────────────────────────────────────────
  const pulseAnim = useSharedValue(1);
  useEffect(() => {
    if (isSpeaking) {
      pulseAnim.value = withRepeat(
        withSequence(
          withTiming(1.6, { duration: 600, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 600, easing: Easing.in(Easing.ease) })
        ),
        -1, false
      );
    } else {
      pulseAnim.value = withTiming(1, { duration: 300 });
    }
  }, [isSpeaking, pulseAnim]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseAnim.value }],
    opacity: isSpeaking ? 1 - (pulseAnim.value - 1) * 1.2 : 0,
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

  const barHeights = useMemo(() =>
    [...Array(6)].map((_, i) => {
      const phase = (i / 6) * Math.PI * 2;
      return 12 + Math.abs(Math.sin(phase + audioLevel * 10)) * audioLevel * 64;
    }),
    [audioLevel]);

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
        {isRecording && !isCalibrating && !partnerSpeaking && (
          <View style={styles.livePanel}>
            <View style={styles.barsRow}>
              {barHeights.map((h, i) => (
                <View
                  key={i}
                  style={[styles.audioBar, { height: h }, isSpeaking && styles.audioBarSpeaking]}
                />
              ))}
            </View>
            <Text style={[styles.listeningLabel, isSpeaking && { color: '#fff' }]}>
              {isSpeaking ? 'SPEECH DETECTED...' : 'LISTENING...'}
            </Text>
          </View>
        )}

        {isCalibrating && (
          <View style={styles.livePanel}>
            <ActivityIndicator size="small" color="#39FF14" />
            <Text style={[styles.listeningLabel, { marginTop: 12 }]}>CALIBRATING ROOM NOISE...</Text>
          </View>
        )}

        {partnerSpeaking && (
          <View style={[styles.livePanel, { borderColor: 'rgba(255,165,0,0.3)', backgroundColor: 'rgba(255,165,0,0.05)' }]}>
            <Feather name="user" size={24} color="orange" style={{ marginBottom: 8 }} />
            <Text style={[styles.listeningLabel, { color: 'orange' }]}>PARTNER IS SPEAKING...</Text>
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
        {!isRecording && !isProcessing && !currentSentText && !currentReceivedText && !isPlayingAudio && !partnerSpeaking && !isCalibrating && !hasError && (
          <View style={styles.emptyState}>
            <Feather name={isPaused ? "mic-off" : "mic"} size={40} color="rgba(255,255,255,0.1)" />
            <Text style={styles.emptyTitle}>
              {status === 'connected'
                ? (isPaused ? 'Listening Paused' : 'Ready to speak')
                : 'Waiting for connection...'}
            </Text>
            <Text style={styles.emptySub}>
              {status === 'connected'
                ? (isPaused ? 'Tap to resume hands-free mode' : 'Hands-free mode active. Just speak!')
                : 'Make sure the other device has scanned the QR code.'}
            </Text>
          </View>
        )}

        {hasError && (
          <View style={styles.emptyState}>
            <Feather name="alert-circle" size={40} color="#ef4444" />
            <Text style={styles.emptyTitle}>Microphone Error</Text>
            <Text style={styles.emptySub}>Please tap the button below to retry.</Text>
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
          {isSpeaking && <Animated.View style={[styles.micPulseRing, pulseStyle]} />}
          <TouchableOpacity
            style={[
              styles.micBtn,
              isPaused && styles.micBtnPaused,
              (!isPaused && status !== 'connected' && !hasError) && styles.micBtnDisabled,
              hasError && styles.micBtnError,
            ]}
            onPress={() => {
              if (hasError) setHasError(false);
              else setIsPaused(!isPaused);
            }}
            disabled={status !== 'connected'}
            activeOpacity={0.8}
          >
            <Feather
              name={hasError ? 'refresh-cw' : isPaused ? 'mic-off' : 'mic'}
              size={32}
              color={isPaused || hasError ? '#fff' : status !== 'connected' ? 'rgba(0,0,0,0.4)' : '#000'}
            />
          </TouchableOpacity>
        </View>
        <Text style={styles.micHint}>
          {hasError ? 'Tap to Retry Microphone' : isPaused ? 'Tap to Resume Listening' : status === 'connected' ? 'Tap to Pause Listening' : 'Please wait...'}
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
    width: 5, backgroundColor: 'rgba(57,255,20,0.4)', borderRadius: 3, marginHorizontal: 3,
  },
  audioBarSpeaking: {
    backgroundColor: '#39FF14',
  },
  listeningLabel: {
    color: 'rgba(57,255,20,0.5)', fontSize: 10,
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
    backgroundColor: '#39FF14',
  },
  micBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 12, elevation: 6,
  },
  micBtnPaused: { backgroundColor: '#ef4444', shadowColor: '#ef4444' },
  micBtnError: { backgroundColor: '#f97316', shadowColor: '#f97316' },
  micBtnDisabled: { backgroundColor: 'rgba(57,255,20,0.25)', shadowOpacity: 0 },
  micHint: {
    color: 'rgba(255,255,255,0.25)', fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 0.5,
  },
});