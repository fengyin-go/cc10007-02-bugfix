<template>
  <section class="page" data-module="ods">
    <header class="page-head">
      <div>
        <h2>贴源层建模管理</h2>
        <p class="page-desc">维护贴源层同步表的输入、执行约束与结果记录，为贴源层建模提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记贴源表</button>
        <button class="btn" type="button" @click="exportRows">导出贴源层建模清单</button>
        <button class="btn" type="button" @click="reload">刷新状态</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">当前标签页 {{ tabId }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>启用资格</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '表编号'" class="link" type="button" @click="openDetail(String(row[column]))">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ healthOf(row).effectiveStatus }}</td>
          <td :class="healthOf(row).eligible ? 'signal-ok' : 'signal-bad'">
            {{ healthOf(row).eligible ? '可启用' : healthOf(row).reasons[0] ?? '不可启用' }}
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openDetail(String(row['表编号']))">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无贴源层建模数据，可先登记贴源表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条贴源层建模记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <aside v-if="detail" class="detail-panel" data-detail="ods">
      <header class="detail-head">
        <h3>贴源表 {{ detail.health.code }} · 详情</h3>
        <button class="btn ghost" type="button" @click="closeDetail">收起</button>
      </header>

      <div class="detail-grid">
        <div><span class="label">当前状态</span><strong>{{ detail.row.status }}</strong></div>
        <div>
          <span class="label">生效状态</span>
          <strong :class="detail.health.statusInvalid ? 'signal-bad' : ''">{{ detail.health.effectiveStatus }}</strong>
        </div>
        <div><span class="label">执行代次</span><strong>{{ detail.health.epoch }}</strong></div>
        <div><span class="label">字段映射版本</span><strong>{{ detail.health.mappingVersion }}</strong></div>
        <div><span class="label">增量水位</span><strong>{{ detail.health.watermark || '—' }}</strong></div>
        <div><span class="label">源端连接</span><strong>{{ detail.health.sourceRef || '—' }} · {{ detail.health.sourceStatus }}</strong></div>
        <div><span class="label">联动同步链路</span><strong>{{ detail.health.linkedSync || '未关联' }}</strong></div>
        <div><span class="label">回放批次</span><strong>{{ detail.health.replayBatch || '—' }}</strong></div>
        <div><span class="label">回放核对</span><strong>{{ detail.health.replayState }}</strong></div>
      </div>

      <section class="detail-block">
        <h4>启用资格（源端握手 + 字段映射版本 + 校验回执）</h4>
        <ul class="check-list">
          <li v-for="check in detail.eligibility.checks" :key="check.key" :class="check.ok ? 'signal-ok' : 'signal-bad'">
            <strong>{{ check.label }}</strong>：{{ check.detail }}
          </li>
        </ul>
        <p v-if="detail.eligibility.ok" class="signal-ok">三项均满足，可以发放启用令牌。</p>
        <p v-else class="signal-bad">阻断：{{ detail.eligibility.reasons.join('；') }}</p>
      </section>

      <section class="detail-block">
        <h4>启用令牌</h4>
        <p v-if="detail.token">
          {{ detail.token.id }} · 持有者 {{ detail.token.holder }} · 代次 {{ detail.token.epoch }} · 发放于 {{ detail.token.issuedAt }}
        </p>
        <p v-else class="muted">当前没有有效令牌（未启用或已停用）。</p>
      </section>

      <section class="detail-block">
        <h4>当前代次校验回执</h4>
        <p v-if="detail.health.receipt">
          {{ detail.health.receipt.id }} · 代次 {{ detail.health.receipt.epoch }} · 映射
          {{ detail.health.receipt.mappingVersion }} · {{ detail.health.receipt.result }} · 水位
          {{ detail.health.receipt.watermark }} · {{ detail.health.receipt.note }}
        </p>
        <p v-else class="muted">当前代次还没有有效回执。</p>
      </section>

      <section class="detail-block">
        <h4>质量规则（按目标表名关联）</h4>
        <ul class="archive-list">
          <li v-for="rule in detail.qualityRules" :key="rule.rule" :class="rule.status === '已启用' && !rule.ok ? 'signal-bad' : 'muted'">
            {{ rule.rule }} · {{ rule.effectiveStatus }}
            <span v-if="rule.reasons.length">：{{ rule.reasons.join('；') }}</span>
          </li>
          <li v-if="!detail.qualityRules.length" class="muted">这张贴源表还没有关联质量规则。</li>
        </ul>
      </section>

      <section class="detail-block">
        <h4>回放批次核对（回看）</h4>
        <button class="btn ghost" type="button" @click="verifyReplay">核对回放批次</button>
        <p :class="detail.replay.ok ? 'signal-ok' : 'signal-bad'">
          {{ detail.replay.ok ? '一致' : '不一致' }}：贴源批次 {{ detail.replay.odsBatch || '空' }} /
          链路批次 {{ detail.replay.syncBatch || '空' }}（{{ detail.replay.linkedSync || '未关联链路' }}）
        </p>
        <p class="muted">{{ detail.replay.reason }} · 核对于 {{ detail.replay.checkedAt }}</p>
      </section>

      <section class="detail-block">
        <h4>动作与争抢记录</h4>
        <ul class="archive-list">
          <li v-for="event in detail.events" :key="event.id" :class="event.ok ? 'muted' : 'signal-bad'">
            {{ event.at }} · {{ event.tab }} · {{ event.action }} · {{ event.ok ? '成功' : '失败' }}：
            {{ event.message }}
            <span v-if="Object.keys(event.details).length" class="muted">
              （{{ Object.entries(event.details).map(([k, v]) => `${k}=${v}`).join('，') }}）
            </span>
          </li>
          <li v-if="!detail.events.length" class="muted">本标签页还没有相关动作记录。</li>
        </ul>
      </section>

      <section class="detail-block">
        <h4>回执历史与归档</h4>
        <ul class="archive-list">
          <li v-for="item in detail.history" :key="item.receipt.id">
            {{ item.receipt.id }} · 代次 {{ item.receipt.epoch }} · {{ item.receipt.result }} ·
            {{ item.receipt.watermark }} <span class="muted">（{{ item.reason }}）</span>
          </li>
          <li v-for="item in detail.archives" :key="`arc-${item.receipt.id}`" class="muted">
            归档 {{ item.receipt.id }} · 代次 {{ item.receipt.epoch }} · {{ item.receipt.result }} ·
            不覆盖新水位 <span>（{{ item.reason }}）</span>
          </li>
          <li v-if="!detail.history.length && !detail.archives.length" class="muted">暂无回执记录。</li>
        </ul>
      </section>
    </aside>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  currentTabId,
  downloadEntries,
  getOdsDetail,
  listOdsEntries,
  moduleMeta,
  runAction as applyAction,
  verifyOdsReplay,
} from '@/api/local-service'
import type { EntryRow, OdsDetail, OdsHealth } from '@/data/types'

