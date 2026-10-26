// @ts-expect-error -- Bun test declarations are not installed in the native app.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { allowPreviewNavigation, isolatePreviewHtml, staticPreviewWebViewProps } from './preview-html-policy';

test('installs deny-by-default resource policy before attacker-controlled markup', () => {
  const hostile = '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid"><script>fetch("https://example.invalid")</script></head><body><img src="https://example.invalid/pixel"></body></html>';
  const html = isolatePreviewHtml(hostile);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  expect(csp).not.toBeNull();
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('refresh'));
  for (const rule of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "img-src data: blob:", "style-src 'unsafe-inline'"]) expect(csp![1]).toContain(rule);
  expect(csp![1]).not.toMatch(/https?:|\*/);
  expect(html).toContain(hostile);
});

test('disables scripting, shared cookies, disk cache, storage and file access', () => {
  for (const prop of ['javaScriptEnabled', 'domStorageEnabled', 'sharedCookiesEnabled', 'thirdPartyCookiesEnabled', 'cacheEnabled', 'allowFileAccess', 'allowFileAccessFromFileURLs', 'allowUniversalAccessFromFileURLs', 'setSupportMultipleWindows'] as const) expect(staticPreviewWebViewProps[prop]).toBe(false);
  expect(staticPreviewWebViewProps.incognito).toBe(true);
  expect(staticPreviewWebViewProps.mixedContentMode).toBe('never');
  // All origins reach our veto callback; the WebView whitelist must not open
  // disallowed links in the OS browser instead.
  expect(staticPreviewWebViewProps.originWhitelist).toEqual(['*']);
  expect(staticPreviewWebViewProps.onShouldStartLoadWithRequest).toBe(allowPreviewNavigation);
  expect(typeof staticPreviewWebViewProps.onOpenWindow).toBe('function');
});

test('allows the generated document only and vetoes remote, local and OS-scheme navigations', () => {
  for (const url of ['about:blank', 'about:srcdoc']) expect(allowPreviewNavigation({ url })).toBe(true);
  for (const url of ['https://example.invalid/', 'http://127.0.0.1/', 'file:///private/data', 'data:text/html,x', 'beebeeb://upload', 'mailto:x@example.invalid', 'about:blank#https://example.invalid']) expect(allowPreviewNavigation({ url })).toBe(false);
});

test('all three decrypted document preview WebViews use the shared policy', () => {
  const files = ['screens/PreviewScreen.tsx', 'components/preview/DocxRenderer.tsx'];
  let views = 0;
  for (const file of files) {
    const source = readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8');
    for (const match of source.matchAll(/<WebView\s([\s\S]*?)\/>/g)) {
      views++;
      expect(match[1]).toContain('{...staticPreviewWebViewProps}');
      expect(match[1]).toMatch(/source=\{\{ html: isolatePreviewHtml\(/);
    }
  }
  expect(views).toBe(3);
});
