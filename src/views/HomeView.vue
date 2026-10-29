<script setup lang="ts">
import { computed } from 'vue'
import { createSampleCombo } from '@/data/sampleCombo'
import { analyzeCombo } from '@/lib/timeline'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'

const cardStore = useCardStore()
const ht = useHandtrapStore()

const demoCombo = createSampleCombo()
const demo = demoCombo.lines[0]
const demoAnalysis = analyzeCombo(demo)

const highlightIds = ['maxx', 'fuwalos', 'droll', 'ash']
const highlights = computed(() =>
  highlightIds
    .map((id) => demoAnalysis.reports.find((report) => report.id === id))
    // 只展示真正吃到的手坑
    .filter(
      (report): report is NonNullable<typeof report> =>
        report !== undefined && report.sites.length > 0,
    ),
)

const ashReport = computed(() => demoAnalysis.reports.find((report) => report.id === 'ash'))
const drollReport = computed(() => demoAnalysis.reports.find((report) => report.id === 'droll'))
const maxxReport = computed(() => demoAnalysis.reports.find((report) => report.id === 'maxx'))

const demoNotes = computed(() => [
  `本线 ${demo.timings.length} 个时序之间自动连出 ${demoAnalysis.links.length} 条链，被无效的链会向下游传播。`,
  `「灰流丽」共 ${ashReport.value?.sites.length || 0} 个可命中点，最不利落点在第 ${(ashReport.value?.deadAt ?? 0) + 1} 时序。`,
  `「锁鸟」只封锁检索段：${drollReport.value?.deadAt != null ? `仍会在第 ${(drollReport.value?.deadAt ?? 0) + 1} 时序断链` : '检索段失效但主线可继续'}。`,
  `累计召唤 ${demoAnalysis.totalSummons} 只，陨石${demoAnalysis.totalSummons >= 5 ? '可触发' : '不可触发'}。`,
])

const statCards = computed(() => [
  { k: cardStore.status === 'ready' ? cardStore.cards.length.toLocaleString() : '14,000+', l: '中文卡池 · 本地索引' },
  { k: String(ht.defs.length), l: '常规手坑模型' },
  { k: 'C1 → Cn', l: '连锁按时序记录' },
  { k: '0', l: '后端依赖 · 纯前端推演' },
])
</script>

