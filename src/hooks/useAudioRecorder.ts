import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

interface AudioRecorderOptions {
  onSpeechDetected?: () => void;
  onSilenceDetected?: () => void;
}

export function useAudioRecorder({ onSpeechDetected, onSilenceDetected }: AudioRecorderOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  
  const recordingRef = useRef<Audio.Recording | null>(null);
  const isStartingRef = useRef<boolean>(false);
  const isStoppingRef = useRef<boolean>(false);
  const recordingStartTimeRef = useRef<number>(0);
  
  // VAD state
  const isCalibratedRef = useRef<boolean>(false);
  const calibrationSamplesRef = useRef<number[]>([]);
  const calibrationEndRef = useRef<number | null>(null);
  const thresholdRef = useRef<number>(-40);
  
  const speechStartRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const turnClaimedRef = useRef<boolean>(false);

  const onSpeechRef = useRef(onSpeechDetected);
  const onSilenceRef = useRef(onSilenceDetected);
  
  useEffect(() => {
    onSpeechRef.current = onSpeechDetected;
    onSilenceRef.current = onSilenceDetected;
  }, [onSpeechDetected, onSilenceDetected]);

  const cleanupRecording = useCallback(() => {
    setIsRecording(false);
    setIsCalibrating(false);
    setIsSpeaking(false);
    setAudioLevel(0);
    hasSpokenRef.current = false;
    turnClaimedRef.current = false;
    speechStartRef.current = null;
    silenceStartRef.current = null;
  }, []);

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

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      cleanupRecording();
      setRecordingUri(null);
      
      if (!isCalibratedRef.current) {
        setIsCalibrating(true);
        calibrationSamplesRef.current = [];
        calibrationEndRef.current = Date.now() + 1500; // 1.5 seconds calibration
        thresholdRef.current = -40; // Default
      } else {
        setIsCalibrating(false);
        calibrationEndRef.current = null;
      }
      
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
        (status) => {
          if (status.isRecording && status.metering !== undefined) {
            const meter = status.metering;
            const now = Date.now();
            
            // Map metering (-160 to 0) to level (0 to 1) for UI
            const minDb = -60;
            const clampedMeter = Math.max(minDb, meter);
            const level = (clampedMeter - minDb) / (-minDb);
            setAudioLevel(level);

            // ── CALIBRATION PHASE ──────────────────────────────────────
            if (calibrationEndRef.current && now < calibrationEndRef.current) {
              calibrationSamplesRef.current.push(meter);
              return;
            } else if (calibrationEndRef.current) {
              // Calibration just finished
              calibrationEndRef.current = null;
              setIsCalibrating(false);
              isCalibratedRef.current = true;
              
              if (calibrationSamplesRef.current.length > 5) {
                // Calculate 85th percentile
                const sorted = [...calibrationSamplesRef.current].sort((a, b) => a - b);
                const p85Index = Math.floor(sorted.length * 0.85);
                const ambientFloor = sorted[p85Index];
                
                // Threshold is ambient + 15dB, clamped between -55 and -10
                let newThreshold = ambientFloor + 15;
                newThreshold = Math.max(-55, Math.min(-10, newThreshold));
                thresholdRef.current = newThreshold;
                console.log(`[VAD] Calibration done. Ambient: ${ambientFloor.toFixed(1)}dB, Threshold: ${newThreshold.toFixed(1)}dB`);
              }
            }

            // ── VAD LOGIC ──────────────────────────────────────────────
            const isLoud = meter > thresholdRef.current;
            
            if (isLoud) {
              silenceStartRef.current = null;
              
              if (!hasSpokenRef.current) {
                if (!speechStartRef.current) {
                  speechStartRef.current = now;
                } else if (now - speechStartRef.current > 350) { // 350ms speech gate
                  hasSpokenRef.current = true;
                  setIsSpeaking(true);
                  if (!turnClaimedRef.current) {
                    turnClaimedRef.current = true;
                    if (onSpeechRef.current) onSpeechRef.current();
                  }
                }
              } else {
                setIsSpeaking(true);
              }
            } else {
              speechStartRef.current = null;
              setIsSpeaking(false);
              
              if (hasSpokenRef.current) {
                if (!silenceStartRef.current) {
                  silenceStartRef.current = now;
                } else if (now - silenceStartRef.current > 1000) { // 1000ms silence trigger
                  // Trigger silence detected once
                  hasSpokenRef.current = false; // Reset to avoid multiple triggers
                  if (onSilenceRef.current) onSilenceRef.current();
                }
              }
            }
          }
        },
        100 // update interval ms
      );

      recordingStartTimeRef.current = Date.now();
      recordingRef.current = recording;
      setIsRecording(true);
      
    } catch (err) {
      console.error('Failed to start recording', err);
      cleanupRecording();
      throw err;
    } finally {
      isStartingRef.current = false;
    }
  };

  const stopRecording = async (): Promise<{ base64: string; mimeType: string }> => {
    if (isStoppingRef.current) {
      throw new Error("Already stopping recording");
    }
    if (!recordingRef.current) {
        cleanupRecording();
        throw new Error("No active recording found");
    }
    
    isStoppingRef.current = true;
    try {
      const now = Date.now();
      const elapsed = now - recordingStartTimeRef.current;
      if (elapsed < 500) {
        await new Promise(resolve => setTimeout(resolve, 500 - elapsed));
      }

      try {
          await recordingRef.current.stopAndUnloadAsync();
      } catch (err) {
          console.warn("Error stopping recording natively:", err);
      }
      
      const uri = recordingRef.current.getURI();
      
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
      
      if (!uri) {
        throw new Error('Recording stopped but no URI was available. Audio might not have started correctly.');
      }
      
      setRecordingUri(uri);
      
      const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: 'base64',
      });
      
      const mimeType = uri.endsWith('.m4a') ? 'audio/mp4' : 'audio/webm';
      
      return { base64, mimeType };
    } finally {
      recordingRef.current = null;
      cleanupRecording();
      isStoppingRef.current = false;
    }
  };

  useEffect(() => {
    return () => {
      cleanupRecording();
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(e => console.error("Unmount cleanup warning:", e));
      }
    };
  }, [cleanupRecording]);

  return { isRecording, isCalibrating, isSpeaking, startRecording, stopRecording, audioLevel };
}
