<template lang="pug">
  .login
    v-card.login-card(elevation="12")
      .brand
        v-avatar(size="64" color="primary")
          v-icon(size="34" dark) mdi-radio-tower
        h1 Chips Voice
        p.subtitle Station control. Sign in to continue.
      v-form(@submit.prevent="submit" ref="form")
        v-text-field(
          v-model="username" label="Username" prepend-inner-icon="mdi-account-outline"
          autocomplete="username" outlined :disabled="busy" autofocus
        )
        v-text-field(
          v-model="password" label="Password" prepend-inner-icon="mdi-lock-outline"
          :type="reveal ? 'text' : 'password'" autocomplete="current-password" outlined :disabled="busy"
          :append-icon="reveal ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" @click:append="reveal = !reveal"
        )
        v-alert(v-if="error" type="error" dense text) {{ error }}
        v-btn(type="submit" color="primary" block large depressed :loading="busy" :disabled="!username || !password") Sign in
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { setSession } from '../session';

  export default Vue.extend({
    name: 'Login',

    data: () => ({
      username: '',
      password: '',
      reveal: false,
      busy: false,
      error: '',
    }),

    methods: {
      async submit() {
        this.busy = true;
        this.error = '';
        try {
          const { data } = await api.post('/auth/login', { username: this.username, password: this.password });
          setSession(data.token, data.user, data.expiresInHours);
          this.password = '';
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.busy = false;
        }
      },
    },
  });
</script>

<style lang="scss" scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background:
    radial-gradient(900px 500px at 15% 10%, rgba(139, 124, 255, 0.35), transparent 60%),
    radial-gradient(700px 500px at 90% 90%, rgba(34, 211, 238, 0.25), transparent 60%),
    var(--v-background-base);
}
.login-card {
  width: 100%;
  max-width: 400px;
  padding: 32px 28px 24px;
  border-radius: 20px !important;
  backdrop-filter: blur(12px);
}
.brand {
  text-align: center;
  margin-bottom: 24px;
  h1 { margin-top: 12px; font-weight: 600; letter-spacing: -0.5px; }
  .subtitle { opacity: 0.7; margin: 4px 0 0; }
}
</style>
