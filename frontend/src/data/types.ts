/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** localStorage 里能安全往返的标量值。运行态的嵌套结构另有类型，不进业务行。 */
export type CellValue = string | number | boolean | null | undefined

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: CellValue
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /**
   * 动作只允许从这些状态发起。没有登记的模块退回旧行为（只拦截“已经处于目标状态”），
   * 贴源层 / 数据同步 / 数据源这些有前置依赖的模块必须显式登记。
   */
  actionFrom?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 机器可核对的失败码，例如 TOKEN_HELD / PRECONDITION_FAILED。 */
  code?: string
  /** 失败时回给页面的可核对上下文：令牌号、持有者、代次、阻断原因等。 */
  details?: Record<string, CellValue>
}

export type QualitySignal = {
  id: number
  rule: string
  table: string
  status: string
  effectiveStatus: string
  ok: boolean
  reasons: string[]
}

export type SyncHealth = {
  id: number
  code: string
  status: string
  effectiveStatus: string
  startable: boolean
  statusInvalid: boolean
  sourceRef: string
  sourceStatus: string
  linkedOds: string
  linkedOdsStatus: string
  replayOk: boolean
  reasons: string[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  /** 概览里的贴源层资格信号：详情、列表与概览都读同一份判定结果。 */
  odsSignals: OdsHealth[]
  qualitySignals: QualitySignal[]
  alerts: { level: 'info' | 'warn' | 'error'; object: string; message: string }[]
}

export type OdsPageResult = PageResult & {
  healths: OdsHealth[]
}

export type SyncPageResult = PageResult & {
  healths: SyncHealth[]
}

/** 一次校验回执。回执绑定「执行代次 + 字段映射版本」，不能跨代复用。 */
export type OdsReceipt = {
  id: string
  epoch: number
  mappingVersion: string
  result: '通过' | '拒绝'
  at: string
  watermark: string
  note: string
}

/** 旧代次迟到回执：只归档，不参与当前代次的水位合并。 */
export type OdsArchiveEntry = {
  receipt: OdsReceipt
  archivedAt: string
  reason: string
}

/** 启用令牌：同一张贴源表、同一代次只允许一张有效令牌。 */
export type OdsToken = {
  id: string
  holder: string
  epoch: number
  issuedAt: string
}

/**
 * 贴源层运行态：执行代次 / 校验回执 / 启用令牌 / 回放核对，单独落在 localStorage，和业务行分开审计。
 */
export type OdsRuntimeTable = {
  epoch: number
  mappingVersion: string
  watermark: string
  receipt: OdsReceipt | null
  receipts: OdsReceipt[]
  archives: OdsArchiveEntry[]
  token: OdsToken | null
  replayChecks: OdsReplayCheck[]
}

/**
 * 贴源表用动作日志：争抢 / 迟到回执 / 回放核对都留痕，供详情与审计核对。
 * 日志只追加，不参与资格判定，所以放在运行态的顶层而不是每张表里。
 */
export type OdsEvent = {
  id: string
  at: string
  action: string
  tab: string
  ok: boolean
  code: string
  message: string
  details: Record<string, CellValue>
}

export type OdsRuntime = {
  revision: number
  tables: Record<string, OdsRuntimeTable>
  events: OdsEvent[]
}

export type OdsEligibilityCheck = {
  key: 'source' | 'mapping' | 'receipt'
  label: string
  ok: boolean
  detail: string
}

export type OdsEligibility = {
  ok: boolean
  reasons: string[]
  checks: OdsEligibilityCheck[]
  sourceRef: string
  sourceStatus: string
  mappingVersion: string
  receipt: OdsReceipt | null
}

export type OdsHealth = {
  id: number
  code: string
  status: string
  /** 列表/详情展示用：旧的“已启用”如果资格失效，这里会显示「已启用（资格失效）」。 */
  effectiveStatus: string
  /** 当前是否满足启用条件（不代表已经启用）。 */
  eligible: boolean
  /** 状态为已启用且资格仍然成立。 */
  enabledValid: boolean
  statusInvalid: boolean
  epoch: number
  mappingVersion: string
  watermark: string
  replayBatch: string
  replayState: string
  sourceRef: string
  sourceStatus: string
  linkedSync: string
  reasons: string[]
  token: OdsToken | null
  receipt: OdsReceipt | null
  archivedReceipts: number
}

export type OdsReplayCheck = {
  ok: boolean
  odsBatch: string
  syncBatch: string
  linkedSync: string
  checkedAt: string
  reason: string
}

export type OdsDetail = {
  row: EntryRow
  health: OdsHealth
  eligibility: OdsEligibility
  source: EntryRow | null
  linkedSync: EntryRow | null
  replay: OdsReplayCheck
  archives: OdsArchiveEntry[]
  history: OdsArchiveEntry[]
  token: OdsToken | null
  tabId: string
  events: OdsEvent[]
  qualityRules: QualitySignal[]
}
