import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, SignedIn, SignedOut, useUser } from '@clerk/clerk-expo';
import { tokenCache } from './src/utils/tokenCache';
import { HomeScreen } from './src/screens/HomeScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { WebSocketProvider } from './src/contexts/WebSocketContext';
import * as WebBrowser from 'expo-web-browser';
import { SafeAreaProvider } from 'react-native-safe-area-context';

WebBrowser.maybeCompleteAuthSession();


type AppScreen = 'onboarding' | 'home' | 'session' | 'profile';

interface SessionParams {
  sessionId: string;
  role: 'host' | 'guest';
  myLang: string;
  partnerLang: string;
}

const publishableKey = 'pk_test_cHJvcGVyLWphZ3Vhci04NS5jbGVyay5hY2NvdW50cy5kZXYk';

if (!publishableKey) {
  throw new Error('Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY in .env');
}

function MainApp() {
  const { user, isLoaded } = useUser();

  // Determine initial screen: gate on onboarding completion
  const isOnboarded = !!(user?.publicMetadata as any)?.onboardingComplete;
  const [screen, setScreen] = useState<AppScreen>(isOnboarded ? 'home' : 'onboarding');
  const [sessionParams, setSessionParams] = useState<SessionParams | null>(null);

  // If Clerk is still loading the user, render nothing to avoid flicker
  if (!isLoaded) return null;

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
      {screen === 'onboarding' && (
        <OnboardingScreen onComplete={() => setScreen('home')} />
      )}
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