const meta = moduleMeta('ods')
const columns = ["表编号", "源表名称", "目标表名", "同步模式", "字段映射", "字段映射版本", "源端连接", "回放批次"]
const actions = ["提交校验", "启用同步", "停用同步"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const statLabels = ["贴源表总数", "已启用表", "待校验表"]
const tabId = ref(currentTabId())

const rows = ref<EntryRow[]>([])
const healths = ref<OdsHealth[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["表编号", "源表名称", "源端连接"]
const detail = ref<OdsDetail | null>(null)

const stats = computed(() => [
  { label: statLabels[0], value: total.value },
  { label: statLabels[1], value: healths.value.filter((item) => item.enabledValid).length },
  { label: statLabels[2], value: rows.value.filter((row) => String(row.status) === '待校验').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function healthOf(row: EntryRow): OdsHealth {
  return (
    healths.value.find((item) => item.code === String(row['表编号'])) ?? {
      id: Number(row.id),
      code: String(row['表编号'] ?? ''),
      status: String(row.status),
      effectiveStatus: String(row.status),
      eligible: false,
      enabledValid: false,
      statusInvalid: false,
      epoch: 0,
      mappingVersion: '',
      watermark: '',
      replayBatch: '',
      replayState: '',
      sourceRef: '',
      sourceStatus: '',
      linkedSync: '',
      reasons: ['列表快照缺失'],
      token: null,
      receipt: null,
      archivedReceipts: 0,
    }
  )
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '贴源表登记入口尚未接入审批流'
}

function openDetail(code: string) {
  detail.value = getOdsDetail(code)
}

function verifyReplay() {
  if (!detail.value) return
  const result = verifyOdsReplay(detail.value.health.code)
  const extra = formatDetails(result)
  errorMessage.value = `${result.ok ? '' : `[${result.code ?? 'FAILED'}] `}${result.message}${
    extra ? `（${extra}）` : ''
  }`
  reload()
}

function closeDetail() {
  detail.value = null
}

function refreshDetail() {
  if (detail.value) {
    detail.value = getOdsDetail(detail.value.health.code)
  }
}

function formatDetails(result: { code?: string; details?: Record<string, unknown> }): string {
  if (!result.details) return ''
  return Object.entries(result.details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('，')
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  reload()
  refreshDetail()
  if (!result.ok) {
    // 败者要能核对：失败码 + 令牌号 / 持有者 / 代次 / 阻断项都一并显示
    const extra = formatDetails(result)
    errorMessage.value = `[${result.code ?? 'FAILED'}] ${result.message}${extra ? `（${extra}）` : ''}`
  }
}

function reload() {
  errorMessage.value = ''
  try {
    // 每次刷新都回源读 localStorage，列表与详情共用同一份 health 判定
    const payload = listOdsEntries(meta.key, filters.value)
    rows.value = payload.items
    healths.value = payload.healths
    total.value = payload.total
    refreshDetail()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '贴源层建模列表读取失败'
  }
}

onMounted(reload)
</script>
