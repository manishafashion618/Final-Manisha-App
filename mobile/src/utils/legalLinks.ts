import { Linking } from 'react-native';
import { API_BASE_URL } from '../api/client';

/**
 * The privacy policy and terms are served by the backend beside the API, but
 * outside its `/api/vN` prefix — so their address follows whichever server
 * this build talks to, with nothing extra to configure.
 */
export function siteUrlFrom(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
}

const SITE_URL = siteUrlFrom(API_BASE_URL);

export const LEGAL_URLS = {
  privacy: `${SITE_URL}/privacy-policy`,
  terms: `${SITE_URL}/terms`,
} as const;

/** Opens the page in the browser. A failure to open is not worth an error. */
export function openLegalPage(page: keyof typeof LEGAL_URLS): void {
  Linking.openURL(LEGAL_URLS[page]).catch(() => undefined);
}
