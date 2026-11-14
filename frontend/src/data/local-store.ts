import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 每次读都直接回源，不长期缓存——两个标签页同时操作时，谁先写谁生效，另一个不能拿着旧快照继续判定。
const STORAGE_KEY = 'data-layer-studio:entries'
const ODS_RUNTIME_KEY = 'data-layer-studio:ods-runtime'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function writeRaw(key: string, value: unknown): void {
  if (!hasStorage()) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储配额 / 隐私模式：内存态仍然可用，不把页面打崩
  }
}

function readRaw<T>(key: string): T | null {
  if (!hasStorage()) return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!hasStorage()) {
    return fallback
  }
  const parsed = readRaw<Record<string, EntryRow[]>>(STORAGE_KEY)
  if (!parsed) {
    writeRaw(STORAGE_KEY, fallback)
    return fallback
  }
  // 种子里新增的模块要合并进来；已经落盘的模块以落盘为准，不拿旧种子覆盖用户的改动。
  return { ...fallback, ...parsed, ods: migrateOds(parsed.ods, fallback.ods) }
}

/**
 * 旧版本落盘的贴源表缺少连接 / 映射版本 / 代次这些链路段，按表编号从种子里补齐缺省键。
 * 只补缺失字段，不覆盖已落盘的状态——旧记录如果还挂着「已启用」，交给资格判定去暴露，而不是这里悄悄改。
 */
function migrateOds(stored: EntryRow[] | undefined, seedRows: EntryRow[]): EntryRow[] {
  if (!Array.isArray(stored)) return seedRows
  return stored.map((row) => {
    const template = seedRows.find((item) => item['表编号'] === row['表编号'])
    if (!template) return row
    const missing: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(template)) {
      if (row[key] !== undefined) continue
      if (value === null || value === undefined) continue
      missing[key] = value
    }
    return { ...missing, ...row }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  return readStorage()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  writeRaw(STORAGE_KEY, next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 运行态（执行代次、回执、令牌）与业务行分开存：列表筛选、导出、重置都不该把它们带出去。 */
export function readJson<T>(slot: 'odsRuntime'): T | null {
  if (slot === 'odsRuntime') {
    return readRaw<T>(ODS_RUNTIME_KEY)
  }
  return null
}

export function writeJson(slot: 'odsRuntime', value: unknown): void {
  if (slot === 'odsRuntime') {
    writeRaw(ODS_RUNTIME_KEY, value)
  }
}

/** 清空所有本地数据（含运行态），回到示例数据。 */
export function clearAll(): void {
  if (!hasStorage()) return
  window.localStorage.removeItem(STORAGE_KEY)
  window.localStorage.removeItem(ODS_RUNTIME_KEY)
}
