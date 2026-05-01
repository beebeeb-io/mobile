# Graph Report - mobile  (2026-05-01)

## Corpus Check
- 18 files · ~17,550 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 90 nodes · 98 edges · 7 communities detected
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]

## God Nodes (most connected - your core abstractions)
1. `request()` - 14 edges
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
Cohesion: 0.2
Nodes (10): createFolder(), createShare(), deleteFile(), getFile(), getMe(), getRegion(), getStorageUsage(), request() (+2 more)

### Community 1 - "Community 1"
Cohesion: 0.28
Nodes (7): friendlyError(), login(), setToken(), signup(), handleLogin(), handleSignup(), validate()

### Community 2 - "Community 2"
Cohesion: 0.22
Nodes (1): listMyShares()

### Community 6 - "Community 6"
Cohesion: 0.4
Nodes (2): formatSize(), renderItem()

### Community 8 - "Community 8"
Cohesion: 0.4
Nodes (5): downloadFile(), getToken(), hasToken(), headers(), uploadFile()

### Community 15 - "Community 15"
Cohesion: 1.0
Nodes (1): ApiError

### Community 16 - "Community 16"
Cohesion: 1.0
Nodes (2): clearToken(), logout()

## Knowledge Gaps
- **Thin community `Community 2`** (9 nodes): `getDownloadUrl()`, `getIncomingInvites()`, `getPreference()`, `getSentInvites()`, `getSubscription()`, `listFiles()`, `listMyShares()`, `registerSessionExpiredHandler()`, `api.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 6`** (6 nodes): `displayName()`, `formatDate()`, `formatSize()`, `renderEmpty()`, `renderItem()`, `TrashScreen.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 15`** (2 nodes): `ApiError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 16`** (2 nodes): `clearToken()`, `logout()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `friendlyError()` connect `Community 1` to `Community 2`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `signup()` connect `Community 1` to `Community 2`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `handleSignup()` (e.g. with `signup()` and `friendlyError()`) actually correct?**
  _`handleSignup()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `handleLogin()` (e.g. with `login()` and `friendlyError()`) actually correct?**
  _`handleLogin()` has 2 INFERRED edges - model-reasoned connections that need verification._