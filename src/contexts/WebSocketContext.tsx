import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { websocketService } from '../services/websocketService';
import { WS_URL } from '../config';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface TranslatedAudioPayload {
  audioBase64: string;
  mimeType: string;
  originalText: string;
  translatedText: string;
}

interface WebSocketContextType {
  status: ConnectionStatus;
  sessionId: string | null;
  partnerLang: string | null;
  isProcessing: boolean;
  createSession: (lang: string) => Promise<void>;
  joinSession: (sid: string, lang: string) => Promise<void>;
  sendAudioChunk: (
    audioBase64: string,
    mimeType: string,
    inputLang: string,
    outputLang: string,
    role: string,
    sid: string
  ) => void;
  claimTurn: (role: string, sid: string) => void;
  releaseTurn: (role: string, sid: string) => void;
  endSession: (role: string, sid: string) => void;
  // Internal registration for hooks
  registerCallbacks: (id: string, callbacks: WebSocketCallbacks) => void;
  unregisterCallbacks: (id: string) => void;
}

interface WebSocketCallbacks {
  onTranslatedAudio?: (payload: TranslatedAudioPayload) => void;
  onTranscript?: (originalText: string, translatedText: string) => void;
  onPartnerDisconnected?: () => void;
  onError?: (message: string) => void;
  onPartnerSpeaking?: () => void;
  onTurnRejected?: () => void;
  onSessionReadyEvent?: (partnerLang: string) => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [partnerLang, setPartnerLang] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Map of registered callbacks from various screens/components
  const callbacksMap = useRef<Map<string, WebSocketCallbacks>>(new Map());

  const registerCallbacks = useCallback((id: string, callbacks: WebSocketCallbacks) => {
    callbacksMap.current.set(id, callbacks);
  }, []);

  const unregisterCallbacks = useCallback((id: string) => {
    callbacksMap.current.delete(id);
  }, []);

  const handleMessage = useCallback((message: Record<string, any>) => {
    const { type } = message;

    if (type === 'session_created') {
      setSessionId(message.sessionId);
      setStatus('waiting');
    }

    if (type === 'session_ready') {
      setStatus('connected');
      if (message.partnerLang) {
        setPartnerLang(message.partnerLang);
        callbacksMap.current.forEach(c => c.onSessionReadyEvent?.(message.partnerLang));
      }
    }

    if (type === 'processing_started') {
      setIsProcessing(true);
    }

    if (type === 'processing_done') {
      setIsProcessing(false);
    }

    // Distribute messages to all registered listeners
    callbacksMap.current.forEach((callbacks) => {
      if (type === 'translated_audio') {
        callbacks.onTranslatedAudio?.({
          audioBase64: message.audioBase64,
          mimeType: message.mimeType,
          originalText: message.originalText,
          translatedText: message.translatedText,
        });
      }

      if (type === 'transcript') {
        callbacks.onTranscript?.(message.originalText, message.translatedText);
      }

      if (type === 'partner_disconnected') {
        setStatus('disconnected');
        callbacks.onPartnerDisconnected?.();
      }

      if (type === 'partner_speaking') {
        callbacks.onPartnerSpeaking?.();
      }

      if (type === 'turn_rejected') {
        callbacks.onTurnRejected?.();
      }

      if (type === 'error') {
        setIsProcessing(false);
        callbacks.onError?.(message.message);
      }
    });
  }, []);

  const createSession = useCallback(async (lang: string) => {
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => {
        setStatus('error');
      });
      await websocketService.connect(WS_URL);
      websocketService.send({ type: 'create_session', lang });
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const joinSession = useCallback(async (sid: string, lang: string) => {
    setStatus('connecting');
    try {
      websocketService.onMessage(handleMessage);
      websocketService.onClose(() => {
        setStatus('disconnected');
        setIsProcessing(false);
      });
      websocketService.onError(() => {
        setStatus('error');
      });
      await websocketService.connect(WS_URL);
      websocketService.send({ type: 'join_session', sessionId: sid, lang });
      setSessionId(sid);
    } catch (e) {
      setStatus('error');
      callbacksMap.current.forEach(c => c.onError?.('Failed to connect to server.'));
    }
  }, [handleMessage]);

  const sendAudioChunk = useCallback(
    (
      audioBase64: string,
      mimeType: string,
      inputLang: string,
      outputLang: string,
      role: string,
      sid: string
    ) => {
      setIsProcessing(true);
      websocketService.send({
        type: 'audio_chunk',
        sessionId: sid,
        role,
        audioBase64,
        mimeType,
        inputLang,
        outputLang,
      });
    },
    []
  );

  const claimTurn = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'claim_turn', sessionId: sid, role });
  }, []);

  const releaseTurn = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'release_turn', sessionId: sid, role });
  }, []);

  const endSession = useCallback((role: string, sid: string) => {
    websocketService.send({ type: 'end_session', sessionId: sid, role });
    websocketService.disconnect();
    setStatus('idle');
    setSessionId(null);
    setPartnerLang(null);
    setIsProcessing(false);
  }, []);

  // Cleanup on provider unmount (rare, usually app close)
  useEffect(() => {
    return () => {
      websocketService.disconnect();
    };
  }, []);

  return (
    <WebSocketContext.Provider
      value={{
        status,
        sessionId,
        partnerLang,
        isProcessing,
        createSession,
        joinSession,
        sendAudioChunk,
        claimTurn,
        releaseTurn,
        endSession,
        registerCallbacks,
        unregisterCallbacks,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocketContext = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
};