<template>
  <div class="page">
    <section class="hero">
      <span class="eyebrow">DUEL SANDBOX · 展开链推演</span>
      <h1>
        把展开流程<br />
        写成可<span class="accent">推演</span>的展开链
      </h1>
      <p class="hero-sub">
        不再用事件标签猜某个操作会不会吃坑。每个时序只记三件事：牌手 / 卡片操作、cost 与效果段、以及连锁。
        卡片移动会自动连成链，手坑直接标在链上，断在哪一环、波及到哪一步，一眼可见。
      </p>
      <div class="hero-actions">
        <RouterLink to="/lab" class="btn primary">进入展开工坊 →</RouterLink>
        <RouterLink to="/cards" class="btn">检索卡牌</RouterLink>
        <RouterLink to="/lab" class="btn ghost">查看示例推演</RouterLink>
      </div>

      <div class="stat-row">
        <div v-for="s in statCards" :key="s.l" class="stat">
          <div class="k">{{ s.k }}</div>
          <div class="l">{{ s.l }}</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>核心能力</h2>
          <p>时序、链路、区域账本三块拼在一起，才撑得住实战复盘。</p>
        </div>
      </div>
      <div class="feature-grid">
        <article class="feature">
          <div class="glow" />
          <div class="idx">01 / TIMING</div>
          <h3>按时序记录操作</h3>
          <p>一个时序就是一个时点：牌手操作、卡片操作、2 速以上的连锁按 C1 → Cn 顺序排列。</p>
          <ul>
            <li>覆盖通召 / 特召 / 盖放 / 发动卡片 / 发动效果</li>
            <li>连锁支持 C2 → Cn 多段，按顺序展示</li>
            <li>发动前的手卡、场上、墓地、除外、魔陷区随时可查</li>
          </ul>
        </article>
        <article class="feature">
          <div class="glow" />
          <div class="idx">02 / LINK</div>
          <h3>卡片移动自动连链</h3>
          <p>检索上来的卡在第 1 时序，第 4 时序才用上？系统会把这两步连起来，并记录这张卡送到了哪里。</p>
          <ul>
            <li>堆墓两张卡 → 两条独立的链，各自标记手坑</li>
            <li>上游链被无效，下游依赖它的时序一并断链</li>
            <li>链路跨时序追踪，不再逐步骤手写依赖</li>
          </ul>
        </article>
        <article class="feature">
          <div class="glow" />
          <div class="idx">03 / COST</div>
          <h3>cost 与效果分开</h3>
          <p>cost 必定成功、不吃任何手坑；只有效果段会被灰流丽、锁鸟、遮蒙这类手坑拦住。</p>
          <ul>
            <li>丢弃自身、解放、送墓作为 cost 时单独记录</li>
            <li>无效类手坑整段无效，封锁类只封被标记的段</li>
            <li>每段都能单独挂手坑，支持堆墓与检索不同待遇</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>示例推演 · {{ demoCombo.name }}</h2>
          <p>
            内置示例的实时结果{{ demo.goal ? `：${demo.goal}` : '' }}。进入工坊可以逐时序展开状态。
          </p>
        </div>
        <RouterLink to="/lab" class="btn sm">在工坊中打开 →</RouterLink>
      </div>

      <div class="panel">
        <div class="panel-body" style="display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 22px">
          <div>
            <div>
              <div class="label">示例线上吃到的手坑</div>
              <div class="inline-note" style="margin-top: 4px">
                {{ ashReport?.sites.length || 0 }} 个灰流丽命中点 · {{ demoAnalysis.links.length }} 条链路 ·
                陨石{{ demoAnalysis.totalSummons >= 5 ? '可触发' : '不可触发' }}
              </div>
            </div>

            <div style="margin-top: 18px">
              <div class="row" style="justify-content: space-between">
                <span class="label">增殖的G · 抽牌点</span>
                <span class="mono gold" style="font-size: 11.5px">+{{ maxxReport?.draws || 0 }} 张</span>
              </div>
              <div class="row wrap" style="gap: 5px; margin-top: 6px">
                <span v-for="index in maxxReport?.sites || []" :key="index" class="chip amber">
                  第 {{ index + 1 }} 时序 · {{ demo.timings[index]?.cardName }}
                </span>
                <span v-if="!maxxReport?.sites.length" class="inline-note">没有标记特召点</span>
              </div>
              <div class="inline-note" style="margin-top: 8px">
                {{ demo.timings.length }} 个时序，特殊召唤共 {{ demoAnalysis.totalSummons }} 次
              </div>
            </div>
          </div>

          <div>
            <div class="label" style="margin-bottom: 8px">关键手坑结论</div>
            <div class="threat-list">
              <div v-for="report in highlights" :key="report.id" class="threat" style="cursor: default">
                <span class="dot" :class="report.verdict" />
                <span class="name">{{ ht.map[report.id]?.name }}</span>
                <span class="res" :class="`tone-${report.verdict}`">{{ report.headline }}</span>
              </div>
            </div>
            <ul class="note-list">
              <li v-for="note in demoNotes" :key="note">{{ note }}</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>怎么用</h2>
          <p>三步进入推演状态，不需要注册，数据保存在本地浏览器。</p>
        </div>
      </div>
      <div class="feature-grid">
        <article class="feature">
          <div class="idx">STEP 1</div>
          <h3>录入起手与卡组</h3>
          <p>起手和卡组决定区域账本的初始状态，也是链路能否接上的依据。</p>
        </article>
        <article class="feature">
          <div class="idx">STEP 2</div>
          <h3>逐个时点记录</h3>
          <p>选操作、填 cost 与效果段、按需加连锁。每段可以单独标手坑。</p>
        </article>
        <article class="feature">
          <div class="idx">STEP 3</div>
          <h3>点手坑看断链</h3>
          <p>在右侧选一个手坑和一个命中时序，链路会实时重算，被波及的时序会标红。</p>
        </article>
      </div>
    </section>
  </div>
</template>
