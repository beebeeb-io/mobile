/**
 * Which API a build talks to, as a label for QA and the diagnostic line
 * `[Beebeeb] API environment: Local (...)` (task 1394, task 1746). Pure.
 *
 * Any loopback host on any port is `local`: lanes run their own API on their own
 * port (a shared :3001 is exactly what several lanes must not share), and a lane
 * must be able to see "Local" in Metro to prove the app is NOT pointed at production.
 */

export type ApiEnvironmentKind = 'local' | 'production' | 'custom';

export interface ApiEnvironment {
  kind: ApiEnvironmentKind;
  label: string;
  baseUrl: string;
}

const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2):\d{2,5}$/;

export function describeApiEnvironment(baseUrl: string): ApiEnvironment {
  if (LOCAL_RE.test(baseUrl)) {
    return { kind: 'local', label: 'Local', baseUrl };
  }
  if (baseUrl === 'https://api.beebeeb.io') {
    return { kind: 'production', label: 'Production', baseUrl };
  }
  return { kind: 'custom', label: 'Custom', baseUrl };
}
