import type { PersistedCollationState } from '../types';
import { normalizeState, nowStamp } from './merge';

/**
 * 多页签接力全部建立在 localStorage 上：
 * - 规范草稿（主文档）
 * - 写锁 + 持有者心跳草稿
 * - 各页签离线暂存（stash）
 * 配合 storage 事件实现页签间即时感知；BroadcastChannel 仅做锁通知加速。
 */

export const STORAGE_KEYS = {
  main: 'sologsb-1023/multi-version-collation/v1',
  lock: 'sologsb-1023/collaboration/lock/v1',
  stashPrefix: 'sologsb-1023/collaboration/stash/v1/',
  tabPrefix: 'sologsb-1023/collaboration/tab/v1/'
} as const;

export const HEARTBEAT_INTERVAL = 1500;
/** 超过此时长没有心跳即认为页面崩溃，锁可被接管。 */
export const HEARTBEAT_TIMEOUT = 8000;

export interface LockRecord {
  holderTabId: string;
  holderLabel: string;
  acquiredAt: string;
  heartbeatAt: number;
  /** 持有者正在写的草稿（接回崩溃前未入主文档的内容）。 */
  draft: PersistedCollationState | null;
  /** 持有者基于哪个修订号。 */
  baseRevision: number;
}

export interface StashRecord {
  tabId: string;
  tabLabel: string;
  createdAt: string;
  updatedAt: string;
  /** 分叉时的规范草稿（三路合并的 base）。 */
  base: PersistedCollationState;
  /** 该页签离线编辑后的草稿。 */
  draft: PersistedCollationState;
}

export type SaveResult = 'ok' | 'quota';

export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014)
  );
}

/** 容量敏感写入：容量不足时返回 quota，不抛出。 */
export function safeSetItem(key: string, value: string): SaveResult {
  try {
    localStorage.setItem(key, value);
    return 'ok';
  } catch (error) {
    if (isQuotaError(error)) return 'quota';
    // 隐私模式等场景也按容量问题处理，避免静默丢稿。
    try {
      localStorage.setItem(key, value);
      return 'ok';
    } catch {
      return 'quota';
    }
  }
}

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeRemoveItem(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readMainState(): PersistedCollationState | null {
  const raw = safeGetItem(STORAGE_KEYS.main);
  if (!raw) return null;
  try {
    return normalizeState(JSON.parse(raw) as PersistedCollationState);
  } catch {
    return null;
  }
}

export function readLock(): LockRecord | null {
  const raw = safeGetItem(STORAGE_KEYS.lock);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockRecord;
  } catch {
    return null;
  }
}

export function writeLock(record: LockRecord): SaveResult {
  return safeSetItem(STORAGE_KEYS.lock, JSON.stringify(record));
}

export function clearLock(holderTabId: string) {
  const lock = readLock();
  if (lock && lock.holderTabId === holderTabId) safeRemoveItem(STORAGE_KEYS.lock);
}

export function isLockStale(lock: LockRecord | null, now = Date.now()): boolean {
  if (!lock) return true;
  return now - lock.heartbeatAt > HEARTBEAT_TIMEOUT;
}

export function stashKey(tabId: string): string {
  return `${STORAGE_KEYS.stashPrefix}${tabId}`;
}

export function readStash(tabId: string): StashRecord | null {
  const raw = safeGetItem(stashKey(tabId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StashRecord;
    return { ...parsed, base: normalizeState(parsed.base), draft: normalizeState(parsed.draft) };
  } catch {
    return null;
  }
}

export function writeStash(record: StashRecord): SaveResult {
  return safeSetItem(
    stashKey(record.tabId),
    JSON.stringify({ ...record, updatedAt: nowStamp() } satisfies StashRecord)
  );
}

export function removeStash(tabId: string) {
  safeRemoveItem(stashKey(tabId));
}

export function listStashKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEYS.stashPrefix)) keys.push(key);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

/** 试探是否还能写入约 bytes 字节，用于合并前容量预检。 */
export function estimateFreeCapacity(bytes: number): boolean {
  const probe = 'sologsb-1023/collaboration/probe';
  const result = safeSetItem(probe, 'x'.repeat(Math.max(0, bytes)));
  safeRemoveItem(probe);
  return result === 'ok';
}
