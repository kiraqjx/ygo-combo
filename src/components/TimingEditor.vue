<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CardData, CardMove, Timing, ZoneId } from '@/types'
import { OPERATION_DEFS, POSITION_LABELS, ZONE_LABELS, ZONE_ORDER } from '@/types'
import { autoRuleMoves, inferTiming, materialCount, reuseAutoIds, uid, type RuleMoves } from '@/lib/infer'
import { useCardStore } from '@/stores/cards'
import { useComboStore } from '@/stores/combos'
import { useHandtrapStore } from '@/stores/handtraps'
import { cardImageUrl } from '@/lib/cardDb'
import CardPicker from './CardPicker.vue'
import MoveRows from './MoveRows.vue'

const props = defineProps<{ timing: Timing | null }>()
const emit = defineEmits<{ close: []; save: [timing: Timing]; remove: [id: string] }>()

type Category = 'player' | 'card'

const store = useCardStore()
const comboStore = useComboStore()
const ht = useHandtrapStore()
const showPicker = ref(false)
const hints = ref<string[]>([])

function blank(): Timing {
  return {
    id: uid(),
    operation: 'normalSummon',
    cardName: '',
    from: 'hand',
    setup: [],
    cost: [],
    effect: [],
    settle: [],
    chains: [],
    handtraps: [],
    note: '',
  }
}

function categoryOf(operation?: Timing['operation']): Category | null {
  if (!operation) return null
  return OPERATION_DEFS.find((def) => def.id === operation)?.kind ?? null
}

const draft = ref<Timing>(props.timing ? JSON.parse(JSON.stringify(props.timing)) : blank())
const category = ref<Category | null>(props.timing ? categoryOf(props.timing.operation) : null)

watch(
  () => props.timing,
  (value) => {
    draft.value = value ? JSON.parse(JSON.stringify(value)) : blank()
    category.value = value ? categoryOf(value.operation) : null
    hints.value = []
  },
)

const isNew = computed(() => !props.timing)
/** 优先用 cardId 查卡；手输卡名时按名字回查卡种 */
const card = computed(
  () => store.getCard(draft.value.cardId) || store.getCardByName(draft.value.cardName),
)
const zones: ZoneId[] = ZONE_ORDER
/** 只有"卡片操作"必须指明是哪张卡；牌手操作可以只记动作 */
const requiresCard = computed(() => category.value === 'card')
const canSave = computed(
  () => Boolean(category.value) && (!requiresCard.value || Boolean(draft.value.cardName.trim())),
)

/** 牌手操作：召唤 / 盖放 / 发动卡片 / 抽卡；卡片操作：发动效果 / 支付 cost */
const CATEGORY_META: Record<Category, { title: string; desc: string; examples: string }> = {
  player: {
    title: '牌手操作',
    desc: '玩家主动执行的动作',
    examples: '通常召唤 · 特殊召唤 · 盖放卡片 · 发动魔法/陷阱 · 抽卡',
  },
  card: {
    title: '卡片操作',
    desc: '由卡片自身产生的处理',
    examples: '发动卡片效果（怪兽 / 墓地）· 支付 cost',
  },
}

const CATEGORIES: Category[] = ['player', 'card']
const categoryOps = computed(() => OPERATION_DEFS.filter((def) => def.kind === category.value))

function chooseCategory(next: Category) {
  category.value = next
  const first = OPERATION_DEFS.find((def) => def.kind === next)
  if (first) draft.value.operation = first.id
  if (next === 'card' && draft.value.from === 'hand') draft.value.from = 'field'
}

function pickCard(target: CardData) {
  // 操作类型与区域完全沿用用户的选择，只按卡名 / 卡种补默认的规则与效果段
  const inferred = inferTiming(target, { kind: category.value || undefined })
  draft.value = {
    ...draft.value,
    cardId: target.id,
    cardName: target.name,
    setup: inferred.setup,
    cost: inferred.cost,
    effect: inferred.effect,
    settle: inferred.settle,
  }
  // 还没选过操作类别时（正常流程不会走到），才采用推断结果
  if (!category.value) {
    const targetCategory = categoryOf(inferred.operation)
    if (targetCategory) category.value = targetCategory
    draft.value.operation = inferred.operation
    draft.value.from = inferred.from
  }
  hints.value = inferred.hints
  showPicker.value = false
  // 规则段按用户选定的操作 / 区域重算，手写的效果段保留
  regenerateAuto(false)
}

/** 规则自动生成的移动（phase === 'auto' 或带 auto 标记） */
const isAutoMove = (move: CardMove) => move.auto === true || move.phase === 'auto'
const keepManual = (moves: CardMove[]) => moves.filter((move) => !isAutoMove(move))



