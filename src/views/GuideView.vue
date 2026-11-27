<script setup lang="ts">
import { ref } from 'vue'
import { backupFileName, buildSiteBackup, importSiteBackup } from '@/lib/siteData'
import { downloadText, toast } from '@/lib/toast'

/**
 * 使用说明 / 数据备份。
 *
 * 这个工具的概念链是「卡组 → 实战录像 → 展开逻辑 → skill 包 → AI 代打」，
 * 新用户最容易卡在「没有录像就没有路线」这一步，所以按这条顺序写。
 * 底部的数据备份是全站唯一的出入口（API Key 与卡库缓存不在备份里）。
 */

const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function exportAll() {
  if (busy.value) return
  busy.value = true
  try {
    const backup = await buildSiteBackup()
    downloadText(backupFileName(), JSON.stringify(backup), 'application/json')
    toast('已导出全站数据（不含 API Key，可放心分享）')
  } catch (error) {
    toast(error instanceof Error ? error.message : '导出失败', true)
  } finally {
    busy.value = false
  }
}

function pickFile() {
  fileInput.value?.click()
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  const ok = window.confirm(
    '导入会覆盖本机现有的卡组、手坑配置、录像、skill 包与 AI 配置（API Key 保留）。确定继续？',
  )
  if (!ok) return

  busy.value = true
  try {
    const result = await importSiteBackup(await file.text())
    toast(`已导入 ${result.keys} 项配置、${result.replays} 份录像，即将刷新…`)
    window.setTimeout(() => window.location.reload(), 900)
  } catch (error) {
    toast(error instanceof Error ? error.message : '导入失败', true)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page guide">
    <header class="guide-head">
      <p class="guide-eyebrow">GUIDE · 先看这里</p>
      <h1 class="guide-title">使用说明</h1>
      <p class="guide-lead">
        这个工具把「卡组 → 实战录像 → 展开逻辑 → AI 代打」串成一条链。
        <b>路线不是手写的，而是从录像里读出来的</b>，所以没有录像就没有展开逻辑。
      </p>
      <nav class="guide-toc">
        <a href="#start">快速上手</a>
        <a href="#pages">功能导航</a>
        <a href="#ai">开启 AI</a>
        <a href="#data">数据与备份</a>
        <a href="#faq">常见问题</a>
      </nav>
    </header>

    <section id="start" class="panel">
      <div class="panel-head">
        <span class="panel-title">快速上手</span>
        <RouterLink class="btn xs ghost" to="/deck">从建卡组开始</RouterLink>
      </div>
      <div class="panel-body">
        <ol class="steps">
          <li class="step">
            <span class="step-no">1</span>
            <div>
              <h3>构筑卡组</h3>
              <p>检索卡牌或直接导入 .ydk，主卡组凑够 40~60 张。新卡 / 先行服卡搜不到时，用「自定义卡」手动录入。</p>
              <RouterLink class="step-link" to="/deck">卡组构建 →</RouterLink>
            </div>
          </li>
          <li class="step">
            <span class="step-no">2</span>
            <div>
              <h3>录一份实战并绑定到卡组</h3>
              <p>
                在「对战区」跑完一局后点「绑定到卡组」；也可以把别的客户端录的 .yrp
                直接导进「对战分析」。录像就是这套卡组的路线来源。
              </p>
              <RouterLink class="step-link" to="/duel">对战区 →</RouterLink>
            </div>
          </li>
          <li class="step">
            <span class="step-no">3</span>
            <div>
              <h3>看分析，确认路线</h3>
              <p>
                「对战分析」会按起手把录像挂到启动点，画出展开链、手坑命中和检索关系。
                手坑报告能看出第几步会吃灰流丽 / 无限泡影。
              </p>
              <RouterLink class="step-link" to="/skills">对战分析 →</RouterLink>
            </div>
          </li>
          <li class="step">
            <span class="step-no">4</span>
            <div>
              <h3>生成 skill 包</h3>
              <p>
                点「生成 skill 包」按录像推导分片文档；开了 AI 后还能点「AI 生成 skill 包」，
                让模型在此基础上补对局思路。生成的文件可以直接编辑、新增。
              </p>
              <RouterLink class="step-link" to="/skills">去生成 →</RouterLink>
            </div>
          </li>
        </ol>
        <p class="guide-note">
          启动率（先攻几成能动）在「启动率」页，选好卡组后按勾选的动点 / 废件计算。它不是必需步骤，但调构筑时很有用。
        </p>
      </div>
    </section>

    <section id="pages" class="panel">
      <div class="panel-head">
        <span class="panel-title">功能导航</span>
        <span class="chip-dim">每个页面负责什么</span>
      </div>
      <div class="panel-body">
        <div class="nav-grid">
          <div class="nav-item">
            <RouterLink to="/">首页</RouterLink>
            <p>入口页，只有状态数字和几个快捷入口。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/cards">卡牌检索</RouterLink>
            <p>查卡名、效果、种类；详情里能跳 ygocdb 看裁定。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/deck">卡组构建</RouterLink>
            <p>组卡、导入导出 .ydk、给自定义卡补卡图、导出竖版长图。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/rates">启动率</RouterLink>
            <p>算先攻手牌能不能动：动点、废件、抽滤都按配置统计。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/duel">对战区</RouterLink>
            <p>用真实规则引擎打一局；打完绑定成录像，也可以让 AI 代打。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/skills">对战分析</RouterLink>
            <p>录像列表、展开图、手坑报告、检索图，以及 skill 包的生成与编辑。</p>
          </div>
          <div class="nav-item">
            <RouterLink to="/ai">AI 设置</RouterLink>
            <p>AI 总开关、协议、接口地址、密钥、模型；关着时代打与 AI 生成都置灰。</p>
          </div>
        </div>
      </div>
    </section>

    <section id="ai" class="panel">
      <div class="panel-head">
        <span class="panel-title">开启 AI 代打</span>
        <RouterLink class="btn xs ghost" to="/ai">去设置</RouterLink>
      </div>
      <div class="panel-body">
        <ol class="steps steps-compact">
          <li class="step">
            <span class="step-no">1</span>
            <div>
              <h3>填连接信息</h3>
              <p>打开总开关，选协议（OpenAI 兼容 / Anthropic），填接口地址、密钥、模型名。密钥只存在本机浏览器。</p>
            </div>
          </li>
          <li class="step">
            <span class="step-no">2</span>
            <div>
              <h3>对战区里点「AI 代打」</h3>
              <p>AI 会先从起手规划整条路线，再照路线执行；被对手打断时重新规划。右侧「日志」能看到每一步的依据。</p>
            </div>
          </li>
          <li class="step">
            <span class="step-no">3</span>
            <div>
              <h3>随时接管回来</h3>
              <p>再点一次就交还给你；重新打开会接着原路线走，不会从头再来。</p>
            </div>
          </li>
        </ol>
        <p class="guide-note">
          AI 代打按钮是灰的，通常是「AI 设置」里总开关没开、密钥或模型名为空。
        </p>
      </div>
    </section>

    <section id="data" class="panel">
      <div class="panel-head">
        <span class="panel-title">数据与备份</span>
        <span class="chip-dim">全部存在本机浏览器</span>
      </div>
      <div class="panel-body">
        <p class="guide-lead">
          卡组、手坑配置、自定义卡、录像、skill 包、暂存与 AI 配置都存在你自己的浏览器里
          （IndexedDB + localStorage），没有服务端。换设备、换浏览器、清理站点数据都会丢，
          重要构筑建议导出一份。
        </p>
        <div class="data-actions">
          <button
            class="btn primary"
            :disabled="busy"
            title="导出卡组、录像、skill 包等全部数据；不含 API Key 与卡库缓存"
            @click="exportAll"
          >
            {{ busy ? '处理中…' : '导出全站数据' }}
          </button>
          <button class="btn" :disabled="busy" @click="pickFile">导入全站数据</button>
          <input
            ref="fileInput"
            class="hidden-file"
            type="file"
            accept=".json,application/json"
            @change="onFile"
          />
          <!-- 就放在按钮旁边：用户按下去之前就能看到，不用等导出完的 toast -->
          <span class="data-safe">不含 API Key，导出的文件可以直接分享</span>
        </div>
        <ul class="data-facts">
          <li><b>包含</b>：卡组、手坑配置、自定义卡、skill 包、暂存、主题、AI 配置、全部录像。导出一个 .json 文件。</li>
          <li><b>不包含 API Key</b>：备份里的密钥字段是空的，防止文件外传时泄漏；导入时也不会覆盖本机已有的密钥。</li>
          <li><b>不包含卡库缓存</b>：十几 MB，随时能从 ygocdb 重新下载，没必要塞进备份。</li>
          <li><b>导入是覆盖式</b>：同名配置直接替换，录像库整表重写；导入完成后页面会自动刷新。</li>
        </ul>
      </div>
    </section>

    <section id="faq" class="panel">
      <div class="panel-head">
        <span class="panel-title">常见问题</span>
      </div>
      <div class="panel-body">
        <dl class="faq">
          <div class="faq-item">
            <dt>搜不到某张新卡？</dt>
            <dd>卡库只有正式服数据。到「卡组构建」用「自定义卡」录入卡名、种类，可选填卡号与效果。</dd>
          </div>
          <div class="faq-item">
            <dt>生成的 skill 包里怎么没有某张卡？</dt>
            <dd>卡效切片只收录录像里真正出现过的卡——没出现过就不写，避免模型张冠李戴。</dd>
          </div>
          <div class="faq-item">
            <dt>对战分析提示「手坑分析已过期」？</dt>
            <dd>手坑判定规则升级了，旧结论不再可信。点「重新解析」重跑一遍录像（不会重新录制）。</dd>
          </div>
          <div class="faq-item">
            <dt>AI 生成 skill 包失败？</dt>
            <dd>
              先确认接口地址与模型名；网关不支持 JSON 模式时，在「AI 设置」里关掉它再试。
              返回空白正文多半是 JSON 模式或思考模式的影响。
            </dd>
          </div>
          <div class="faq-item">
            <dt>展开图里的手坑点对不上步骤？</dt>
            <dd>手坑点按事件流下标对齐，一般不会错位；如果整份录像都解析失败，展开图会提示缺数据。</dd>
          </div>
          <div class="faq-item">
            <dt>换电脑后怎么继续？</dt>
            <dd>旧电脑导出全站数据，新电脑打开本站导入同一个 .json，然后在「AI 设置」里重填 API Key。</dd>
          </div>
        </dl>
      </div>
    </section>
  </div>
</template>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.guide-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 2px 2px;
}

.guide-eyebrow {
  margin: 0;
  color: var(--text-mute);
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.guide-title {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
}

.guide-lead {
  margin: 0;
  max-width: 76ch;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.85;
}

.guide-toc {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.guide-toc a {
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-dim);
  font-size: 11px;
  transition: 0.16s ease;
}

.guide-toc a:hover {
  border-color: rgba(217, 185, 106, 0.45);
  color: var(--text);
}

.steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: flex;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(232, 224, 208, 0.015);
}

.step-no {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(217, 185, 106, 0.45);
  color: var(--gold);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 20px;
  text-align: center;
}

.step h3 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.step p {
  margin: 0;
  color: var(--text-mute);
  font-size: 12px;
  line-height: 1.75;
}

.step-link {
  display: inline-block;
  margin-top: 8px;
  color: var(--cyan);
  font-size: 11px;
}

.guide-note {
  margin: 12px 0 0;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.8;
}

.nav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px 18px;
}

.nav-item {
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
}

.nav-item a {
  color: var(--cyan);
  font-size: 13px;
  font-weight: 600;
}

.nav-item p {
  margin: 3px 0 0;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.7;
}

.steps-compact {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.data-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 14px 0 12px;
}

.data-safe {
  color: var(--green);
  font-size: 11px;
}

.hidden-file {
  display: none;
}

.data-facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.data-facts li {
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.8;
}

.data-facts b {
  color: var(--text-dim);
}

.faq {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px 22px;
  margin: 0;
}

.faq-item dt {
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}

.faq-item dd {
  margin: 4px 0 0;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.8;
}
</style>
