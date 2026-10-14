import axios from 'axios';
import { session, clearSession } from './session';

export const API_URL = process.env.VUE_APP_API || 'http://localhost:3000';

const api = axios.create({ baseURL: API_URL, timeout: 30000 });

api.interceptors.request.use((config) => {
  if (session.token) config.headers.Authorization = `Bearer ${session.token}`;
  return config;
});

// An expired or revoked session sends the user back to the login screen.
api.interceptors.response.use((response) => response, (error) => {
  const url = (error.config && error.config.url) || '';
  if (error.response && error.response.status === 401 && session.token && !url.includes('/auth/login')) {
    clearSession();
  }
  return Promise.reject(error);
});

export function errorMessage(error: any): string {
  if (error && error.response && error.response.data && error.response.data.error) {
    return error.response.data.error;
  }
  if (error && error.response) return `Server error (${error.response.status})`;
  return 'Cannot reach the server';
}

export default api;