/* ------------------------------------------------------------------ */
/* 跨时序连线：手动指定这张卡是哪一步送上来的                              */
/* ------------------------------------------------------------------ */

interface UpstreamOption {
  key: string
  label: string
}

const upstreamOptions = computed<UpstreamOption[]>(() => {
  const timings = comboStore.line?.timings || []
  const selfIndex = timings.findIndex((item) => item.id === draft.value.id)
  const scope = selfIndex < 0 ? timings : timings.slice(0, selfIndex)
  const out: UpstreamOption[] = []

  scope.forEach((timing, index) => {
    const moves: CardMove[] = [...timing.setup, ...timing.cost, ...timing.effect, ...timing.settle]
    for (const chain of timing.chains) {
      moves.push(...(chain.setup || []), ...chain.cost, ...chain.effect, ...(chain.settle || []))
    }
    for (const move of moves) {
      if (!move.cardName) continue
      out.push({
        key: `${timing.id}:${move.id}`,
        label: `第 ${index + 1} 时序「${timing.cardName || timing.label || '未命名'}」· ${move.cardName
          } ${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}`,
      })
    }
  })

  return out
})

const linkKey = computed({
  get: () => {
    const first = draft.value.manualLinks?.[0]
    return first ? `${first.fromTimingId}:${first.fromMoveId}` : ''
  },
  set: (value: string) => {
    if (!value) {
      draft.value.manualLinks = []
      return
    }
    const [fromTimingId, fromMoveId] = value.split(':')
    draft.value.manualLinks = [{ id: uid(), fromTimingId, fromMoveId }]
  },
})

/** 发动 / 发动效果类时序才显示规则处理段 */
const isActivation = computed(
  () => draft.value.operation === 'activate' || draft.value.operation === 'activateEffect',
)
/** 召唤 / 盖放类操作同样有必定发生的处理（素材、置入、结算去向），要给牌手留出配置入口 */
const SUMMON_OPS: Timing['operation'][] = ['normalSummon', 'tributeSummon', 'specialSummon', 'set']
const isSummonOp = computed(() => SUMMON_OPS.includes(draft.value.operation))
const isSpellTrapCard = computed(
  () => card.value?.frame === 'spell' || card.value?.frame === 'trap',
)
/** 前置处理段：发动置入 / 召唤素材 / 其他强制处理 */
const showSetupAuto = computed(
  () => isActivation.value || isSummonOp.value || draft.value.setup.length > 0,
)
/** 结算后去向只对发动类操作有意义，召唤类只在已有行时显示 */
const showSettleAuto = computed(() => isActivation.value || draft.value.settle.length > 0)
const setupTitle = computed(() => {
  if (isActivation.value || (draft.value.operation === 'specialSummon' && isSpellTrapCard.value)) {
    return '规则处理 · 发动置入（必定发生）'
  }
  if (draft.value.operation === 'specialSummon' && draft.value.from === 'extra') {
    return '规则处理 · 召唤素材（必定发生）'
  }
  return '规则处理 · 前置处理（必定发生）'
})

function describeRules(rules: RuleMoves): string[] {
  const out: string[] = []
  const materials = rules.setup.filter((move) => move.to !== 'st')
  if (rules.setup.length > materials.length) out.push('发动时置入魔陷区')
  if (materials.length) {
    const move = materials[0]
    const need = materialCount(card.value)
    const tail =
      move.to === 'material' ? '叠在这只怪兽下面' : '一行一张，可改成除外 / 超量素材'
    out.push(
      `已生成召唤素材：${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}（通常需 ${need} 只，${tail}）`,
    )
  }
  const detach = rules.cost.filter((move) => move.from === 'material')
  if (detach.length) out.push('超量怪兽发动效果：取除素材已记入 cost')
  if (draft.value.operation === 'tributeSummon' && rules.cost.length) out.push('祭品解放已记入 cost')
  if (rules.effect.length) {
    const move = rules.effect[0]
    const position = move.position && move.position !== 'attack' ? `（${POSITION_LABELS[move.position]}）` : ''
    out.push(`已生成主移动：${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}${position}`)
  }
  if (rules.settle.some((move) => move.to === 'extra')) out.push('结算后表侧加入额外卡组')
  else if (rules.settle.length) out.push('结算后送去墓地')
  else if (
    (isActivation.value || draft.value.operation === 'specialSummon') &&
    (card.value?.frame === 'spell' || card.value?.frame === 'trap')
  ) {
    out.push('结算后留场（永续 / 装备 / 场地）')
  }
  if (!out.length) out.push('本操作没有必定发生的规则移动，可直接手填')
  return out
}

