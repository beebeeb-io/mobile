# Graph Report - mobile  (2026-05-01)

## Corpus Check
- 10 files · ~10,190 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 60 nodes · 73 edges · 6 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]

## God Nodes (most connected - your core abstractions)
1. `request()` - 12 edges
2. `getToken()` - 5 edges
3. `handleSignup()` - 4 edges
4. `handleLogin()` - 3 edges
5. `setToken()` - 3 edges
6. `clearToken()` - 3 edges
7. `friendlyError()` - 3 edges
8. `headers()` - 3 edges
9. `signup()` - 3 edges
10. `login()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `handleSignup()` --calls--> `signup()`  [INFERRED]
  screens/SignupScreen.tsx → lib/api.ts
- `handleSignup()` --calls--> `friendlyError()`  [INFERRED]
  screens/SignupScreen.tsx → lib/api.ts
- `handleLogin()` --calls--> `login()`  [INFERRED]
  screens/LoginScreen.tsx → lib/api.ts
- `handleLogin()` --calls--> `friendlyError()`  [INFERRED]
  screens/LoginScreen.tsx → lib/api.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.28
Nodes (7): friendlyError(), login(), setToken(), signup(), handleLogin(), handleSignup(), validate()

### Community 1 - "Community 1"
Cohesion: 0.25
Nodes (8): createShare(), deleteFile(), getFile(), getMe(), getRegion(), getStorageUsage(), listMyShares(), request()

### Community 4 - "Community 4"
Cohesion: 0.33
Nodes (1): restoreFile()

### Community 6 - "Community 6"
Cohesion: 0.4
Nodes (5): downloadFile(), getToken(), hasToken(), headers(), uploadFile()

### Community 10 - "Community 10"
Cohesion: 1.0
Nodes (1): ApiError

### Community 11 - "Community 11"
Cohesion: 1.0
Nodes (2): clearToken(), logout()

## Knowledge Gaps
- **Thin community `Community 4`** (6 nodes): `getIncomingInvites()`, `getSentInvites()`, `listFiles()`, `registerSessionExpiredHandler()`, `restoreFile()`, `api.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 10`** (2 nodes): `ApiError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 11`** (2 nodes): `clearToken()`, `logout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `friendlyError()` connect `Community 0` to `Community 4`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `signup()` connect `Community 0` to `Community 4`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `handleSignup()` (e.g. with `signup()` and `friendlyError()`) actually correct?**
  _`handleSignup()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `handleLogin()` (e.g. with `login()` and `friendlyError()`) actually correct?**
  _`handleLogin()` has 2 INFERRED edges - model-reasoned connections that need verification._