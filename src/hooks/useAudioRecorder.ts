import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

// ── VAD Constants ──────────────────────────────────────────────────────────────
// Core timing
const CALIBRATION_DURATION_MS = 3000;   // 3s ambient sample on first start
const RECAL_INTERVAL_MS = 15_000; // recalibrate every 15s (was 30s) to catch env changes faster
const ROLLING_BUFFER_SIZE = 300;    // 30s of samples @ 100ms intervals

// EMA smoothing — kills wind gust spikes and AGC pump before any VAD logic
const EMA_ALPHA = 0.25; // 0.25 = responsive but smooth; lower = more lag

// Dual-window variance
// Short window captures speech amplitude modulation rhythm (~1000ms for slow speech)
// Long window classifies the noise environment character (~3s)
const SHORT_VARIANCE_WINDOW = 10;
const LONG_VARIANCE_WINDOW = 30;

// Gate limits
const MIN_THRESHOLD_DB = -65; // whisper-ready in silent rooms
const MAX_THRESHOLD_DB = -10; // ceiling clamp
const CONFIDENCE_DB_RANGE = 25;

// Ringtone / alarm / music detection
// Any sound that stays loud for this long WITH NO DIP and no dipObserved → rejected
// Turbulent noise mode uses a longer limit (7s) to accommodate talking-through-wind
const CONTINUOUS_SPEECH_LIMIT_DEFAULT_MS = 6_000;
const CONTINUOUS_SPEECH_LIMIT_TURBULENT_MS = 8_000;
const CONTINUOUS_SPEECH_LIMIT_SPEECHLIKE_MS = 5_000;

// ── Noise Type ─────────────────────────────────────────────────────────────────
type NoiseType = 'quiet' | 'constant' | 'turbulent' | 'speech_like';

// ── Per-environment VAD profiles ───────────────────────────────────────────────
// deltaDb      → how many dB above ambient floor = speech (SNR-based, not absolute)
// varianceMin  → minimum short-window variance to pass the gate (flat noise has < this)
// speechGate   → ms of continuous loud signal before confirming speech
// silenceGate  → ms of silence before ending the turn
// minSnr       → hard minimum SNR for any signal to be considered speech
const VAD_PROFILES: Record<NoiseType, {
  deltaDb: number;
  varianceMin: number;
  speechGate: number;
  silenceGate: number;
  minSnr: number;
}> = {
  quiet: { deltaDb: 8, varianceMin: 1.0, speechGate: 150, silenceGate: 800, minSnr: 6 },
  constant: { deltaDb: 10, varianceMin: 2.0, speechGate: 200, silenceGate: 800, minSnr: 8 },
  turbulent: { deltaDb: 14, varianceMin: 3.5, speechGate: 250, silenceGate: 1200, minSnr: 12 },
  speech_like: { deltaDb: 12, varianceMin: 2.0, speechGate: 200, silenceGate: 900, minSnr: 15 },
};

interface AudioRecorderOptions {
  onSpeechDetected?: (confidence: number) => void;
  onSilenceDetected?: () => void;
  nearFieldOnly?: boolean;
}

const NEAR_FIELD_MIN_DB = -30; // Loosened from -22 to accommodate quieter headset mics

