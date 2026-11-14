<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标；贴源层资格信号、同步链路前置与质量规则上游一起核对。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section class="detail-block">
      <h4>贴源层启用资格信号</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>贴源表</th><th>登记状态</th><th>生效状态</th><th>代次</th><th>映射版本</th>
            <th>源端</th><th>回放批次</th><th>令牌</th><th>阻断原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="signal in odsSignals" :key="signal.code">
            <td>{{ signal.code }}</td>
            <td>{{ signal.status }}</td>
            <td :class="signal.statusInvalid ? 'signal-bad' : ''">{{ signal.effectiveStatus }}</td>
            <td>{{ signal.epoch }}</td>
            <td>{{ signal.mappingVersion }}</td>
            <td>{{ signal.sourceRef }} · {{ signal.sourceStatus }}</td>
            <td>{{ signal.replayBatch || '—' }}</td>
            <td>
              <template v-if="signal.token">{{ signal.token.id }} / {{ signal.token.holder }}</template>
              <span v-else class="muted">—</span>
            </td>
            <td :class="signal.reasons.length ? 'signal-bad' : 'signal-ok'">
              {{ signal.reasons.length ? signal.reasons.join('；') : '—' }}
            </td>
          </tr>
          <tr v-if="!odsSignals.length">
            <td colspan="9" class="empty-state">暂无贴源表数据</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="detail-block">
      <h4>阻断与告警</h4>
      <ul class="archive-list">
        <li v-for="alert in alerts" :key="`${alert.object}-${alert.message}`" :class="alert.level === 'error' ? 'signal-bad' : 'signal-warn'">
          [{{ alert.level }}] {{ alert.object }}：{{ alert.message }}
        </li>
        <li v-if="!alerts.length" class="muted">没有阻断项：贴源层资格、同步链路前置与质量规则上游均一致。</li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { OdsHealth, OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const odsSignals = ref<OdsHealth[]>([])
const alerts = ref<OverviewResult['alerts']>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  odsSignals.value = payload.odsSignals
  alerts.value = payload.alerts
}

onMounted(refresh)
</script>
