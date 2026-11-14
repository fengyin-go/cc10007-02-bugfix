import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionResult,
  CellValue,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  OdsArchiveEntry,
  OdsDetail,
  OdsEligibility,
  OdsEligibilityCheck,
  OdsHealth,
  OdsReplayCheck,
  OdsRuntime,
  OdsRuntimeTable,
  OdsToken,
  OdsEvent,
  PageResult,
  QualitySignal,
  SyncHealth,
  SyncPageResult,
} from '@/data/types'
import { ODS_MAPPING_REGISTRY, ODS_RUNTIME_SEED } from '@/data/seed'
import { allRows, listRows, readJson, resetRows, saveRows, writeJson } from '@/data/local-store'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 只有这些状态可以拿去做「启用资格」判定；草稿 / 待校验 / 已停用都还没有资格。
const ENABLED_STATUS = '已启用'
const SOURCE_READY_STATUS = '已连通'

// 每个浏览器标签页一个稳定 id：令牌的「持有者」就是它，用来判断争抢时谁是败者。
// 放在 sessionStorage 里，刷新不变、另开标签页各不相同；判定本身仍然以 localStorage 里的令牌为准。
let tabId = ''

function ensureTabId(): string {
  if (tabId) return tabId
  const fallback = `tab-${Math.random().toString(36).slice(2, 8)}`
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const existing = window.sessionStorage.getItem('data-layer-studio:tab')
      if (existing) {
        tabId = existing
        return tabId
      }
      window.sessionStorage.setItem('data-layer-studio:tab', fallback)
    }
  } catch {
    // 隐私模式下 sessionStorage 不可用，退回进程内 id
  }
  tabId = fallback
  return tabId
}

export function setTabId(id: string): void {
  tabId = id
}

