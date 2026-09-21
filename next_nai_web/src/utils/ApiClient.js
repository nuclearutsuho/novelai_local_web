import { isPaintingModelAllowed } from '@/components/ai-painting/utils/modelUtils';
import { CONNECTION_KEY, STUDIO_USER_KEY, chooseConnection, userStorage, currentStorageScope } from './userStorage.mjs';
import { StudioVibeRunner } from './StudioVibeRunner.mjs';
import { StudioTaskRunner } from './StudioTaskRunner.mjs';
import { createStudioTaskStorage } from './StudioTaskStorage.mjs';

const CSRF_STORAGE_KEY = 'novelai-local.csrf-token';

export function buildStudioDirectorRequest(parameters) {
  // 与原版后端的 Director 分支一致，编辑请求不携带普通采样器或参考图参数。
  const request = { req_type: parameters.req_type, width: parameters.width ?? 512,
    height: parameters.height ?? 512, image: parameters.image ?? '' };
  if (['emotion', 'colorize'].includes(parameters.req_type)) {
    request.defry = parameters.defry ?? 1;
    request.prompt = parameters.prompt ?? '';
  }
  return request;
}

function getApiBaseUrl() {
  return '/api';
}

function createApiError(response, data) {
  const code = data?.code || data?.error_code || data?.error || `HTTP_${response.status}`;
  return Object.assign(new Error(String(code)), {
    code,
    status: response.status,
    statusCode: response.status,
    category: data?.category,
    errorId: data?.error_id || data?.correlation_id || null,
    data,
  });
}

