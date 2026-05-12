import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
export interface TokenCache {
  getToken: (key: string) => Promise<string | undefined | null>;
  saveToken: (key: string, token: string) => Promise<void>;
  clearToken?: (key: string) => Promise<void>;
}


const createTokenCache = (): TokenCache => {
  return {
    async getToken(key: string) {
      try {
        const item = await SecureStore.getItemAsync(key);
        if (item) {
          console.log(`${key} was used 🔐 \n`);
        } else {
          console.log('No values stored under key: ' + key);
        }
        return item;
      } catch (error) {
        console.error('SecureStore get item error: ', error);
        await SecureStore.deleteItemAsync(key);
        return null;
      }
    },
    async saveToken(key: string, value: string) {
      try {
        return SecureStore.setItemAsync(key, value);
      } catch (err) {
        console.error('SecureStore set item error: ', err);
        return;
      }
    },
    async clearToken(key: string) {
      try {
        return SecureStore.deleteItemAsync(key);
      } catch (err) {
        console.error('SecureStore delete item error: ', err);
        return;
      }
    }
  };
};

export const tokenCache = Platform.OS !== 'web' ? createTokenCache() : undefined;
