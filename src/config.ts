// Central config — update WS_URL to your machine's local IP when testing on real devices
export const WS_URL = 'ws://192.168.1.11:8080';

// Example for real device: export const WS_URL = 'ws://192.168.1.100:8080';

export const LANGUAGES = [
  { code: 'en-US', name: 'English' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'zh-CN', name: 'Mandarin' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
  { code: 'ar-SA', name: 'Arabic' },
] as const;

export type LanguageCode = typeof LANGUAGES[number]['code'];
export type LanguageName = typeof LANGUAGES[number]['name'];