export function currentTabId(): string {
  return ensureTabId()
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/* ------------------------------------------------------------------------- *
 * 贴源层运行态：执行代次 / 校验回执 / 启用令牌 / 回放核对
 * ------------------------------------------------------------------------- */

function defaultRuntimeTable(row: EntryRow): OdsRuntimeTable {
  return {
    epoch: Number(row['执行代次'] ?? 1) || 1,
    mappingVersion: String(row['字段映射版本'] ?? ''),
    watermark: String(row['增量水位'] ?? ''),
    receipt: null,
    receipts: [],
    archives: [],
    token: null,
    replayChecks: [],
  }
}

function readOdsRuntime(): OdsRuntime {
  const stored = readJson<OdsRuntime>('odsRuntime')
  if (!stored || typeof stored !== 'object' || !stored.tables) {
    return { revision: 0, tables: {}, events: [] }
  }
  return {
    revision: Number(stored.revision ?? 0),
    tables: stored.tables ?? {},
    events: Array.isArray(stored.events) ? stored.events : [],
  }
}

function writeOdsRuntime(runtime: OdsRuntime): void {
  writeJson('odsRuntime', runtime)
}

/** 追加一条动作日志：争抢失败、迟到回执归档都要能在详情里核对。 */
function appendEvent(
  runtime: OdsRuntime,
  event: Omit<OdsEvent, 'id' | 'at'> & { at?: string },
): void {
  runtime.events = [
    ...runtime.events.slice(-199),
    {
      id: `EVT-${runtime.revision + 1}-${runtime.events.length + 1}`,
      at: event.at ?? nowStamp(),
      ...event,
    },
  ]
}

/** 读一张贴源表的运行态，缺失的字段用种子 / 业务行补齐，返回的是可写副本。 */
function runtimeFor(code: string, row: EntryRow, runtime = readOdsRuntime()): OdsRuntimeTable {
  const seed = ODS_RUNTIME_SEED[code] ?? defaultRuntimeTable(row)
  const current = runtime.tables[code]
  return {
    ...seed,
    ...(current ?? {}),
    // 映射版本以「启用时固化的运行态」为准；没有运行态时才回落到业务行。
    // 这样登记值被改动后能立刻暴露成资格失效，而不是两边永远自洽。
    mappingVersion: String(current?.mappingVersion ?? seed.mappingVersion ?? row['字段映射版本'] ?? ''),
    watermark: String(current?.watermark ?? seed.watermark ?? row['增量水位'] ?? ''),
    receipts: [...((current?.receipts ?? seed.receipts) as OdsReceiptLike[])],
    archives: [...((current?.archives ?? seed.archives) as OdsArchiveEntry[])],
    replayChecks: [...((current?.replayChecks ?? seed.replayChecks) as OdsReplayCheck[])],
  }
}

type OdsReceiptLike = NonNullable<OdsRuntimeTable['receipt']>

function findOdsRow(code: string): EntryRow | null {
  return listRows('ods').find((row) => String(row['表编号']) === code) ?? null
}

function syncRowFor(odsCode: string): EntryRow | null {
  return (
    listRows('datasync').find((row) => String(row['同步表列表']).trim() === odsCode) ?? null
  )
}

function sourceRowFor(code: string): EntryRow | null {
  if (!code) return null
  return listRows('source').find((row) => String(row['连接编号']) === code) ?? null
}

/**
 * 启用资格：源端握手（数据源连接已连通）+ 字段映射版本 + 校验回执。
 * 三者缺一不可，任何一项不成立都把原因带回给页面，不能靠单一状态字段蒙混。
 */
function evaluateOdsEligibility(
  row: EntryRow,
  runtime: OdsRuntimeTable,
  opts: { ignoreToken?: boolean; ignoreReceipt?: boolean } = {},
): OdsEligibility {
  const sourceRef = String(row['源端连接'] ?? '')
  const source = sourceRowFor(sourceRef)
  const sourceStatus = source ? String(source.status) : '未登记'
  const sourceOk = Boolean(source) && sourceStatus === SOURCE_READY_STATUS

  const mappingRef = String(row['字段映射'] ?? '')
  const registered = ODS_MAPPING_REGISTRY[mappingRef]
  const mappingVersion = runtime.mappingVersion
  const rowVersion = String(row['字段映射版本'] ?? '')
  const mappingOk =
    Boolean(mappingVersion) &&
    mappingVersion === rowVersion &&
    Boolean(registered) &&
    registered?.version === rowVersion

  const receipt = runtime.receipt
  const receiptOk =
    !opts.ignoreReceipt &&
    Boolean(receipt) &&
    receipt?.epoch === Number(runtime.epoch) &&
    receipt?.mappingVersion === mappingVersion &&
    receipt?.result === '通过'

  const checks: OdsEligibilityCheck[] = [
    {
      key: 'source',
      label: '源端握手',
      ok: sourceOk,
      detail: source
        ? `${sourceRef} 当前「${sourceStatus}」${sourceOk ? '' : '，需要先建立连接'}`
        : `未找到源端连接 ${sourceRef || '（空）'}`,
    },
    {
      key: 'mapping',
      label: '字段映射版本',
      ok: mappingOk,
      detail: mappingOk
        ? `映射 ${mappingRef} 登记版本 ${registered?.version}，与贴源表版本 ${rowVersion} 一致`
        : [
            registered ? '' : `字段映射 ${mappingRef || '（空）'} 未登记`,
            mappingVersion === rowVersion
              ? ''
              : `运行态版本「${mappingVersion || '空'}」与贴源表「${rowVersion || '空'}」不一致`,
            registered && registered.version !== rowVersion
              ? `登记版本「${registered.version}」与贴源表「${rowVersion}」不一致`
              : '',
          ]
            .filter(Boolean)
            .join('；'),
    },
    {
      key: 'receipt',
      label: '校验回执',
      ok: receiptOk,
      detail: receipt
        ? `代次 ${receipt.epoch} / 映射 ${receipt.mappingVersion} / ${receipt.result}` +
          (receipt.result === '通过' ? '' : `（${receipt.note}）`)
        : '当前代次没有校验回执，需先提交校验',
    },
  ]

  const reasons = checks.filter((check) => !check.ok).map((check) => `${check.label}：${check.detail}`)
  if (runtime.token && !opts.ignoreToken) {
    reasons.push(
      `启用令牌 ${runtime.token.id} 由 ${runtime.token.holder} 持有，代次 ${runtime.token.epoch}`,
    )
  }

  return {
    ok: reasons.length === 0,
    reasons,
    checks,
    sourceRef,
    sourceStatus,
    mappingVersion,
    receipt,
  }
}

/** 列表 / 详情 / 概览共用的唯一判定入口，避免三处各算一套。 */
function buildOdsHealth(row: EntryRow, runtime: OdsRuntimeTable): OdsHealth {
  const code = String(row['表编号'] ?? '')
  const status = String(row.status)
  const eligibility = evaluateOdsEligibility(row, runtime, { ignoreToken: true })
  const sync = syncRowFor(code)
  const enabledValid = status === ENABLED_STATUS && eligibility.ok
  const statusInvalid = status === ENABLED_STATUS && !eligibility.ok
  const lastReplay = runtime.replayChecks[runtime.replayChecks.length - 1] ?? null

  const reasons: string[] = []
  if (statusInvalid) reasons.push('状态已置为已启用，但启用资格不成立')
  reasons.push(...eligibility.reasons)

  return {
    id: Number(row.id),
    code,
    status,
    effectiveStatus: statusInvalid ? `${ENABLED_STATUS}（资格失效）` : status,
    eligible: eligibility.ok,
    enabledValid,
    statusInvalid,
    epoch: Number(runtime.epoch),
    mappingVersion: runtime.mappingVersion,
    watermark: runtime.watermark,
    replayBatch: String(row['回放批次'] ?? ''),
    replayState: lastReplay
      ? lastReplay.ok
        ? '已核对一致'
        : '回放批次不一致'
      : String(row['回放状态'] ?? '未回放'),
    sourceRef: eligibility.sourceRef,
    sourceStatus: eligibility.sourceStatus,
    linkedSync: sync ? String(sync['链路编号']) : '',
    reasons,
    token: runtime.token,
    receipt: runtime.receipt,
    archivedReceipts: runtime.archives.length,
  }
}

export function odsHealth(code: string): OdsHealth | null {
  const row = findOdsRow(code)
  if (!row) return null
  return buildOdsHealth(row, runtimeFor(code, row))
}

export function listOdsEntries(
  key: string,
  filters: Record<string, string> = {},
): PageResult & { healths: OdsHealth[] } {
  const rows = listRows(key).filter((row) => {
    const pairs = Object.entries(filters).filter(([, value]) => String(value ?? '').trim() !== '')
    return pairs.every(([field, value]) =>
      String(row[field] ?? '')
        .toLowerCase()
        .includes(String(value).trim().toLowerCase()),
    )
  })
  const runtime = readOdsRuntime()
  return {
    items: rows,
    total: rows.length,
    page: 1,
    size: rows.length,
    healths: rows.map((row) => buildOdsHealth(row, runtimeFor(String(row['表编号']), row, runtime))),
  }
}

function patchOdsRow(code: string, patch: Record<string, CellValue>): void {
  const rows = listRows('ods')
  const index = rows.findIndex((row) => String(row['表编号']) === code)
  if (index < 0) return
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows('ods', next)
}

function saveRuntimeTable(
  code: string,
  table: OdsRuntimeTable,
  event?: Omit<OdsEvent, 'id' | 'at' | 'code'> & { code?: string },
): void {
  const runtime = readOdsRuntime()
  runtime.revision += 1
  runtime.tables = { ...runtime.tables, [code]: table }
  if (event) appendEvent(runtime, { code, ...event })
  writeOdsRuntime(runtime)
}

/**
 * 校验回执只认当前代次：代次或映射版本对不上的回执一律归档，
 * 既不写入 table.receipt，也不动 table.watermark——新代次的水位只能由新代次的回执推进。
 */
function acceptReceipt(code: string, table: OdsRuntimeTable, receipt: OdsReceiptLike): {
  archived: boolean
  message: string
} {
  const staleEpoch = receipt.epoch !== table.epoch
  const staleMapping = receipt.mappingVersion !== table.mappingVersion
  if (staleEpoch || staleMapping) {
    table.archives.push({
      receipt,
      archivedAt: nowStamp(),
      reason: staleEpoch
        ? `回执代次 ${receipt.epoch} 与当前代次 ${table.epoch} 不一致，归档且不覆盖水位 ${table.watermark}`
        : `回执映射版本 ${receipt.mappingVersion} 与当前 ${table.mappingVersion} 不一致，归档且不覆盖水位 ${table.watermark}`,
    })
    return {
      archived: true,
      message: `回执 ${receipt.id} 不属于当前代次 ${table.epoch} / 映射 ${table.mappingVersion}，已归档且不覆盖水位 ${table.watermark}`,
    }
  }
  table.receipts.push(receipt)
  table.receipt = receipt
  // 只有当前代次的「通过」回执能推进水位，并回写到业务行，列表 / 详情 / 概览读同一份
  let advanced = false
  if (receipt.result === '通过' && receipt.watermark) {
    advanced = receipt.watermark !== table.watermark
    table.watermark = receipt.watermark
    patchOdsRow(code, { ['增量水位']: receipt.watermark })
  }
  return {
    archived: false,
    message:
      `回执 ${receipt.id} 已登记到代次 ${receipt.epoch}，` +
      (receipt.result === '通过'
        ? advanced
          ? `水位推进到 ${table.watermark}`
          : `水位维持 ${table.watermark}`
        : `状态「${receipt.result}」，水位不推进（仍为 ${table.watermark}）`),
  }
}

/**
 * 外部校验器 / 同步链路回传回执的入口（纯前端版由页面或测试直接调用）。
 * 迟到的旧代次回执走归档路径，不会覆盖当前代次的水位与有效回执。
 */
export function ingestOdsReceipt(
  code: string,
  input: {
    id?: string
    epoch: number
    mappingVersion: string
    result: OdsReceiptLike['result']
    watermark?: string
    note?: string
  },
): ActionResult {
  const row = findOdsRow(code)
  if (!row) return failure(`没有找到编号为 ${code} 的贴源表`, 'NOT_FOUND', { code })
  const runtime = readOdsRuntime()
  const table = runtimeFor(code, row, runtime)
  const receipt: OdsReceiptLike = {
    id: input.id ?? `RCPT-${code}-${input.epoch}-${Date.now()}`,
    epoch: input.epoch,
    mappingVersion: input.mappingVersion,
    result: input.result,
    at: nowStamp(),
    watermark: input.watermark ?? table.watermark,
    note: input.note ?? (input.epoch === table.epoch ? '回执已登记' : '迟到回执'),
  }
  const accepted = acceptReceipt(code, table, receipt)
  saveRuntimeTable(code, table, {
    action: accepted.archived ? '归档迟到回执' : '登记校验回执',
    tab: currentTabId(),
    ok: true,
    code,
    message: accepted.message,
    details: { receiptId: receipt.id, epoch: receipt.epoch, archived: accepted.archived },
  })
  return {
    ok: true,
    message: accepted.message,
    details: { receiptId: receipt.id, epoch: receipt.epoch, archived: accepted.archived },
  }
}

function archiveStaleReceipts(code: string, table: OdsRuntimeTable, nextEpoch: number): void {
  if (table.receipt) {
    table.archives.push({
      receipt: table.receipt,
      archivedAt: nowStamp(),
      reason: `停用后开新代次 ${nextEpoch}，代次 ${table.receipt.epoch} 回执归档`,
    })
  }
  table.receipt = null
}

/* ------------------------------------------------------------------------- *
 * 动作流转
 * ------------------------------------------------------------------------- */

function failure(message: string, code: string, details?: Record<string, CellValue>): ActionResult {
  return { ok: false, message, code, details }
}

function success(message: string, details?: Record<string, CellValue>): ActionResult {
  return { ok: true, message, details }
}

function nowStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function makeToken(code: string, epoch: number): OdsToken {
  return {
    id: `TOKEN-${code}-E${epoch}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    holder: currentTabId(),
    epoch,
    issuedAt: nowStamp(),
  }
}

function runOdsAction(id: number, action: string, meta: ModuleMeta): ActionResult | null {
  // 只接管贴源层自己的三个动作。提交校验必须走这里：它要落回执、绑代次，
  // 不能退化成通用流转只改状态。
  if (action !== '提交校验' && action !== '启用同步' && action !== '停用同步') return null
  const result = executeOdsAction(id, action, meta)
  const row = listRows('ods').find((item) => Number(item.id) === id)
  const code = String(row?.['表编号'] ?? '')
  const runtime = readOdsRuntime()
  runtime.revision += 1
  appendEvent(runtime, {
    action,
    tab: currentTabId(),
    ok: result.ok,
    code,
    message: result.message,
    details: result.details ?? {},
  })
  writeOdsRuntime(runtime)
  return result
}

function executeOdsAction(id: number, action: string, meta: ModuleMeta): ActionResult {
  const rows = listRows('ods')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return failure(`没有找到编号为 ${id} 的${meta.entity}`, 'NOT_FOUND')
  }
  const row = rows[index]
  const code = String(row['表编号'] ?? '')
  const runtime = readOdsRuntime()
  const table = runtimeFor(code, row, runtime)
  const status = String(row.status)

  if (action === '提交校验') {
    // 已停用也可以提交校验：停用时已经开了新代次，这里的回执会落在新代次上，
    // 满足资格后才能重新启用。已启用状态要先停用，避免运行中偷偷换掉映射与回执。
    if (status === ENABLED_STATUS) {
      return failure(
        `贴源表 ${code} 正在启用中，提交校验前请先停用，校验回执会落在新代次上`,
        'PRECONDITION_FAILED',
        { code, status },
      )
    }
    const epoch = table.epoch
    const mappingVersion = table.mappingVersion
    const sourceRef = String(row['源端连接'] ?? '')
    const source = sourceRowFor(sourceRef)
    // 握手 / 映射没准备好时，校验仍然要出回执，但回执只能给「拒绝」，不能伪造「通过」
    const checksOk = Boolean(source) && String(source?.status) === SOURCE_READY_STATUS
    const mappingOk = mappingVersion === String(row['字段映射版本'] ?? '')
    const result: OdsReceiptLike['result'] = checksOk && mappingOk ? '通过' : '拒绝'
    const note =
      result === '通过'
        ? `源端 ${sourceRef} 握手正常，字段映射 ${mappingVersion} 校验通过`
        : [
            checksOk ? '' : `源端 ${sourceRef} ${source ? `当前「${source.status}」` : '未登记'}`,
            mappingOk ? '' : `映射版本「${mappingVersion}」与登记值不一致`,
          ]
            .filter(Boolean)
            .join('；')
    const receipt: OdsReceiptLike = {
      id: `RCPT-${code}-${String(epoch).padStart(3, '0')}-${table.receipts.length + 1}`,
      epoch,
      mappingVersion,
      result,
      at: nowStamp(),
      watermark: table.watermark || String(row['增量水位'] ?? ''),
      note,
    }
    const accepted = acceptReceipt(code, table, receipt)
    table.replayChecks.push(
      makeReplayCheck(code, table, syncRowFor(code), `提交校验（代次 ${epoch}）`),
    )
    saveRuntimeTable(code, table)
    // 状态推进和回执走同一把判定：拒绝的回执不能把行推进成待校验之外的任何东西
    patchOdsRow(code, { status: '待校验', pending: true, abnormal: receipt.result !== '通过' })
    return success(
      `贴源表 ${code} 已提交校验（代次 ${epoch}，映射 ${mappingVersion}）：${receipt.result}。${accepted.message}`,
      {
        code,
        epoch,
        receiptId: receipt.id,
        result: receipt.result,
        archived: accepted.archived,
        note,
      },
    )
  }

  if (action === '启用同步') {
    if (status === ENABLED_STATUS && table.token) {
      // 另一个标签页先拿到令牌：这次不给新令牌，但要把令牌号 / 持有者 / 代次交回去核对
      const otherHolder = table.token.holder !== currentTabId()
      return failure(
        `贴源表 ${code} 已启用，令牌 ${table.token.id} 由 ${table.token.holder} 持有（代次 ${table.token.epoch}），` +
          (otherHolder ? '本标签页未获得启用资格' : '不用重复启用'),
        otherHolder ? 'TOKEN_HELD' : 'ALREADY_ENABLED',
        {
          code,
          tokenId: table.token.id,
          holder: table.token.holder,
          epoch: table.token.epoch,
          issuedAt: table.token.issuedAt,
          tab: currentTabId(),
        },
      )
    }
    if (status !== '待校验') {
      return failure(`贴源表 ${code} 当前「${status}」，只有待校验状态可以启用同步`, 'PRECONDITION_FAILED', {
        code,
        status,
      })
    }
    const eligibility = evaluateOdsEligibility(row, table, { ignoreToken: true, ignoreReceipt: false })
    if (!eligibility.ok) {
      return failure(
        `贴源表 ${code} 不满足启用资格：${eligibility.reasons.join('；')}`,
        'PRECONDITION_FAILED',
        {
          code,
          epoch: table.epoch,
          checks: eligibility.checks
            .map((check) => `${check.label}=${check.ok ? '通过' : '阻断'}`)
            .join('；'),
        },
      )
    }
    const holder = table.token ? table.token.holder : ''
    if (table.token && table.token.holder !== currentTabId()) {
      // 同一张贴源表被两个标签页争抢：只发一张，败者拿到可核对原因（令牌号 / 持有者 / 代次）
      return failure(
        `贴源表 ${code} 的启用令牌 ${table.token.id} 已由 ${holder} 持有（代次 ${table.token.epoch}），本次未发放`,
        'TOKEN_HELD',
        {
          code,
          tokenId: table.token.id,
          holder,
          epoch: table.token.epoch,
          issuedAt: table.token.issuedAt,
          tab: currentTabId(),
        },
      )
    }
    const token = makeToken(code, table.epoch)
    // 发放前再读一次最新运行态：两个标签页都通过了资格判定时，先写入的那张令牌才算数
    const latest = readOdsRuntime()
    const latestTable = runtimeFor(code, row, latest)
    if (latestTable.token && latestTable.token.holder !== currentTabId()) {
      return failure(
        `贴源表 ${code} 的启用令牌 ${latestTable.token.id} 已由 ${latestTable.token.holder} 持有（代次 ${latestTable.token.epoch}），本次未发放`,
        'TOKEN_HELD',
        {
          code,
          tokenId: latestTable.token.id,
          holder: latestTable.token.holder,
          epoch: latestTable.token.epoch,
          issuedAt: latestTable.token.issuedAt,
          tab: currentTabId(),
        },
      )
    }
    table.token = token
    saveRuntimeTable(code, table)
    patchOdsRow(code, {
      status: ENABLED_STATUS,
      pending: false,
      abnormal: false,
      // 启用时把资格成立时的映射版本固化到行上，详情面板不再和运行态打架
      ['字段映射版本']: table.mappingVersion,
    })
    return success(
      `贴源表 ${code} 已启用，发放令牌 ${token.id}（持有者 ${token.holder}，代次 ${token.epoch}）`,
      {
        code,
        tokenId: token.id,
        holder: token.holder,
        epoch: token.epoch,
        checks: eligibility.checks.map((check) => `${check.label}=通过`).join('；'),
      },
    )
  }

  if (action === '停用同步') {
    if (status !== ENABLED_STATUS) {
      return failure(`贴源表 ${code} 当前「${status}」，没有可停用的启用令牌`, 'PRECONDITION_FAILED', {
        code,
        status,
      })
    }
    const previousEpoch = table.epoch
    const nextEpoch = previousEpoch + 1
    // 停用即结束当前代次：回执归档、令牌收回、水位保留在新代次起点由下一次回执决定
    archiveStaleReceipts(code, table, nextEpoch)
    table.epoch = nextEpoch
    table.token = null
    saveRuntimeTable(code, table)
    patchOdsRow(code, { status: '已停用', pending: true, abnormal: false, ['执行代次']: nextEpoch })
    return success(
      `贴源表 ${code} 已停用；代次 ${previousEpoch} → ${nextEpoch}，旧回执 ${table.archives.length} 条归档，不覆盖新水位`,
      {
        code,
        previousEpoch,
        epoch: nextEpoch,
        archived: table.archives.length,
        watermark: table.watermark,
      },
    )
  }

  return failure(`${meta.entity}没有登记「${action}」这个动作`, 'UNKNOWN_ACTION', { action })
}

/* ----------------------------------------------------------------- *
 * 数据同步链路：启动前必须能看到贴源表已启用且回放批次一致
 * ----------------------------------------------------------------- */

/** 启动同步把整条链路（源端 → 贴源表 → 链路批次）一次核对完，失败原因逐条带回。 */

function makeReplayCheck(
  code: string,
  table: OdsRuntimeTable,
  sync: EntryRow | null,
  reasonPrefix: string,
): OdsReplayCheck {
  const odsBatch = String(findOdsRow(code)?.['回放批次'] ?? '')
  const syncBatch = sync ? String(sync['回放批次'] ?? '') : ''
  const linkedSync = sync ? String(sync['链路编号']) : ''
  const ok = Boolean(linkedSync) && Boolean(odsBatch) && odsBatch === syncBatch
  return {
    ok,
    odsBatch,
    syncBatch,
    linkedSync,
    checkedAt: nowStamp(),
    reason: ok
      ? `${reasonPrefix}：回放批次 ${odsBatch} 与链路批次数一致`
      : `${reasonPrefix}：贴源批次「${odsBatch || '空'}」与链路批次「${syncBatch || '空'}」不一致或链路缺失`,
  }
}

export function syncHealth(row: EntryRow): SyncHealth {
  const code = String(row['链路编号'] ?? '')
  const status = String(row.status)
  const odsCode = String(row['同步表列表'] ?? '').trim()
  const ods = findOdsRow(odsCode)
  const odsRuntime = ods ? runtimeFor(odsCode, ods) : null
  const odsHealth = ods && odsRuntime ? buildOdsHealth(ods, odsRuntime) : null
  const source = sourceRowFor(String(row['源端连接'] ?? ''))
  const sourceStatus = source ? String(source.status) : '未登记'
  const sourceOk = sourceStatus === SOURCE_READY_STATUS
  const lastReplay = odsRuntime?.replayChecks[odsRuntime.replayChecks.length - 1] ?? null
  const replayOk = Boolean(lastReplay?.ok)

  const reasons: string[] = []
  if (!ods) reasons.push(`同步表列表中的贴源表 ${odsCode || '（空）'} 不存在`)
  else if (odsHealth?.statusInvalid) reasons.push(`贴源表 ${odsCode} 状态「已启用」但资格失效`)
  else if (String(ods.status) !== ENABLED_STATUS) reasons.push(`贴源表 ${odsCode} 当前「${ods.status}」，未启用`)
  if (odsHealth?.statusInvalid) reasons.push(...odsHealth.reasons.slice(1))
  if (!sourceOk) reasons.push(`源端连接 ${String(row['源端连接'] ?? '')} 当前「${sourceStatus}」，握手未通过`)
  if (!replayOk) reasons.push(`回放批次未核对一致：${lastReplay?.reason ?? '贴源表还没有回放核对记录'}`)

  const startable = reasons.length === 0
  return {
    id: Number(row.id),
    code,
    status,
    effectiveStatus: status === '运行中' && !startable ? '运行中（前置失效）' : status,
    startable,
    statusInvalid: status === '运行中' && !startable,
    sourceRef: String(row['源端连接'] ?? ''),
    sourceStatus,
    linkedOds: odsCode,
    linkedOdsStatus: ods ? odsHealth?.effectiveStatus ?? String(ods.status) : '未登记',
    replayOk,
    reasons,
  }
}

function runSyncAction(id: number, action: string, meta: ModuleMeta): ActionResult | null {
  if (action !== '启动同步' && action !== '停止同步') return null
  const rows = listRows('datasync')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return failure(`没有找到编号为 ${id} 的${meta.entity}`, 'NOT_FOUND')
  const row = rows[index]
  const code = String(row['链路编号'] ?? '')
  const status = String(row.status)

  if (action === '启动同步') {
    if (status === '运行中') {
      return failure(`同步链路 ${code} 已在运行中，不用重复启动`, 'ALREADY_RUNNING', { code })
    }
    const health = syncHealth(row)
    if (!health.startable) {
      return failure(
        `同步链路 ${code} 不能启动：${health.reasons.join('；')}`,
        'PRECONDITION_FAILED',
        { code, linkedOds: health.linkedOds, linkedOdsStatus: health.linkedOdsStatus, replayOk: health.replayOk },
      )
    }
    const next = [...rows]
    next[index] = { ...row, status: '运行中', pending: false, abnormal: false }
    saveRows('datasync', next)
    // 链路真正开跑时给贴源表补一条回放核对，保证回看时批次有据可查
    const odsCode = String(row['同步表列表'] ?? '').trim()
    const ods = findOdsRow(odsCode)
    if (ods) {
      const table = runtimeFor(odsCode, ods)
      table.replayChecks.push(makeReplayCheck(odsCode, table, row, `启动同步 ${code}`))
      saveRuntimeTable(odsCode, table)
    }
    return success(`同步链路 ${code} 已启动，源端 ${health.sourceRef} 握手通过，贴源表 ${health.linkedOds} 已在启用态`, {
      code,
      linkedOds: health.linkedOds,
      sourceRef: health.sourceRef,
    })
  }

  if (action === '停止同步') {
    if (status !== '运行中') {
      return failure(`同步链路 ${code} 当前「${status}」，没有可停止的运行实例`, 'PRECONDITION_FAILED', {
        code,
        status,
      })
    }
    const next = [...rows]
    next[index] = { ...row, status: '已停止', pending: true, abnormal: false }
    saveRows('datasync', next)
    return success(`同步链路 ${code} 已停止`, { code })
  }

  return null
}

function runSourceAction(id: number, action: string, meta: ModuleMeta): ActionResult | null {
  if (action !== '建立连接' && action !== '断开连接') return null
  const rows = listRows('source')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return failure(`没有找到编号为 ${id} 的${meta.entity}`, 'NOT_FOUND')
  const row = rows[index]
  const code = String(row['连接编号'] ?? '')
  const status = String(row.status)

  if (action === '建立连接') {
    if (status === SOURCE_READY_STATUS) {
      return failure(`数据源连接 ${code} 已经处于已连通状态`, 'ALREADY_CONNECTED', { code })
    }
    const next = [...rows]
    next[index] = { ...row, status: SOURCE_READY_STATUS, pending: false, abnormal: false }
    saveRows('source', next)
    return success(`数据源连接 ${code} 握手成功，已连通`, { code })
  }

  if (action === '断开连接') {
    if (status === '已断开') {
      return failure(`数据源连接 ${code} 已是已断开状态`, 'ALREADY_DISCONNECTED', { code })
    }
    // 断开要把下游依赖一起暴露出来：贴源表 / 同步链路的资格会立刻失效，而不是等下次操作才发现
    const dependents = listRows('ods')
      .filter((ods) => String(ods['源端连接'] ?? '') === code)
      .map((ods) => String(ods['表编号'] ?? ''))
    const next = [...rows]
    next[index] = { ...row, status: '已断开', pending: true, abnormal: true }
    saveRows('source', next)
    return success(
      `数据源连接 ${code} 已断开${dependents.length ? `，下游贴源表 ${dependents.join('、')} 的启用资格即刻失效` : ''}`,
      { code, dependents: dependents.join('、') },
    )
  }

  return failure(`${meta.entity}没有登记「${action}」这个动作`, 'UNKNOWN_ACTION', { action })
}

/* ----------------------------------------------------------------- */

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return failure(`${meta.entity}没有登记「${action}」这个动作`, 'UNKNOWN_ACTION', { action })
  }
  // 贴源 / 同步 / 数据源这三个模块有自己的前置校验；其余动作（如「提交校验」「提交连通」）
  // 仍然走下面的通用流转，避免专用处理器把动作吞掉。
  const specialized =
    key === 'ods'
      ? runOdsAction(id, action, meta)
      : key === 'datasync'
        ? runSyncAction(id, action, meta)
        : key === 'source'
          ? runSourceAction(id, action, meta)
          : null
  if (specialized) return specialized

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return failure(`没有找到编号为 ${id} 的${meta.entity}`, 'NOT_FOUND')
  }
  const current = String(rows[index].status)
  if (current === target) {
    return failure(`${meta.entity}已经是「${target}」，不用重复操作`, 'NOOP')
  }
  const allowedFrom = meta.actionFrom?.[action]
  if (allowedFrom && !allowedFrom.includes(current)) {
    return failure(
      `${meta.entity}当前「${current}」，不能直接执行「${action}」，允许的来源状态：${allowedFrom.join('、')}`,
      'PRECONDITION_FAILED',
      { current, action, allowedFrom: allowedFrom.join('、') },
    )
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return success(`${meta.entity}已${action}，当前状态「${target}」`)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'ods') writeJson('odsRuntime', { revision: 0, tables: {}, events: [] })
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/* ----------------------------------------------------------------- *
 * 详情面板：读的是和列表 / 概览同一份 health，不再页面自己拼字段
 * ----------------------------------------------------------------- */

/** 质量规则按「校验表名」绑定到贴源表的目标表名，回看时能直接看到这张表的规则是否还成立。 */
export function qualityRulesForOds(code: string): QualitySignal[] {
  const row = findOdsRow(code)
  if (!row) return []
  const target = String(row['目标表名'] ?? '')
  if (!target) return []
  const overview = loadOverview()
  return overview.qualitySignals.filter((signal) => signal.table === target)
}

/**
 * 回看：只核对贴源表的回放批次与联动同步链路的批次是否一致，不改任何状态。
 * 以贴源层建模为主对象——批次以贴源表登记的回放批次为准，链路批次只是对照项。
 */
export function verifyOdsReplay(code: string): ActionResult {
  const row = findOdsRow(code)
  if (!row) return failure(`没有找到编号为 ${code} 的贴源表`, 'NOT_FOUND', { code })
  const runtime = readOdsRuntime()
  const table = runtimeFor(code, row, runtime)
  const check = makeReplayCheck(code, table, syncRowFor(code), `回看核对 ${code}`)
  table.replayChecks.push(check)
  patchOdsRow(code, { ['回放状态']: check.ok ? '已回放' : '批次不一致' })
  saveRuntimeTable(code, table, {
    action: '核对回放批次',
    tab: currentTabId(),
    ok: check.ok,
    code,
    message: check.reason,
    details: { odsBatch: check.odsBatch, syncBatch: check.syncBatch, linkedSync: check.linkedSync },
  })
  return {
    ok: check.ok,
    code: check.ok ? undefined : 'REPLAY_MISMATCH',
    message: check.reason,
    details: {
      odsBatch: check.odsBatch,
      syncBatch: check.syncBatch,
      linkedSync: check.linkedSync,
    },
  }
}

export function getOdsDetail(code: string): OdsDetail | null {
  const row = findOdsRow(code)
  if (!row) return null
  const runtime = runtimeFor(code, row)
  const health = buildOdsHealth(row, runtime)
  const source = sourceRowFor(String(row['源端连接'] ?? ''))
  const linkedSync = syncRowFor(code)
  const lastReplay = runtime.replayChecks[runtime.replayChecks.length - 1] ?? null
  return {
    row,
    health,
    eligibility: evaluateOdsEligibility(row, runtime, { ignoreToken: true }),
    source,
    linkedSync,
    replay:
      lastReplay ??
      {
        ok: false,
        odsBatch: String(row['回放批次'] ?? ''),
        syncBatch: linkedSync ? String(linkedSync['回放批次'] ?? '') : '',
        linkedSync: linkedSync ? String(linkedSync['链路编号']) : '',
        checkedAt: '—',
        reason: '还没有回放核对记录，先提交校验或启动联动的同步链路',
      },
    archives: runtime.archives,
    history: runtime.receipts
      .filter((receipt) => receipt.epoch === runtime.epoch)
      .map((receipt) => ({
        receipt,
        archivedAt: '—',
        reason: '当前代次',
      })),
    token: runtime.token,
    tabId: currentTabId(),
    // 详情里的动作记录按整张表展示（含其他标签页的争抢失败），不只过滤当前标签页
    events: readOdsRuntime().events.filter((event) => event.code === code).slice(-20).reverse(),
    qualityRules: qualityRulesForOds(code),
  }
}

/* ----------------------------------------------------------------- *
 * 概览聚合：信号直接取 health，不再读 pending/abnormal 的旧布尔值
 * ----------------------------------------------------------------- */

function qualitySignal(row: EntryRow, healthByTable: Map<string, OdsHealth[]>): QualitySignal {
  const table = String(row['校验表名'] ?? '')
  const status = String(row.status)
  const related = healthByTable.get(table) ?? []
  const reasons: string[] = []
  let ok = true
  if (!related.length) {
    reasons.push(`校验表 ${table || '（空）'} 没有对应的贴源表，规则无法落地`)
    ok = false
  }
  for (const health of related) {
    if (health.statusInvalid) {
      ok = false
      reasons.push(`贴源表 ${health.code} 状态「已启用」但资格失效，质量规则不能继续给正常信号`)
    }
    if (health.reasons.length && !health.statusInvalid) {
      ok = false
      reasons.push(`贴源表 ${health.code}：${health.reasons[0]}`)
    }
  }
  if (status === '已启用' && !ok) {
    reasons.push('规则本身已启用，但上游贴源表不具备正常执行条件')
  }
  return {
    id: Number(row.id),
    rule: String(row['规则编号'] ?? ''),
    table,
    status,
    effectiveStatus: status === '已启用' && !ok ? '已启用（上游失效）' : status,
    ok: status === '已启用' ? ok : false,
    reasons,
  }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const odsRows = rows.ods ?? []
  const runtime = readOdsRuntime()
  const odsSignals = odsRows.map((row) =>
    buildOdsHealth(row, runtimeFor(String(row['表编号']), row, runtime)),
  )
  const healthByTable = new Map<string, OdsHealth[]>()
  for (const health of odsSignals) {
    const target = String(
      findOdsRow(health.code)?.['目标表名'] ?? '',
    )
    if (!target) continue
    healthByTable.set(target, [...(healthByTable.get(target) ?? []), health])
  }

  const qualitySignals = (rows.quality ?? []).map((row) => qualitySignal(row, healthByTable))
  const syncSignals = (rows.datasync ?? []).map(syncHealth)

  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    const invalidOds =
      meta.key === 'ods' ? odsSignals.filter((signal) => signal.statusInvalid).length : 0
    const invalidSync =
      meta.key === 'datasync' ? syncSignals.filter((signal) => signal.statusInvalid).length : 0
    const invalidQuality =
      meta.key === 'quality'
        ? qualitySignals.filter(
            (signal) => signal.status === '已启用' && !signal.ok,
          ).length
        : 0
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length + invalidOds + invalidSync + invalidQuality,
      abnormal:
        entries.filter((row) => row.abnormal).length +
        invalidOds +
        invalidSync +
        invalidQuality,
    }
  })

  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]

  const alerts: OverviewResult['alerts'] = []
  for (const signal of odsSignals) {
    if (signal.statusInvalid) {
      alerts.push({
        level: 'error',
        object: signal.code,
        message: `贴源表标记为「已启用」，但启用资格不成立：${signal.reasons
          .filter((reason) => reason !== '状态已置为已启用，但启用资格不成立')
          .join('；')}`,
      })
    }
  }
  for (const signal of syncSignals) {
    if (signal.statusInvalid) {
      alerts.push({
        level: 'error',
        object: signal.code,
        message: `同步链路标记为「运行中」，但前置条件失效：${signal.reasons.join('；')}`,
      })
    }
  }
  for (const signal of qualitySignals) {
    if (signal.status === '已启用' && !signal.ok) {
      alerts.push({
        level: 'warn',
        object: signal.rule,
        message: `质量规则仍显示已启用，但上游已失效：${signal.reasons.join('；')}`,
      })
    }
  }

  return { cards, modules, odsSignals, qualitySignals, alerts }
}

/**
 * 数据源列表：附带「谁在依赖这条连接」。断开连接前就能看到会连带失效的贴源表，
 * 而不是断完才发现 ODS 还挂着「已启用」。
 */
export function listSourceEntries(
  key: string,
  filters: Record<string, string> = {},
): PageResult & { dependents: Record<string, string> } {
  const matched = filterRows(listRows(key), filters)
  const odsRows = listRows('ods')
  const dependents: Record<string, string> = {}
  for (const source of listRows(key)) {
    const code = String(source['连接编号'] ?? '')
    const users = odsRows
      .filter((ods) => String(ods['源端连接'] ?? '') === code)
      .map((ods) => `${String(ods['表编号'] ?? '')}（${String(ods.status)}）`)
    dependents[code] = users.join('、')
  }
  return { items: matched, total: matched.length, page: 1, size: matched.length, dependents }
}

/* 供页面模板用的同步链路列表（带 health），避免页面自己拼判定。 */
export function listSyncEntries(
  key: string,
  filters: Record<string, string> = {},
): SyncPageResult {
  const matched = filterRows(listRows(key), filters)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    healths: matched.map((row) => syncHealth(row)),
  }
}

/* 质量校验列表：带上游信号，列表里的「已启用」不能和概览各说各话。 */
export function listQualityEntries(
  key: string,
  filters: Record<string, string> = {},
): PageResult & { signals: QualitySignal[] } {
  const matched = filterRows(listRows(key), filters)
  const overview = loadOverview()
  const signalByRule = new Map(overview.qualitySignals.map((signal) => [signal.rule, signal]))
  const signals = matched.map((row) => {
    const rule = String(row['规则编号'] ?? '')
    const found = signalByRule.get(rule)
    if (found) return found
    return {
      id: Number(row.id),
      rule,
      table: String(row['校验表名'] ?? ''),
      status: String(row.status),
      effectiveStatus: String(row.status),
      ok: false,
      reasons: ['列表快照缺少概览信号'],
    }
  })
  return { items: matched, total: matched.length, page: 1, size: matched.length, signals }
}
