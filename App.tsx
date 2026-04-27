import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { WebSocketProvider } from './src/contexts/WebSocketContext';

type AppScreen = 'home' | 'session';

interface SessionParams {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [sessionParams, setSessionParams] = useState<SessionParams | null>(null);

  const handleSessionReady = (params: SessionParams) => {
    setSessionParams(params);
    setScreen('session');
  };

  const handleEndSession = () => {
    setSessionParams(null);
    setScreen('home');
  };

  return (
    <WebSocketProvider>
      <StatusBar style="light" />
      {screen === 'home' && (
        <HomeScreen onSessionReady={handleSessionReady} />
      )}
      {screen === 'session' && sessionParams && (
        <SessionScreen
          sessionId={sessionParams.sessionId}
          role={sessionParams.role}
          myLang={sessionParams.myLang}
          partnerLang={sessionParams.partnerLang}
          onEnd={handleEndSession}
        />
      )}
    </WebSocketProvider>
  );
}
