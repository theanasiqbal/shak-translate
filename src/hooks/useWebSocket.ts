import { useEffect, useId } from 'react';
import { useWebSocketContext, TranslatedAudioPayload } from '../contexts/WebSocketContext';

export { ConnectionStatus, TranslatedAudioPayload } from '../contexts/WebSocketContext';

interface UseWebSocketOptions {
  onTranslatedAudio?: (payload: TranslatedAudioPayload) => void;
  onTranscript?: (originalText: string, translatedText: string) => void;
  onPartnerDisconnected?: () => void;
  onError?: (message: string) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const context = useWebSocketContext();
  const hookId = useId(); // Unique ID for this hook instance

  // Register callbacks with the provider whenever options change
  useEffect(() => {
    context.registerCallbacks(hookId, options);
    return () => {
      context.unregisterCallbacks(hookId);
    };
  }, [hookId, options, context]);

  return {
    status: context.status,
    sessionId: context.sessionId,
    isProcessing: context.isProcessing,
    createSession: context.createSession,
    joinSession: context.joinSession,
    sendAudioChunk: context.sendAudioChunk,
    endSession: context.endSession,
  };
}