/** 重新计算规则处理段：只替换自动生成的行，用户手写的一律保留 */
function regenerateAuto(showHints = true) {
  if (!draft.value.cardName.trim()) {
    if (showHints) hints.value = ['先选择卡片，才能按卡种判断规则处理']
    return
  }
  const rules = autoRuleMoves({
    operation: draft.value.operation,
    card: card.value,
    cardName: draft.value.cardName.trim(),
    from: draft.value.from,
  })
  // 规则移动排在前面，用户手写的段跟在后面
  draft.value.setup = reuseAutoIds([...rules.setup, ...keepManual(draft.value.setup)], draft.value.setup)
  draft.value.cost = reuseAutoIds([...rules.cost, ...keepManual(draft.value.cost)], draft.value.cost)
  draft.value.effect = reuseAutoIds(
    [...rules.effect, ...keepManual(draft.value.effect)],
    draft.value.effect,
  )
  draft.value.settle = reuseAutoIds(
    [...rules.settle, ...keepManual(draft.value.settle)],
    draft.value.settle,
  )
  if (showHints) hints.value = describeRules(rules)
}

/** 切换操作 / 起始区域 / 卡片时静默重算，不覆盖选卡时给出的推断提示 */
watch(
  () => [draft.value.operation, draft.value.from, draft.value.cardName] as const,
  () => {
    if (!draft.value.cardName.trim()) return
    regenerateAuto(false)
  },
)