class ApiClient {
  constructor() {
    this.csrfToken = '';
    const onTerminal = (detail) => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('studio:tool-ended', { detail }));
    };
    this.studioVibes = new StudioVibeRunner({ request: (...args) => this.request(...args), storage: userStorage, scope: currentStorageScope, onTerminal });
    this.studioUpscales = new StudioVibeRunner({ request: (...args) => this.request(...args), storage: userStorage, scope: currentStorageScope, tool: 'upscale', onTerminal });
    this.studioDirectors = new StudioVibeRunner({ request: (...args) => this.request(...args), storage: userStorage, scope: currentStorageScope, tool: 'director', onTerminal });
    this.studioTasks = new StudioTaskRunner({ request: (...args) => this.request(...args),
      storage: createStudioTaskStorage(userStorage, currentStorageScope), scope: currentStorageScope,
      createId: () => window.crypto.randomUUID(),
      notify: () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio:task-changed')); } });
  }

  isStudio() {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(CONNECTION_KEY) === 'studio';
  }

  readCsrfToken() {
    if (this.csrfToken) return this.csrfToken;
    if (typeof window === 'undefined') return '';
    this.csrfToken = window.sessionStorage.getItem(CSRF_STORAGE_KEY) || '';
    return this.csrfToken;
  }

  setCsrfToken(token) {
    this.csrfToken = String(token || '');
    if (typeof window === 'undefined') return;
    if (this.csrfToken) {
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, this.csrfToken);
    } else {
      window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
    }
  }

  async request(path, options = {}) {
    if (this.isStudio() && path.startsWith('/local/')) path = '/studio' + path;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (this.isStudio() && path.startsWith('/studio/') && !['/studio/start', '/studio/complete'].includes(path)) {
      const userId = window.sessionStorage.getItem(STUDIO_USER_KEY);
      if (userId) headers.set('X-Idlecloud-User', userId);
    }
    const hasBody = options.body !== undefined;
    const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
    if (isBlob) headers.set('Content-Type', options.body.type || 'application/octet-stream');
    if (hasBody && !(options.body instanceof FormData) && !isBlob) {
      headers.set('Content-Type', 'application/json');
    }
    if (!['GET', 'HEAD'].includes(method)) {
      const csrfToken = this.readCsrfToken();
      if (csrfToken && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken);
    }

    let response;
    try {
      response = await fetch(`${getApiBaseUrl()}${path}`, {
        ...options,
        method,
        headers,
        credentials: 'include',
        body: hasBody && !(options.body instanceof FormData) && !isBlob
          ? JSON.stringify(options.body)
          : options.body,
      });
    } catch (cause) {
      throw Object.assign(new Error('NETWORK_ERROR'), {
        code: 'NETWORK_ERROR',
        category: 'network',
        cause,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (options.responseType === 'image' && response.ok && /^image\/(png|webp|jpeg)(;|$)/.test(contentType)) {
      // 图片直接成为 Blob；种子与尺寸由受控响应头携带，不再进行 Base64 编解码。
      const blob = await response.blob();
      if (!blob.size) throw Object.assign(new Error('STUDIO_IMAGE_RESPONSE_INVALID'), { code: 'STUDIO_IMAGE_RESPONSE_INVALID' });
      const numberHeader = name => {
        const value = response.headers.get(name);
        return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
      };
      return { images: [{ blob, mime_type: blob.type, seed: numberHeader('X-Image-Seed'),
        width: numberHeader('X-Image-Width'), height: numberHeader('X-Image-Height') }] };
    }
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      if (data?.code === 'STUDIO_IDENTITY_CHANGED' && typeof window !== 'undefined') window.location.replace('/login');
      throw createApiError(response, data);
    }
    return data;
  }

  async getSession() {
    const data = await this.request(this.isStudio() ? '/studio/session' : '/session');
    if (data.csrf_token) this.setCsrfToken(data.csrf_token);
    return data;
  }

  async loginWithPersistentToken(token) {
    const data = await this.request('/session/persistent-token', {
      method: 'POST',
      body: { token: String(token || '').trim() },
    });
    this.setCsrfToken(data.csrf_token);
    chooseConnection('direct');
    return data;
  }

  async loginWithPassword(email, password) {
    const data = await this.request('/session/password', {
      method: 'POST',
      body: { email: String(email || '').trim(), password },
    });
    this.setCsrfToken(data.csrf_token);
    chooseConnection('direct');
    return data;
  }

  async logout() {
    const result = await this.request(this.isStudio() ? '/studio/session' : '/session', { method: 'DELETE' });
    this.setCsrfToken('');
    chooseConnection('direct');
    return result;
  }

  async getAccount() {
    return this.request(this.isStudio() ? '/studio/account' : '/account');
  }

  async changePassword(currentPassword, newPassword) {
    if (this.isStudio()) throw new Error('Studio 模式请在 Studio 管理账号。');
    const data = await this.request('/account/change-password', {
      method: 'POST',
      body: {
        current_password: currentPassword,
        new_password: newPassword,
        backup_confirmed: true,
      },
    });
    if (data.csrf_token) this.setCsrfToken(data.csrf_token);
    return data;
  }

  async changeEmail(currentPassword, newEmail) {
    if (this.isStudio()) throw new Error('Studio 模式请在 Studio 管理账号。');
    const data = await this.request('/account/change-email', {
      method: 'POST',
      body: {
        current_password: currentPassword,
        new_email: String(newEmail || '').trim(),
        backup_confirmed: true,
      },
    });
    if (data.csrf_token) this.setCsrfToken(data.csrf_token);
    return data;
  }

  async getAccountRecovery() {
    if (this.isStudio()) return { active: false };
    return this.request('/account/recovery');
  }

  async resolveAccountRecovery(credentials) {
    const data = await this.request('/account/recovery/resolve', {
      method: 'POST',
      body: credentials,
    });
    if (data.csrf_token) this.setCsrfToken(data.csrf_token);
    return data;
  }

  async generateImage(requestBody, onProgress, workspace = null) {
    if (this.isStudio() && requestBody.req_type) return this.studioDirectors.encode(buildStudioDirectorRequest(requestBody));
    if (this.isStudio()) return this.studioTasks.start(requestBody, onProgress, workspace);
    return this.request('/images/generate', { method: 'POST', body: requestBody });
  }

  async cancelImageBatch(batchId, keepalive = false) {
    if (this.isStudio()) return this.studioTasks.cancel(null, batchId || null);
    return this.request('/images/batch', {
      method: 'DELETE',
      body: batchId ? { batch_id: batchId } : {},
      keepalive,
    });
  }

  async encodeVibe(image, informationExtracted, model, options = {}) {
    if (this.isStudio()) return this.studioVibes.encode({ image, information_extracted: informationExtracted, model }, options);
    return this.request('/images/vibe', {
      method: 'POST',
      body: {
        image,
        information_extracted: informationExtracted,
        model,
      },
    });
  }

  async upscaleImage(body) {
    if (this.isStudio()) return this.studioUpscales.encode(body);
    return this.request('/images/upscale', { method: 'POST', body });
  }

  async augmentImage(body) {
    if (this.isStudio()) return this.studioDirectors.encode(body);
    return this.request('/images/augment', { method: 'POST', body });
  }

  async getPrompt(prompt, model = null) {
    const searchParams = new URLSearchParams({
      prompt: String(prompt || '').trim(),
    });
    if (isPaintingModelAllowed(model)) searchParams.set('model', model);
    return this.request(`${this.isStudio() ? '/studio/tags' : '/images/tags'}?${searchParams.toString()}`);
  }

  async getLocalSettings() {
    const response = await this.request('/local/settings');
    return response.settings || {};
  }

  async saveLocalSettings(settings) {
    const response = await this.request('/local/settings', {
      method: 'PUT',
      body: { settings },
    });
    return response.settings || {};
  }

  async getRandomPromptConfig() {
    const response = await this.request('/local/random-prompts');
    return response.random_prompts || {};
  }

  async saveRandomPromptConfig(randomPrompts) {
    const response = await this.request('/local/random-prompts', {
      method: 'PUT',
      body: { random_prompts: randomPrompts },
    });
    return response.random_prompts || randomPrompts;
  }

  async getTexts() {
    const response = await this.request('/local/notes');
    return { ...response, texts: response.notes || [] };
  }

  async saveTexts(title, positivePrompt, negativePrompt, imageUrl, characterTabs) {
    return this.request('/local/notes', {
      method: 'POST',
      body: {
        note: {
          title,
          text_content1: positivePrompt,
          text_content2: negativePrompt,
          image_url: imageUrl || '',
          character_tabs: characterTabs || [],
        },
      },
    });
  }

  async updateText(originalTitle, title, positivePrompt, negativePrompt, imageUrl, characterTabs) {
    return this.request('/local/notes', {
      method: 'PUT',
      body: {
        original_title: originalTitle,
        note: {
          title,
          text_content1: positivePrompt,
          text_content2: negativePrompt,
          image_url: imageUrl || '',
          character_tabs: characterTabs || [],
        },
      },
    });
  }

  async deleteText(title) {
    return this.request('/local/notes', {
      method: 'DELETE',
      body: { title },
    });
  }

  noteTransferGuard(isCurrent) {
    const scope = currentStorageScope();
    return () => {
      if (!isCurrent() || currentStorageScope() !== scope) {
        throw Object.assign(new Error('LOCAL_OPERATION_INTERRUPTED'), { code: 'LOCAL_OPERATION_INTERRUPTED' });
      }
    };
  }

  async exportTexts({ isCurrent = () => true } = {}) {
    const check = this.noteTransferGuard(isCurrent);
    check();
    const result = await this.getTexts();
    check();
    return result;
  }

  async importTexts(notes, { isCurrent = () => true } = {}) {
    const check = this.noteTransferGuard(isCurrent);
    check();
    for (const note of Array.isArray(notes) ? notes : []) {
      // 每条写入都绑定发起时的身份；已完成部分保留，不自动回滚或重试。
      check();
      await this.request('/local/notes', {
        method: 'POST',
        body: { note },
      });
      check();
    }
    return { imported: true };
  }
}

const apiClient = new ApiClient();

export { ApiClient };
export default apiClient;
