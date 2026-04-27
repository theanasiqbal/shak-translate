import { useState, useRef, useEffect, useCallback } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

export function useAudioRecorder(onSilenceDetected?: () => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  
  const recordingRef = useRef<Audio.Recording | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  
  const onSilenceDetectedRef = useRef(onSilenceDetected);
  useEffect(() => {
    onSilenceDetectedRef.current = onSilenceDetected;
  }, [onSilenceDetected]);

  // Helper to cleanup and reset UI state immediately
  const cleanupRecording = useCallback(() => {
    setIsRecording(false);
    setAudioLevel(0);
    silenceStartRef.current = null;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const startRecording = async () => {
    try {
      // 1. Request permissions first
      const permissionResponse = await Audio.requestPermissionsAsync();
      if (permissionResponse.status !== 'granted') {
        throw new Error('Microphone permission denied');
      }

      // 2. Prepare iOS/Android audio modes
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // 3. Start Recording Session
      setRecordingUri(null);
      silenceStartRef.current = null;
      
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
        (status) => {
          if (status.isRecording && status.metering !== undefined) {
            // map metering (-160 to 0 dB) to roughly (0 to 1)
            const minDb = -60;
            const meter = Math.max(minDb, status.metering);
            const level = (meter - minDb) / (-minDb);
            setAudioLevel(level);

            // Silence detection
            if (status.metering < -40) {
              if (!silenceStartRef.current) {
                silenceStartRef.current = Date.now();
              } else if (Date.now() - silenceStartRef.current > 2000) {
                if (onSilenceDetectedRef.current) {
                  onSilenceDetectedRef.current();
                }
                silenceStartRef.current = null; // Prevent triggering multiple times
              }
            } else {
              silenceStartRef.current = null;
            }
          }
        },
        100 // update interval ms
      );

      recordingRef.current = recording;
      setIsRecording(true);
      
    } catch (err) {
      console.error('Failed to start recording', err);
      cleanupRecording();
      throw err;
    }
  };

  const stopRecording = async (): Promise<{ base64: string; mimeType: string }> => {
    if (!recordingRef.current) {
        cleanupRecording();
        throw new Error("No active recording found");
    }
    
    // Stop and unload the recording immediately to free the audio device
    try {
        await recordingRef.current.stopAndUnloadAsync();
    } catch (err) {
        console.warn("Error stopping recording natively:", err);
    }
    
    // Reset immediately for UI responsiveness
    const uri = recordingRef.current.getURI();
    
    recordingRef.current = null;
    cleanupRecording();
    
    // Allow React Native background AV session to reset for playback
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
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRecording();
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(e => console.error("Unmount cleanup warning:", e));
      }
    };
  }, [cleanupRecording]);

  return { isRecording, startRecording, stopRecording, audioLevel };
}