function toggleTimingHandtrap(id: string) {
  const set = new Set(draft.value.handtraps || [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  draft.value.handtraps = [...set]
}

function save() {
  if (!canSave.value) return
  if (!draft.value.cardName.trim()) delete draft.value.cardId
  emit('save', JSON.parse(JSON.stringify(draft.value)))
  emit('close')
}

const thumb = computed(() => (draft.value.cardId ? cardImageUrl(draft.value.cardId) : ''))
const toneStyle = (id: string) => {
  const tone = ht.map[id]?.tone || '#9ea7b3'
  return { color: tone, borderColor: `${tone}55`, background: `${tone}14` }
}
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal timing-editor">
      <div class="modal-head">
        <div>
          <div style="font-size: 14px; font-weight: 600">{{ isNew ? '添加时序' : '编辑时序' }}</div>
          <div class="inline-note">
            {{ category ? '这里只配置主操作；连锁保存后在卡片上追加' : '先选择这一步是牌手操作还是卡片操作' }}
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <!-- 第一步：先选操作来源 -->
        <div v-if="!category" class="op-choice">
          <button v-for="key in CATEGORIES" :key="key" class="op-choice-card" @click="chooseCategory(key)">
            <span class="op-choice-title">{{ CATEGORY_META[key].title }}</span>
            <span class="op-choice-desc">{{ CATEGORY_META[key].desc }}</span>
            <span class="op-choice-examples">{{ CATEGORY_META[key].examples }}</span>
            <span class="op-choice-go">选择 →</span>
          </button>
        </div>

        <template v-else>
          <div class="category-bar">
            <span class="chip" :class="category === 'player' ? 'gold' : 'violet'">
              {{ CATEGORY_META[category].title }}
            </span>
            <span class="mute" style="font-size: 10.5px">{{ CATEGORY_META[category].desc }}</span>
            <span class="grow" />
            <button class="btn xs ghost" @click="category = null">上一步</button>
          </div>

          <div class="row" style="gap: 12px; align-items: flex-start; margin-top: 10px">
            <button class="btn ghost" style="padding: 6px; width: 68px; height: 94px; overflow: hidden; flex: none"
              @click="showPicker = true">
              <img v-if="thumb" :src="thumb" :alt="draft.cardName" style="width: 100%; border-radius: 6px" />
              <span v-else style="font-size: 11px; color: var(--text-mute)">选择卡片</span>
            </button>
            <div class="grow">
              <div class="label">
                {{ requiresCard ? '主卡 / 操作对象' : '操作对象（可选）' }}
              </div>
              <div class="row" style="margin-top: 5px; gap: 6px">
                <input v-model="draft.cardName" class="input"
                  :placeholder="requiresCard ? '卡片名称' : '留空则只记录动作，例如「抽卡」'" />
                <button class="btn sm" @click="showPicker = true">选择</button>
              </div>
              <div class="inline-note" style="margin-top: 5px">
                {{ card ? card.typeLine : requiresCard ? '发动卡片效果需要指明具体卡片' : '牌手操作可以只记动作，之后用效果段记录涉及哪些卡' }}
              </div>
            </div>
          </div>

          <div class="divider" />

          <div class="timing-form-grid">
            <div class="field">
              <label>操作类型</label>
              <select v-model="draft.operation" class="select">
                <option v-for="def in categoryOps" :key="def.id" :value="def.id">{{ def.label }}</option>
              </select>
            </div>
            <div class="field">
              <label>主卡所在区域</label>
              <select v-model="draft.from" class="select">
                <option v-for="zone in zones" :key="zone" :value="zone">{{ ZONE_LABELS[zone] }}</option>
              </select>
            </div>
            <div class="field" style="grid-column: span 2">
              <label>来源：这张卡由哪一步送上来的</label>
              <select v-model="linkKey" class="select">
                <option value="">不指定 / 起手已有</option>
                <option v-for="opt in upstreamOptions" :key="opt.key" :value="opt.key">
                  {{ opt.label }}
                </option>
              </select>
              <div class="inline-note" style="margin-top: 4px">
                {{
                  upstreamOptions.length
                    ? '指定后会在时间线上画一条连线，标注检索 / 堆墓 / 特召以及那一段吃的手坑'
                    : '先在前面的时序里配置效果段，这里就会出现可选的来源'
                }}
              </div>
            </div>
            <div class="field" style="grid-column: span 2">
              <label>时序标题（可选）</label>
              <input v-model="draft.label" class="input" placeholder="留空则用「操作 · 卡名」" />
            </div>
          </div>

          <div v-if="hints.length" class="row wrap" style="gap: 5px; margin-top: 8px">
            <span v-for="hint in hints" :key="hint" class="chip violet">{{ hint }}</span>
          </div>

          <div class="divider" />

          <template v-if="showSetupAuto">
            <div class="row" style="align-items: center; gap: 8px; margin-bottom: 6px">
              <div class="label" style="margin: 0">{{ setupTitle }}</div>
              <span class="grow" />
              <button class="btn xs ghost" @click="regenerateAuto()">重新生成</button>
            </div>
            <MoveRows v-model="draft.setup" phase="auto" :operation="draft.operation" :from="draft.from" />
            <div v-if="draft.operation === 'specialSummon'" class="inline-note" style="margin-top: 4px">
              {{
                draft.from === 'extra'
                  ? '额外卡组召唤的素材记在这里：一行一张，区域可改成墓地 / 除外 / 超量素材；多只素材点「＋ 处理段」继续加。'
                  : '特殊召唤的素材 / 解放 / 强制处理也记在这里：必定发生，不吃手坑。'
              }}
            </div>

            <div class="divider" />
          </template>

          <div class="label" style="margin-bottom: 6px">cost（必定成功，不吃手坑）</div>
          <MoveRows v-model="draft.cost" phase="cost" :operation="draft.operation" :from="draft.from" />

          <div class="divider" />

          <div class="label" style="margin-bottom: 6px">效果段（按结算顺序，可逐段标手坑）</div>
          <MoveRows v-model="draft.effect" phase="effect" :operation="draft.operation" :from="draft.from" />
          <div
            v-if="draft.operation === 'specialSummon' && draft.from === 'extra'"
            class="inline-note"
            style="margin-top: 4px"
          >
            在超量怪兽上叠放：给召唤这一行勾选「叠放」；叠谁看规则处理段的「旧怪兽 → 超量素材」行（或该格位上的怪兽），格位填新怪兽要放的位置。旧怪兽送墓，素材由新怪兽继承。
          </div>

          <template v-if="showSettleAuto">
            <div class="divider" />

            <div class="label" style="margin-bottom: 6px">规则处理 · 结算后去向（去墓地 / 额外，或留场）</div>
            <MoveRows v-model="draft.settle" phase="auto" :operation="draft.operation" :from="draft.from" />
          </template>

          <div class="divider" />

          <div class="label" style="margin-bottom: 6px">时序级响应（不挂在某一段上的手坑）</div>
          <div class="row wrap" style="gap: 5px">
            <button v-for="def in ht.defs" :key="def.id" class="chip clickable"
              :class="{ on: draft.handtraps?.includes(def.id) }"
              :style="draft.handtraps?.includes(def.id) ? toneStyle(def.id) : undefined"
              @click="toggleTimingHandtrap(def.id)">
              {{ def.name }}
            </button>
          </div>

          <div class="divider" />

          <div class="inline-note">
            连锁不在这里配置：保存后回到时序卡片，在卡片上点「＋ 追加连锁」逐条添加。
          </div>

          <div class="divider" />

          <div class="field">
            <label>备注</label>
            <textarea v-model="draft.note" class="textarea" placeholder="例如：这张卡是第 2 时序检索上来的；灰流丽无效整段效果" />
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <button v-if="!isNew" class="btn danger" @click="emit('remove', draft.id); emit('close')">删除此时序</button>
        <span class="grow" />
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!canSave" @click="save">保存时序</button>
      </div>
    </div>

    <CardPicker v-if="showPicker" title="选择时序主卡" @close="showPicker = false" @pick="pickCard" />
  </div>
</template>
