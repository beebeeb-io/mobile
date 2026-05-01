# Graph Report - mobile  (2026-05-01)

## Corpus Check
- 10 files · ~9,801 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 63 nodes · 76 edges · 6 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]

## God Nodes (most connected - your core abstractions)
1. `request()` - 12 edges
2. `getToken()` - 5 edges
3. `handleSignup()` - 4 edges
4. `setToken()` - 3 edges
5. `clearToken()` - 3 edges
6. `friendlyError()` - 3 edges
7. `headers()` - 3 edges
8. `signup()` - 3 edges
9. `login()` - 3 edges
10. `logout()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `handleSignup()` --calls--> `friendlyError()`  [INFERRED]
  screens/SignupScreen.tsx → lib/api.ts
- `handleLogin()` --calls--> `friendlyError()`  [INFERRED]
  screens/LoginScreen.tsx → lib/api.ts
- `handleSignup()` --calls--> `signup()`  [INFERRED]
  screens/SignupScreen.tsx → lib/api.ts
- `handleLogin()` --calls--> `login()`  [INFERRED]
  screens/LoginScreen.tsx → lib/api.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.28
Nodes (7): friendlyError(), login(), setToken(), signup(), handleLogin(), handleSignup(), validate()

### Community 1 - "Community 1"
Cohesion: 0.25
Nodes (8): createShare(), deleteFile(), getFile(), getMe(), getStorageUsage(), listMyShares(), request(), restoreFile()

### Community 3 - "Community 3"
Cohesion: 0.33
Nodes (1): getRegion()

### Community 6 - "Community 6"
Cohesion: 0.4
Nodes (5): downloadFile(), getToken(), hasToken(), headers(), uploadFile()

### Community 10 - "Community 10"
Cohesion: 1.0
Nodes (2): clearToken(), logout()

### Community 11 - "Community 11"
Cohesion: 1.0
Nodes (1): ApiError

## Knowledge Gaps
- **Thin community `Community 3`** (6 nodes): `getIncomingInvites()`, `getRegion()`, `getSentInvites()`, `listFiles()`, `registerSessionExpiredHandler()`, `api.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 10`** (2 nodes): `clearToken()`, `logout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 11`** (2 nodes): `ApiError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `friendlyError()` connect `Community 0` to `Community 3`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `signup()` connect `Community 0` to `Community 3`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `handleSignup()` (e.g. with `signup()` and `friendlyError()`) actually correct?**
  _`handleSignup()` has 2 INFERRED edges - model-reasoned connections that need verification._