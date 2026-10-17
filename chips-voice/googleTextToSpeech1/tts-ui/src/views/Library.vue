<template lang="pug">
  div
    v-row(align="center" class="mb-2")
      v-col
        v-text-field(v-model="q" prepend-inner-icon="mdi-magnify" label="Search clips" outlined dense hide-details clearable @input="debouncedLoad")
      v-col(cols="auto")
        v-btn-toggle(v-model="favoritesOnly" dense rounded borderless)
          v-btn(:value="true" small)
            v-icon(small left) mdi-star
            | Favorites
    v-card(v-if="!loading && !clips.length" class="empty" elevation="0")
      v-icon(size="48") mdi-music-note-off-outline
      p Nothing here yet. Announcements you make are saved to the library so you can reuse them without paying for another voice call.
    v-row
      v-col(v-for="c in clips" :key="c.id" cols="12" md="6")
        v-card.clip(elevation="4")
          v-card-title.clip-title
            span.text {{ c.title }}
            v-spacer
            v-btn(icon small :color="c.favorite ? 'warning' : ''" @click="toggleFavorite(c)" :aria-label="c.favorite ? 'Remove from favorites' : 'Add to favorites'")
              v-icon {{ c.favorite ? 'mdi-star' : 'mdi-star-outline' }}
          v-card-text
            .said {{ c.text }}
            .meta
              v-chip(x-small label) {{ c.provider }}
              v-chip(v-if="c.external && c.source" x-small label) from {{ c.source }}
              v-chip(v-if="c.spec && c.spec.turns" x-small label color="secondary") dialogue
              v-chip(x-small label) {{ c.playCount }} plays
              v-chip(x-small label) {{ size(c.bytes) }}
              v-chip(v-if="!c.available" x-small label color="warning") will regenerate
              v-chip(v-if="c.cloud" x-small label color="success" @click="share = c")
                v-icon(x-small left) mdi-cloud-check-outline
                | in cloud
              v-chip(v-for="t in c.tags" :key="t" x-small outlined) {{ t }}
          v-card-actions
            v-btn(text small :loading="playing === c.id" @click="play(c)")
              v-icon(left small) mdi-bullhorn-outline
              | Announce
            v-btn(text small @click="share = c")
              v-icon(left small) mdi-share-variant-outline
              | Share
            v-btn(text small @click="scheduleFor = c")
              v-icon(left small) mdi-clock-outline
              | Schedule
            v-spacer
            v-btn(icon small @click="edit(c)" aria-label="Edit")
              v-icon(small) mdi-pencil-outline
            v-btn(icon small @click="remove(c)" aria-label="Delete")
              v-icon(small) mdi-trash-can-outline

    v-dialog(v-model="editing" max-width="420")
      v-card(v-if="draft")
        v-card-title Edit clip
        v-card-text
          v-text-field(v-model="draft.title" label="Title" outlined dense)
          v-combobox(v-model="draft.tags" label="Tags" multiple chips small-chips deletable-chips outlined dense hide-details)
        v-card-actions
          v-spacer
          v-btn(text @click="editing = false") Cancel
          v-btn(color="primary" depressed @click="saveEdit") Save

    ShareDialog(:clip="share" @close="share = null" @changed="load")
    ScheduleDialog(:open="!!scheduleFor" :source="scheduleSource" @close="scheduleFor = null" @saved="$emit('scheduled')")
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';
  import ShareDialog from '../components/ShareDialog.vue';
  import ScheduleDialog from '../components/ScheduleDialog.vue';

  export default Vue.extend({
    name: 'Library',
    components: { ShareDialog, ScheduleDialog },

    data: () => ({
      clips: [] as any[],
      q: '',
      favoritesOnly: undefined as boolean | undefined,
      loading: true,
      playing: '',
      share: null as any,
      scheduleFor: null as any,
      editing: false,
      draft: null as any,
      timer: 0,
    }),

    computed: {
      scheduleSource(): any {
        const c = this.scheduleFor;
        return c ? { clipId: c.id, title: c.title } : null;
      },
    },

    watch: { favoritesOnly() { this.load(); } },
    mounted() { this.load(); },

    methods: {
      debouncedLoad() {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(this.load, 250);
      },
      async load() {
        try {
          const params: any = {};
          if (this.q) params.q = this.q;
          if (this.favoritesOnly) params.favorite = true;
          this.clips = (await api.get('/clips', { params })).data;
          if (this.share) this.share = this.clips.find((c) => c.id === this.share.id) || this.share;
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.loading = false;
        }
      },
      size(bytes: number) { return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`; },
      async play(c: any) {
        this.playing = c.id;
        try {
          const { data } = await api.post(`/clips/${c.id}/play`, {});
          if (data.played === false) notify(`Not played: ${data.reason}`, 'warning'); else notify('Sent to the stream', 'success');
          this.load();
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.playing = '';
        }
      },
      async toggleFavorite(c: any) {
        try { await api.patch(`/clips/${c.id}`, { favorite: !c.favorite }); this.load(); } catch (e) { notify(errorMessage(e), 'error'); }
      },
      edit(c: any) {
        this.draft = { id: c.id, title: c.title, tags: [...c.tags] };
        this.editing = true;
      },
      async saveEdit() {
        try {
          await api.patch(`/clips/${this.draft.id}`, { title: this.draft.title, tags: this.draft.tags });
          this.editing = false;
          this.load();
        } catch (e) { notify(errorMessage(e), 'error'); }
      },
      async remove(c: any) {
        if (!window.confirm(`Delete "${c.title}"? Schedules using it will stop working.`)) return;
        try { await api.delete(`/clips/${c.id}`); this.load(); } catch (e) { notify(errorMessage(e), 'error'); }
      },
    },
  });
</script>

<style lang="scss" scoped>
.clip { border-radius: 16px !important; height: 100%; display: flex; flex-direction: column; }
.clip-title .text { font-size: 1.05rem; font-weight: 600; word-break: break-word; }
.said { opacity: 0.85; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.meta .v-chip { margin: 0 4px 4px 0; }
.empty { text-align: center; padding: 48px 16px; opacity: 0.7; background: transparent !important; }
</style>
