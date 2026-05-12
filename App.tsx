import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-expo';
import { tokenCache } from './src/utils/tokenCache';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { WebSocketProvider } from './src/contexts/WebSocketContext';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaProvider } from 'react-native-safe-area-context';

WebBrowser.maybeCompleteAuthSession();


type AppScreen = 'home' | 'session' | 'profile';

interface SessionParams {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
}

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

if (!publishableKey) {
  throw new Error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY in .env');
}

function MainApp() {
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
      {screen === 'home' && (
        <HomeScreen 
          onSessionReady={handleSessionReady} 
          onOpenProfile={() => setScreen('profile')}
        />
      )}
      {screen === 'profile' && (
        <ProfileScreen onBack={() => setScreen('home')} />
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

export default function App() {
  return (
    <SafeAreaProvider>
      <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
        <StatusBar style="light" />
        <SignedIn>
          <MainApp />
        </SignedIn>
        <SignedOut>
          <AuthScreen />
        </SignedOut>
      </ClerkProvider>
    </SafeAreaProvider>
  );
}
