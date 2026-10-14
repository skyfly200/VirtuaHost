<template lang="pug">
  div
    v-row(align="center" class="mb-2")
      v-col
        .text-body-2.hint Announcements that play on their own. The server must be running at the time.
      v-col(cols="auto")
        v-btn(color="primary" depressed @click="creating = true")
          v-icon(left) mdi-plus
          | New schedule
    v-card(v-if="!loading && !items.length" class="empty" elevation="0")
      v-icon(size="48") mdi-calendar-blank-outline
      p No schedules yet.
    v-card.sched(v-for="s in items" :key="s.id" elevation="4" :class="{ off: !s.enabled }")
      v-card-text
        v-row(align="center")
          v-col(cols="12" md="5")
            .name {{ s.name }}
            .small {{ repeatText(s) }}
          v-col(cols="12" md="4")
            .small(v-if="s.enabled")
              v-icon(small left) mdi-clock-outline
              | Next: {{ s.nextAt | when }}
            .small(v-else) Finished or paused
            .small(v-if="s.lastResult") Last: {{ s.lastResult }}
          v-col(cols="auto" class="ml-auto")
            v-switch(:input-value="s.enabled" inset hide-details dense @change="toggle(s, $event)" aria-label="Enabled")
          v-col(cols="auto")
            v-btn(icon small @click="remove(s)" aria-label="Delete schedule")
              v-icon mdi-trash-can-outline
    ScheduleDialog(:open="creating" :source="null" @close="creating = false" @saved="load")
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';
  import ScheduleDialog from '../components/ScheduleDialog.vue';

  export default Vue.extend({
    name: 'Schedule',
    components: { ScheduleDialog },
    data: () => ({ items: [] as any[], loading: true, creating: false, timer: 0 }),
    filters: { when: (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },

    mounted() {
      this.load();
      this.timer = window.setInterval(this.load, 15000);
    },
    beforeDestroy() { window.clearInterval(this.timer); },

    methods: {
      async load() {
        try { this.items = (await api.get('/schedules')).data; } catch (e) { /* keep the last list */ } finally { this.loading = false; }
      },
      repeatText(s: any): string {
        if (!s.intervalSec) return 'Once';
        const mins = s.intervalSec / 60;
        const every = mins % 1440 === 0 ? `${mins / 1440} day(s)` : mins % 60 === 0 ? `${mins / 60} hour(s)` : `${mins} minute(s)`;
        return `Every ${every}${s.count ? `, ${s.runs} of ${s.count} runs` : `, ${s.runs} runs so far`}`;
      },
      async toggle(s: any, enabled: boolean) {
        try { await api.patch(`/schedules/${s.id}`, { enabled }); } catch (e) { notify(errorMessage(e), 'error'); }
        this.load();
      },
      async remove(s: any) {
        if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
        try { await api.delete(`/schedules/${s.id}`); this.load(); } catch (e) { notify(errorMessage(e), 'error'); }
      },
    },
  });
</script>

<style lang="scss" scoped>
.sched { border-radius: 16px !important; margin-bottom: 12px; &.off { opacity: 0.6; } }
.name { font-weight: 600; font-size: 1.05rem; }
.small { font-size: 0.85rem; opacity: 0.75; }
.hint { opacity: 0.7; }
.empty { text-align: center; padding: 48px 16px; opacity: 0.7; background: transparent !important; }
</style>
