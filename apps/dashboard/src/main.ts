import './style.css';
import { apiBaseUrl, createApiClient } from './api.ts';
import { mountApp } from './app.ts';

const root = document.getElementById('app');
if (root === null) throw new Error('index.html has no #app element');
mountApp({ root, client: createApiClient({ baseUrl: apiBaseUrl(import.meta.env) }) });
