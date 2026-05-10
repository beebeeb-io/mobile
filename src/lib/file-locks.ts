import * as SecureStore from 'expo-secure-store'

const LOCKED_FILES_KEY = 'beebeeb.locked_files'

async function getLockedFileIds(): Promise<Set<string>> {
  const raw = await SecureStore.getItemAsync(LOCKED_FILES_KEY).catch(() => null)
  return new Set(raw ? JSON.parse(raw) : [])
}

export async function isFileLocked(fileId: string): Promise<boolean> {
  const locked = await getLockedFileIds()
  return locked.has(fileId)
}

export async function lockFile(fileId: string): Promise<void> {
  const locked = await getLockedFileIds()
  locked.add(fileId)
  await SecureStore.setItemAsync(LOCKED_FILES_KEY, JSON.stringify([...locked]))
}

export async function unlockFile(fileId: string): Promise<void> {
  const locked = await getLockedFileIds()
  locked.delete(fileId)
  await SecureStore.setItemAsync(LOCKED_FILES_KEY, JSON.stringify([...locked]))
}
