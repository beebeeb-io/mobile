import type { WebViewProps } from 'react-native-webview';

// Put the policy before any user markup: adding it after an existing <head>
// could already have loaded a tracking image or executed document script.
const PREVIEW_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

export function isolatePreviewHtml(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"></head><body>${html}</body></html>`;
}

export function allowPreviewNavigation(request: { url: string }): boolean {
  return request.url === 'about:blank' || request.url === 'about:srcdoc';
}

export const staticPreviewWebViewProps: WebViewProps = {
  // Keep navigation in the veto callback rather than opening disallowed
  // origins in the system browser (originWhitelist's default behaviour).
  originWhitelist: ['*'],
  onShouldStartLoadWithRequest: allowPreviewNavigation,
  onOpenWindow: () => {},
  javaScriptEnabled: false,
  domStorageEnabled: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  cacheEnabled: false,
  incognito: true,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  mixedContentMode: 'never',
  setSupportMultipleWindows: false,
};
