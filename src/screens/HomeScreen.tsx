import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Modal,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { LanguageSelector } from '../components/LanguageSelector';
import { QRCodeDisplay } from '../components/QRCodeDisplay';
import { QRScanner } from '../components/QRScanner';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { useRef } from 'react';

interface HomeScreenProps {
  onSessionReady: (params: {
    sessionId: string;
    role: 'host' | 'guest';
    myLang: string;
    partnerLang: string;
  }) => void;
}

export function HomeScreen({ onSessionReady }: HomeScreenProps) {
  const [myLang, setMyLang] = useState('English');
  const [showQR, setShowQR] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const roleRef = useRef<'host' | 'guest' | null>(null);

  const { status, sessionId, partnerLang, createSession, joinSession } = useWebSocket({
    onError: (msg) => setErrorMsg(msg),
    onTranslatedAudio: () => {}, // not used here
    onPartnerDisconnected: () => {},
  });

  // Called when session is ready and partner language is received
  React.useEffect(() => {
    if (status === 'connected' && sessionId && partnerLang && roleRef.current) {
      onSessionReady({ sessionId, role: roleRef.current, myLang, partnerLang });
    }
  }, [status, sessionId, partnerLang]);

  const handleStartSession = async () => {
    setErrorMsg(null);
    roleRef.current = 'host';
    await createSession(myLang);
    setShowQR(true);
  };

  const handleScanned = async (scannedId: string) => {
    setShowScanner(false);
    roleRef.current = 'guest';
    await joinSession(scannedId, myLang);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Background accents */}
      <View style={styles.topGlow} />
      <View style={styles.bottomGlow} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.logoIcon}>
            <Feather name="globe" size={20} color="#000" />
          </View>
          <Text style={styles.title}>
            Shak<Text style={styles.titleGreen}>Translate</Text>
          </Text>
        </View>

        <Text style={styles.subtitle}>Real-time two-way conversation translation</Text>

        {/* Error */}
        {errorMsg && (
          <View style={styles.errorBox}>
            <Feather name="alert-circle" size={14} color="#ef4444" />
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        {/* Language Config */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>MY LANGUAGE</Text>
          <LanguageSelector label="" selected={myLang} onSelect={setMyLang} />
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          {/* Start Session */}
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleStartSession}
            disabled={status === 'connecting' || status === 'waiting'}
            activeOpacity={0.8}
          >
            {status === 'connecting' ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <Feather name="plus-circle" size={20} color="#000" />
            )}
            <Text style={styles.primaryBtnText}>
              {status === 'connecting' ? 'Connecting...' : 'Start Session'}
            </Text>
          </TouchableOpacity>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>OR</Text>
            <View style={styles.orLine} />
          </View>

          {/* Join Session */}
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => setShowScanner(true)}
            activeOpacity={0.8}
          >
            <Feather name="camera" size={20} color="#39FF14" />
            <Text style={styles.secondaryBtnText}>Join Session (Scan QR)</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          Both users must be on the same Wi-Fi or the server must be publicly accessible.
        </Text>
      </ScrollView>

      {/* QR Code Modal (Host) */}
      <Modal visible={showQR} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Share this QR Code</Text>
            <Text style={styles.modalSubtitle}>Ask your partner to scan this</Text>

            {sessionId ? (
              <QRCodeDisplay sessionId={sessionId} />
            ) : (
              <ActivityIndicator color="#39FF14" size="large" style={{ marginVertical: 40 }} />
            )}

            <StatusBadge status={status} role="host" />

            {status === 'connected' && (
              <Text style={styles.connectedMsg}>Partner connected! Starting session…</Text>
            )}

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => {
                setShowQR(false);
              }}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* QR Scanner Modal (Guest) */}
      <Modal visible={showScanner} animationType="slide">
        <QRScanner
          onScanned={handleScanned}
          onCancel={() => setShowScanner(false)}
        />
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  scroll: { padding: 24, paddingBottom: 48 },
  topGlow: {
    position: 'absolute', top: -80, right: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  bottomGlow: {
    position: 'absolute', bottom: -80, left: -80,
    width: 260, height: 260, borderRadius: 130,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 8,
    paddingTop: Platform.OS === 'android' ? 20 : 8,
  },
  logoIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center', marginRight: 10,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  titleGreen: { color: '#39FF14' },
  subtitle: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 13, marginBottom: 28,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)',
    borderRadius: 12, padding: 12, marginBottom: 16,
  },
  errorText: { color: '#ef4444', fontSize: 13, flex: 1 },
  card: {
    backgroundColor: '#111',
    borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    padding: 20,
    marginBottom: 28,
  },
  cardTitle: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    letterSpacing: 2, marginBottom: 18,
  },
  divider: {
    height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 16,
  },
  actions: { gap: 12 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#39FF14', borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    shadowColor: '#39FF14', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
  },
  primaryBtnText: { color: '#000', fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.07)' },
  orText: { color: 'rgba(255,255,255,0.25)', fontSize: 12 },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: 'rgba(57,255,20,0.08)',
    borderWidth: 1, borderColor: 'rgba(57,255,20,0.3)',
    borderRadius: 16, paddingVertical: 18, paddingHorizontal: 24,
  },
  secondaryBtnText: { color: '#39FF14', fontSize: 16, fontWeight: '700' },
  footer: {
    color: 'rgba(255,255,255,0.2)', fontSize: 11,
    textAlign: 'center', marginTop: 28, lineHeight: 17,
  },
  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#111',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    padding: 28, alignItems: 'center', paddingBottom: 48,
  },
  modalTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginBottom: 20 },
  connectedMsg: {
    color: '#39FF14', fontSize: 13, fontWeight: '600',
    marginTop: 16, textAlign: 'center',
  },
  cancelBtn: {
    marginTop: 24,
    paddingHorizontal: 32, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  cancelBtnText: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },
});
