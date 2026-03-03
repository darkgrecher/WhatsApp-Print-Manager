import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('admin_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Handle 401 — redirect to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('admin_token');
      window.location.href = '/';
    }
    return Promise.reject(error);
  },
);

export default api;

// ── Auth ──
export const loginApi = (username: string, password: string) =>
  api.post('/auth/login', { username, password });

// ── Users ──
export const getUsersApi = () => api.get('/users');
export const getPendingUsersApi = () => api.get('/users/pending');
export const getActiveUsersApi = () => api.get('/users/active');
export const createUserApi = (data: { phoneNumber: string; displayName?: string; planType?: 'TRIAL' | 'ANNUAL' }) =>
  api.post('/users', data);
export const activateUserApi = (id: number, planType: 'TRIAL' | 'ANNUAL') =>
  api.patch(`/users/${id}/activate`, { planType });
export const changePlanApi = (id: number, planType: 'TRIAL' | 'ANNUAL') =>
  api.patch(`/users/${id}/change-plan`, { planType });
export const deactivateUserApi = (id: number) =>
  api.patch(`/users/${id}/deactivate`);
export const rejectUserApi = (id: number) =>
  api.patch(`/users/${id}/reject`);
export const deleteUserApi = (id: number) =>
  api.delete(`/users/${id}`);
