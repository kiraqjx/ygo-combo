import { createRouter, createWebHistory } from 'vue-router'

/**
 * 已封存（代码保留，暂不对外暴露）：
 *
 *   views/LabView.vue          combo 工坊主界面
 *   components/TimingTimeline  / TimingEditor / ChainEditor / MoveRows
 *   components/ResistancePanel / DeckSidebar / ComboCards / HandtrapEditor
 *   stores/combos.ts · stores/handtraps.ts
 *   lib/timeline.ts · lib/infer.ts · lib/handtraps.ts
 *
 * 这些文件一字未删，重新挂一条 `/lab` 路由即可恢复。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/cards', name: 'cards', component: () => import('@/views/CardsView.vue') },
    { path: '/deck', name: 'deck', component: () => import('@/views/DeckView.vue') },
    { path: '/rates', name: 'rates', component: () => import('@/views/RatesView.vue') },
    { path: '/duel', name: 'duel', component: () => import('@/views/DuelView.vue') },
    { path: '/skills', name: 'skills', component: () => import('@/views/SkillsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

export default router