export function useAudioRecorder({ onSpeechDetected, onSilenceDetected, nearFieldOnly }: AudioRecorderOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const isStartingRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const recordingStartTime = useRef<number>(0);

  // ── Calibration ────────────────────────────────────────────────────────────
  const isCalibratedRef = useRef<boolean>(false);
  const calibrationSamplesRef = useRef<number[]>([]);
  const calibrationEndRef = useRef<number | null>(null);

  // ── Thresholds ─────────────────────────────────────────────────────────────
  const thresholdRef = useRef<number>(-40); // absolute dB threshold (computed, not used as gate — SNR is the gate)
  const ambientFloorRef = useRef<number>(-60); // current ambient floor for SNR computation
  const lastRecalRef = useRef<number>(0);

  // ── EMA-smoothed meter ─────────────────────────────────────────────────────
  // Applied before any VAD logic. Kills wind gust spikes and AGC pump transients.
  const smoothedMeterRef = useRef<number>(-60);

  // ── Dual-window variance buffers ───────────────────────────────────────────
  const shortSamplesRef = useRef<number[]>([]); // 10 samples ~1000ms — speech modulation rhythm
  const longSamplesRef = useRef<number[]>([]); // 30 samples ~3s    — noise environment character
  const rollingBufferRef = useRef<number[]>([]); // 300 samples for recal

  // ── Noise classifier result ────────────────────────────────────────────────
  const noiseTypeRef = useRef<NoiseType>('quiet');

  // ── Turn state ─────────────────────────────────────────────────────────────
  const speechStartRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const turnClaimedRef = useRef<boolean>(false);

  // ── Ringtone / music rejection ─────────────────────────────────────────────
  const continuousLoudStartRef = useRef<number | null>(null);
  // dipObservedRef: any dip below threshold during a loud period marks it as human speech.
  // Ringtones and alarms NEVER dip; human voice always does between words/breaths.
  const dipObservedRef = useRef<boolean>(false);

  // ── Stable callback refs ───────────────────────────────────────────────────
  const onSpeechRef = useRef(onSpeechDetected);
  const onSilenceRef = useRef(onSilenceDetected);
  useEffect(() => {
    onSpeechRef.current = onSpeechDetected;
    onSilenceRef.current = onSilenceDetected;
  }, [onSpeechDetected, onSilenceDetected]);

  // ── Pure helpers ───────────────────────────────────────────────────────────

  // Adaptive percentile for ambient calculation.
  // In a noisy/turbulent room, the upper half of samples is noise-dominated —
  // use a lower percentile so we don't set the floor too high.
  const getAmbientPercentile = (longVar: number): number => {
    if (longVar < 3) return 0.80; // stable quiet   → P80
    if (longVar < 10) return 0.55; // moderate noise → P55
    return 0.35;                   // turbulent/loud → P35
  };

  const computeAmbient = (samples: number[], longVar: number): number => {
    const sorted = [...samples].sort((a, b) => a - b);
    const pct = getAmbientPercentile(longVar);
    return sorted[Math.floor(sorted.length * pct)];
  };

  const applyThreshold = (ambient: number): number => {
    const delta = 10; // conservative fixed delta for absolute threshold (only used as UI reference)
    return Math.max(MIN_THRESHOLD_DB, Math.min(MAX_THRESHOLD_DB, ambient + delta));
  };

  const computeVariance = (arr: number[]): number => {
    if (arr.length < 2) return 999;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  };

  // Classify the noise environment from the long-window variance and SNR.
  // This determines which VAD profile (gate parameters) to use.
  const classifyNoise = (longVar: number, snr: number): NoiseType => {
    if (longVar < 2) return 'constant';    // HVAC, fan, engine hum — very flat
    if (longVar > 18) return 'turbulent';   // wind, construction, crowd noise
    if (snr > 15) return 'speech_like'; // café voices, TV, music bleeding in
    return 'quiet';
  };

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanupRecording = useCallback(() => {
    setIsRecording(false);
    setIsCalibrating(false);
    setIsSpeaking(false);
    setAudioLevel(0);

    // Turn state
    hasSpokenRef.current = false;
    turnClaimedRef.current = false;
    speechStartRef.current = null;
    silenceStartRef.current = null;

    // Ringtone detection
    continuousLoudStartRef.current = null;
    dipObservedRef.current = false;

    // Reset short-window signal history so stale samples from the last
    // utterance don't bleed into the next recording's variance calculation.
    // Long-window buffers (rollingBufferRef, longSamplesRef) are intentionally
    // kept alive so background recalibration has continuous history.
    shortSamplesRef.current = [];
    smoothedMeterRef.current = -60;

    // ── Calibration is NOT reset here ───────────────────────────────────────
    // cleanupRecording fires after every stopRecording (i.e. every translation).
    // Resetting isCalibratedRef here would cause a 3s recalibration after every
    // single utterance. Calibration persists for the lifetime of the SessionScreen
    // mount; the 15s background recalibration handles room changes.
  }, []);

  // ── Start Recording ────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (isStartingRef.current || recordingRef.current) {
      console.warn('[useAudioRecorder] startRecording ignored: already starting or recording');
      return;
    }
    isStartingRef.current = true;

    try {
      const permissionResponse = await Audio.requestPermissionsAsync();
      if (permissionResponse.status !== 'granted') {
        throw new Error('Microphone permission denied');
      }

      // iOS: voiceChat → Apple Voice Processing I/O (noise cancel + echo cancel)
      // Android: VOICE_COMMUNICATION source → hardware NoiseSuppressor + AEC
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        ...(Platform.OS === 'ios' ? { iosCategoryMode: 'voiceChat' } : {}),
      });

      cleanupRecording();
      setRecordingUri(null);

      // Only calibrate if this is the very first recording of this session.
      // Subsequent recordings (after each translation) skip calibration and
      // reuse the existing threshold — background recalibration handles drift.
      if (!isCalibratedRef.current) {
        setIsCalibrating(true);
        calibrationSamplesRef.current = [];
        calibrationEndRef.current = Date.now() + CALIBRATION_DURATION_MS;
        thresholdRef.current = -40; // safe default until calibration completes
      } else {
        calibrationEndRef.current = null; // ensure calibration branch is skipped
      }

      const recordingOptions: Audio.RecordingOptions = {
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        android: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
        },
        ios: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
          audioQuality: Audio.IOSAudioQuality.MAX,
        },
        isMeteringEnabled: true,
      };

      const { recording } = await Audio.Recording.createAsync(
        recordingOptions,
        (status) => {
          if (!status.isRecording || status.metering === undefined) return;

          const rawMeter = status.metering;
          const now = Date.now();

          // ── STEP 1: EMA smooth the raw meter ────────────────────────────
          // Kills single-sample spikes from wind gusts, taps, AGC pump.
          // All subsequent logic operates on `m` — never raw meter.
          smoothedMeterRef.current =
            EMA_ALPHA * rawMeter + (1 - EMA_ALPHA) * smoothedMeterRef.current;
          const m = smoothedMeterRef.current;

          // ── STEP 2: UI audio level (0–1 normalised) ─────────────────────
          const clampedDb = Math.max(-60, m);
          setAudioLevel((clampedDb + 60) / 60);

          // ── STEP 3: Update all sample buffers ───────────────────────────
          rollingBufferRef.current.push(m);
          if (rollingBufferRef.current.length > ROLLING_BUFFER_SIZE) {
            rollingBufferRef.current.shift();
          }

          shortSamplesRef.current.push(m);
          if (shortSamplesRef.current.length > SHORT_VARIANCE_WINDOW) {
            shortSamplesRef.current.shift();
          }

          longSamplesRef.current.push(m);
          if (longSamplesRef.current.length > LONG_VARIANCE_WINDOW) {
            longSamplesRef.current.shift();
          }

          // ── STEP 4: CALIBRATION PHASE ────────────────────────────────────
          if (calibrationEndRef.current && now < calibrationEndRef.current) {
            calibrationSamplesRef.current.push(m);
            return; // skip all VAD during calibration
          } else if (calibrationEndRef.current) {
            // Calibration window just closed → compute initial threshold
            calibrationEndRef.current = null;
            setIsCalibrating(false);
            isCalibratedRef.current = true;

            if (calibrationSamplesRef.current.length > 5) {
              const longVar = computeVariance(calibrationSamplesRef.current);
              const ambient = computeAmbient(calibrationSamplesRef.current, longVar);
              ambientFloorRef.current = ambient;
              thresholdRef.current = applyThreshold(ambient);
              noiseTypeRef.current = classifyNoise(longVar, m - ambient);
              lastRecalRef.current = now;
              console.log(
                `[VAD] Calibrated. Ambient: ${ambient.toFixed(1)}dB | ` +
                `Threshold: ${thresholdRef.current.toFixed(1)}dB | ` +
                `Noise: ${noiseTypeRef.current} | LongVar: ${longVar.toFixed(1)}`
              );
            }
          }

          // ── STEP 5: BACKGROUND RECALIBRATION (every 15s, idle only) ─────
          // Catches room changes (user moves to café, window opens, AC turns on).
          // Only runs when no speech is in progress to avoid self-contamination.
          if (
            now - lastRecalRef.current > RECAL_INTERVAL_MS &&
            !hasSpokenRef.current &&
            rollingBufferRef.current.length >= 20
          ) {
            const longVar = computeVariance(longSamplesRef.current);
            const ambient = computeAmbient(rollingBufferRef.current, longVar);
            ambientFloorRef.current = ambient;
            thresholdRef.current = applyThreshold(ambient);
            noiseTypeRef.current = classifyNoise(longVar, m - ambient);
            lastRecalRef.current = now;
            console.log(
              `[VAD] Recalibrated. Ambient: ${ambient.toFixed(1)}dB | ` +
              `Threshold: ${thresholdRef.current.toFixed(1)}dB | ` +
              `Noise: ${noiseTypeRef.current}`
            );
          }

          // ── STEP 6: Compute signal features for this sample ─────────────
          const shortVar = computeVariance(shortSamplesRef.current);
          const longVar = computeVariance(longSamplesRef.current);
          const snr = m - ambientFloorRef.current; // SNR relative to measured ambient

          // Update noise classification dynamically every sample (cheap — no alloc)
          noiseTypeRef.current = classifyNoise(longVar, snr);
          const profile = VAD_PROFILES[noiseTypeRef.current];

          // ── STEP 7: GATE LOGIC ───────────────────────────────────────────
          // isLoud uses SNR (not absolute dB) so it adapts to the room level.
          // A whisper in a -60dB room at +10dB SNR is louder than most noise.
          let isLoud = snr > profile.deltaDb && snr > profile.minSnr;

          // If nearFieldOnly is active, enforce the absolute hard gate.
          if (nearFieldOnly && m < NEAR_FIELD_MIN_DB) {
            isLoud = false;
          }

          // Variance gate: speech has rapid amplitude modulation; flat noise doesn't.
          // Uses the profile's varianceMin so it scales to noisy environments.
          const hasSpeechVariance = shortVar > profile.varianceMin;

          // HVAC / fan rejection: long-window flat = constant machine noise
          const isConstantNoise = longVar < 2 && shortVar < 1.5;

          if (isLoud && (!hasSpeechVariance || isConstantNoise)) {
            // Loud but flat → constant background noise, not speech
            speechStartRef.current = null;
            continuousLoudStartRef.current = null;
            return;
          }

          // ── STEP 8: EMA ambient floor correction during confirmed silence ─
          // Corrects for Android AGC drift which slowly boosts the mic gain
          // in silence, causing the ambient floor to creep upward over time.
          if (!isLoud && !hasSpokenRef.current) {
            const EMA_AMBIENT_ALPHA = 0.03; // very slow drift correction
            ambientFloorRef.current =
              EMA_AMBIENT_ALPHA * m + (1 - EMA_AMBIENT_ALPHA) * ambientFloorRef.current;
          }

          // ── STEP 9: SPEECH / SILENCE DETECTION ──────────────────────────
          if (isLoud) {
            silenceStartRef.current = null;

            // ── RINGTONE / ALARM / MUSIC REJECTION ──────────────────────────
            // Human speech ALWAYS has dips between words and breaths (dipObservedRef).
            // Ringtones, alarms, TV, music stay continuously loud with NO dips.
            // We only reject after CONTINUOUS_SPEECH_LIMIT ms AND no dip observed.
            const continuousLimit =
              noiseTypeRef.current === 'turbulent' ? CONTINUOUS_SPEECH_LIMIT_TURBULENT_MS :
                noiseTypeRef.current === 'speech_like' ? CONTINUOUS_SPEECH_LIMIT_SPEECHLIKE_MS :
                  CONTINUOUS_SPEECH_LIMIT_DEFAULT_MS;

            if (!continuousLoudStartRef.current) {
              continuousLoudStartRef.current = now;
            } else if (
              hasSpokenRef.current &&
              !dipObservedRef.current &&
              now - continuousLoudStartRef.current > continuousLimit
            ) {
              console.log(
                `[VAD] Continuous loud >${continuousLimit}ms, no dip → rejecting as ` +
                `${noiseTypeRef.current === 'speech_like' ? 'nearby voice/TV' : 'ringtone/alarm'}`
              );
              hasSpokenRef.current = false;
              turnClaimedRef.current = false;
              continuousLoudStartRef.current = null;
              dipObservedRef.current = false;
              setIsSpeaking(false);
              return;
            }

            // ── SPEECH ONSET GATE ──────────────────────────────────────────
            if (!hasSpokenRef.current) {
              if (!speechStartRef.current) {
                speechStartRef.current = now;
              } else if (now - speechStartRef.current > profile.speechGate) {
                // Gate passed → confirmed speech onset
                hasSpokenRef.current = true;
                dipObservedRef.current = false; // reset dip tracker for this new turn
                setIsSpeaking(true);

                if (!turnClaimedRef.current) {
                  turnClaimedRef.current = true;
                  const confidence = Math.min(1, Math.max(0, snr / CONFIDENCE_DB_RANGE));
                  console.log(
                    `[VAD] Speech confirmed. dB=${m.toFixed(1)} | SNR=${snr.toFixed(1)}dB | ` +
                    `confidence=${confidence.toFixed(2)} | noise=${noiseTypeRef.current} | ` +
                    `shortVar=${shortVar.toFixed(1)} | longVar=${longVar.toFixed(1)}`
                  );
                  if (onSpeechRef.current) onSpeechRef.current(confidence);
                }
              }
            } else {
              setIsSpeaking(true);
            }

          } else {
            // ── SILENCE ────────────────────────────────────────────────────
            speechStartRef.current = null;
            continuousLoudStartRef.current = null;

            // Any dip below threshold marks this turn as "has had a dip" —
            // the key fingerprint distinguishing human speech from alarms/music.
            if (hasSpokenRef.current) {
              dipObservedRef.current = true;
            }

            setIsSpeaking(false);

            if (hasSpokenRef.current) {
              if (!silenceStartRef.current) {
                silenceStartRef.current = now;
              } else if (now - silenceStartRef.current > profile.silenceGate) {
                hasSpokenRef.current = false;
                turnClaimedRef.current = false;
                dipObservedRef.current = false;
                if (onSilenceRef.current) onSilenceRef.current();
              }
            }
          }
        },
        100 // metering interval ms
      );

      recordingStartTime.current = Date.now();
      recordingRef.current = recording;
      setIsRecording(true);

    } catch (err) {
      console.error('[useAudioRecorder] Failed to start recording:', err);
      cleanupRecording();
      throw err;
    } finally {
      isStartingRef.current = false;
    }
  };

  // ── Stop Recording ─────────────────────────────────────────────────────────
  const stopRecording = async (): Promise<{ base64: string; mimeType: string }> => {
    if (isStoppingRef.current) {
      throw new Error('Already stopping recording');
    }
    if (!recordingRef.current) {
      cleanupRecording();
      throw new Error('No active recording found');
    }

    // Reject audio captured during calibration — it's mostly noise
    if (isCalibrating) {
      console.warn('[useAudioRecorder] stopRecording called during calibration — returning empty audio');
      cleanupRecording();
      recordingRef.current = null;
      throw new Error('Recording stopped during calibration');
    }

    isStoppingRef.current = true;
    try {
      // Ensure at least 500ms of valid audio so the codec produces a valid file
      const elapsed = Date.now() - recordingStartTime.current;
      if (elapsed < 500) {
        await new Promise(resolve => setTimeout(resolve, 500 - elapsed));
      }

      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch (err) {
        console.warn('[useAudioRecorder] Error stopping recording natively:', err);
      }

      const uri = recordingRef.current.getURI();

      // Restore playback audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      if (!uri) {
        throw new Error('Recording stopped but no URI was available.');
      }

      setRecordingUri(uri);

      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const mimeType = uri.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm';

      return { base64, mimeType };
    } finally {
      recordingRef.current = null;
      cleanupRecording();
      isStoppingRef.current = false;
    }
  };

  // ── Unmount cleanup ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cleanupRecording();
      // Full calibration reset on unmount so the next SessionScreen mount
      // always starts with a fresh calibration (user may have changed rooms).
      isCalibratedRef.current = false;
      calibrationSamplesRef.current = [];
      rollingBufferRef.current = [];
      longSamplesRef.current = [];
      noiseTypeRef.current = 'quiet';
      if (recordingRef.current) {
        recordingRef.current
          .stopAndUnloadAsync()
          .catch(e => console.warn('[useAudioRecorder] Unmount cleanup warning:', e));
      }
    };
  }, [cleanupRecording]);

  return {
    isRecording,
    isCalibrating,
    isSpeaking,
    startRecording,
    stopRecording,
    audioLevel,
  };
}