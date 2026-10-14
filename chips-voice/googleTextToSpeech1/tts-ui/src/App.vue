<template lang="pug">
  v-app
    Login(v-if="!loggedIn")
    template(v-else)
      v-app-bar(app flat color="transparent" class="topbar" extension-height="48")
        v-avatar(size="36" color="primary" class="mr-3")
          v-icon(dark) mdi-radio-tower
        v-toolbar-title.brand Chips Voice
        v-spacer
        v-btn(icon @click="toggleTheme" :aria-label="dark ? 'Switch to light theme' : 'Switch to dark theme'")
          v-icon {{ dark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}
        v-menu(offset-y left)
          template(v-slot:activator="{ on, attrs }")
            v-btn(icon v-bind="attrs" v-on="on" aria-label="Account")
              v-icon mdi-account-circle-outline
          v-list(dense)
            v-list-item(disabled)
              v-list-item-title Signed in as {{ user }}
            v-divider
            v-list-item(@click="logout")
              v-list-item-icon
                v-icon mdi-logout
              v-list-item-title Sign out
        template(v-slot:extension)
          v-tabs(v-model="tab" background-color="transparent" centered grow)
            v-tab
              v-icon(left small) mdi-radio-tower
              | On air
            v-tab
              v-icon(left small) mdi-bookshelf
              | Library
            v-tab
              v-icon(left small) mdi-calendar-clock
              | Schedule
      v-main
        v-container.page
          v-tabs-items(v-model="tab" class="transparent-items")
            v-tab-item
              v-row
                v-col(cols="12" md="5")
                  NowPlaying
                v-col(cols="12" md="7")
                  Composer(@scheduled="tab = 2")
            v-tab-item
              Library(v-if="tab === 1" @scheduled="tab = 2")
            v-tab-item
              Schedule(v-if="tab === 2")
    v-snackbar(v-model="toast.show" :color="toast.color" timeout="4000" bottom right) {{ toast.text }}
      template(v-slot:action="{ attrs }")
        v-btn(text v-bind="attrs" @click="toast.show = false") Close
</template>

<script lang="ts">
import Vue from 'vue';
import Login from './views/Login.vue';
import NowPlaying from './components/NowPlaying.vue';
import Composer from './components/Composer.vue';
import Library from './views/Library.vue';
import Schedule from './views/Schedule.vue';
import { loadInfo } from './providers';
import { session, clearSession } from './session';
import { toast } from './notify';

export default Vue.extend({
  name: 'App',

  components: { Login, NowPlaying, Composer, Library, Schedule },

  data: () => ({ toast, tab: 0 }),

  computed: {
    loggedIn(): boolean { return !!session.token; },
    user(): string { return session.user; },
    dark(): boolean { return (this as any).$vuetify.theme.dark; },
  },

  watch: {
    loggedIn: { immediate: true, handler(now: boolean) { if (now) loadInfo(); } },
  },

  methods: {
    toggleTheme() {
      const next = !(this as any).$vuetify.theme.dark;
      (this as any).$vuetify.theme.dark = next;
      try { window.localStorage.setItem('chipsvoice.dark', String(next)); } catch (e) { /* ignore */ }
    },
    logout() {
      clearSession();
    },
  },
});
</script>

<style lang="scss">
html { overflow-y: auto !important; }
.v-application {
  background: var(--v-background-base) !important;
  background-image:
    radial-gradient(900px 420px at 10% -5%, rgba(139, 124, 255, 0.18), transparent 60%),
    radial-gradient(700px 400px at 100% 0%, rgba(34, 211, 238, 0.12), transparent 60%) !important;
  background-attachment: fixed !important;
}
.v-card:not(.v-card--flat) { background-color: var(--v-surface-base) !important; }
.topbar .brand { font-weight: 600; letter-spacing: -0.3px; }
.page { max-width: 1200px; padding-top: 16px; }
.transparent-items, .transparent-items .v-window-item { background: transparent !important; }
</style>
