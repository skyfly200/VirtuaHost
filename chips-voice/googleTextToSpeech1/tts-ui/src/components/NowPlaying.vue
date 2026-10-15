<template lang="pug">
  v-card.now-playing(:class="{ 'is-live': live }" elevation="6")
    .hero
      .status-row
        v-chip(small label :color="status.color" :class="{ pulse: live }")
          v-icon(left small) {{ status.icon }}
          | {{ status.text }}
        span.listeners
          v-icon(small) mdi-headphones
          |  {{ listeners }} listening
      .eq(:class="{ paused: !playing }")
        span(v-for="n in 7" :key="n")
      .track {{ title || (offline ? 'Cannot reach the station' : 'Nothing playing') }}
      .note(v-if="live") The live DJ is on air. Skip and volume control the auto-DJ.
    v-card-text.controls
      .row
        v-btn(fab depressed color="primary" :loading="skipping" :disabled="offline" @click="skip" aria-label="Skip track")
          v-icon mdi-skip-next
        v-slider(
          v-model="volume" prepend-icon="mdi-volume-high" min="0" max="100" hide-details
          :disabled="offline" @change="setVolume" aria-label="Music volume"
        )
      .label Playlist
      v-chip-group(v-model="playlist" mandatory active-class="primary--text" @change="setPlaylist")
        v-chip(v-for="p in playlists" :key="p.value" :value="p.value" outlined filter :disabled="offline") {{ p.text }}
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';

  export default Vue.extend({
    name: 'NowPlaying',

    data: () => ({
      title: '' as string | null,
      listeners: 0,
      live: false,
      offline: false,
      volume: 100,
      playlist: '',
      appliedPlaylist: '',
      playlists: [{ text: 'All music', value: '' }] as Array<{ text: string; value: string }>,
      skipping: false,
      timer: 0,
    }),

    computed: {
      playing(): boolean { return !this.offline && !!this.title; },
      status(): { text: string; color: string; icon: string } {
        if (this.offline) return { text: 'OFFLINE', color: 'grey', icon: 'mdi-cloud-off-outline' };
        if (this.live) return { text: 'LIVE DJ', color: 'error', icon: 'mdi-microphone' };
        return { text: 'AUTO-DJ', color: 'success', icon: 'mdi-radio-tower' };
      },
    },

    mounted() {
      this.refresh();
      this.timer = window.setInterval(this.refresh, 10000);
      api.get('/music/playlists')
        .then(({ data }) => {
          this.playlists = [{ text: 'All music', value: '' }, ...data.map((n: string) => ({ text: n, value: n }))];
        })
        .catch(() => { /* the card stays usable without playlists */ });
    },

    beforeDestroy() {
      window.clearInterval(this.timer);
    },

    methods: {
      async refresh() {
        try {
          const { data } = await api.get('/music/now');
          this.title = data.title;
          this.listeners = data.listeners;
          this.live = !!data.live;
          this.offline = false;
        } catch (e) {
          this.offline = true;
        }
      },
      async skip() {
        this.skipping = true;
        try {
          await api.post('/music/skip');
          setTimeout(this.refresh, 1500);
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.skipping = false;
        }
      },
      setVolume(v: number) {
        api.post('/music/volume', { volume: v / 100 }).catch((e) => notify(errorMessage(e), 'error'));
      },
      setPlaylist(selected: string | null | undefined) {
        // The chip group also emits when it first mounts (with null or undefined for the
        // "all music" chip); only act on real changes.
        const name = selected || '';
        if (name === this.appliedPlaylist) return;
        this.appliedPlaylist = name;
        api.post('/music/playlist', { name })
          .then(() => notify(name ? `Playlist: ${name}` : 'Playing all music', 'success'))
          .catch((e) => notify(errorMessage(e), 'error'));
      },
    },
  });
</script>

<style lang="scss" scoped>
.now-playing { border-radius: 20px !important; overflow: hidden; }
.hero {
  position: relative;
  padding: 24px 24px 20px;
  background: linear-gradient(135deg, #5b4bff 0%, #8b7cff 45%, #22d3ee 120%);
  color: #fff;
  transition: background 0.4s;
}
.is-live .hero { background: linear-gradient(135deg, #be123c 0%, #fb7185 60%, #f59e0b 130%); }
.status-row { display: flex; justify-content: space-between; align-items: center; }
.listeners { opacity: 0.9; font-size: 0.85rem; }
.track { font-size: 1.5rem; font-weight: 600; line-height: 1.25; letter-spacing: -0.3px; margin-top: 8px; word-break: break-word; }
.note { margin-top: 8px; font-size: 0.85rem; opacity: 0.9; }
.eq {
  display: flex; align-items: flex-end; gap: 4px; height: 36px; margin-top: 20px;
  span {
    width: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.85);
    animation: bounce 1.1s ease-in-out infinite;
    &:nth-child(2) { animation-delay: -0.9s; }
    &:nth-child(3) { animation-delay: -0.6s; }
    &:nth-child(4) { animation-delay: -0.3s; }
    &:nth-child(5) { animation-delay: -0.75s; }
    &:nth-child(6) { animation-delay: -0.45s; }
    &:nth-child(7) { animation-delay: -0.15s; }
  }
  &.paused span { animation: none; height: 4px; opacity: 0.5; }
}
@keyframes bounce { 0%, 100% { height: 6px; } 50% { height: 34px; } }
.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.6); } 50% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0); } }
.controls { padding: 20px 24px 24px; }
.row { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.6; margin-bottom: 4px; }
@media (prefers-reduced-motion: reduce) { .eq span, .pulse { animation: none; } }
</style>
