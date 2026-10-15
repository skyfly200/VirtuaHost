import Vue from 'vue';
import App from './App.vue';
import './registerServiceWorker';
import store from './store';
import vuetify from './plugins/vuetify';
import api from './api';
import '@mdi/font/css/materialdesignicons.css';

Vue.prototype.$http = api;

Vue.config.productionTip = false;

new Vue({
  store,
  vuetify,
  render: (h) => h(App),
}).$mount('#app');
