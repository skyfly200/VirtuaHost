// ownCloud (and Nextcloud) over WebDAV, with public links from the OCS sharing API.
//   OWNCLOUD_URL      https://cloud.example.com        (the server root)
//   OWNCLOUD_USER, OWNCLOUD_PASSWORD   use an app password (Settings > Security), not the account password
//   OWNCLOUD_FOLDER   folder to upload into (default ChipsVoice)
const fs = require('fs');

function create(env) {
  const base = (env.OWNCLOUD_URL || '').replace(/\/+$/, '');
  const user = env.OWNCLOUD_USER || '';
  const folder = (env.OWNCLOUD_FOLDER || 'ChipsVoice').replace(/^\/+|\/+$/g, '');
  const auth = `Basic ${Buffer.from(`${user}:${env.OWNCLOUD_PASSWORD || ''}`).toString('base64')}`;
  const davRoot = `${base}/remote.php/dav/files/${encodeURIComponent(user)}`;
  const ocs = `${base}/ocs/v1.php/apps/files_sharing/api/v1/shares`;
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function call(url, init) {
    const res = await fetch(url, { ...init, headers: { Authorization: auth, 'OCS-APIRequest': 'true', ...(init.headers || {}) }, signal: AbortSignal.timeout(60000) });
    return res;
  }

  async function ensureFolder() {
    let current = '';
    for (const part of folder.split('/')) {
      current += `/${part}`;
      const res = await call(`${davRoot}${enc(current)}`, { method: 'MKCOL' });
      if (![201, 405].includes(res.status)) throw new Error(`owncloud: cannot create folder (${res.status})`);
    }
  }

  async function publicLink(remotePath) {
    const q = `path=${encodeURIComponent(remotePath)}&format=json`;
    const existing = await call(`${ocs}?${q}`, { method: 'GET' });
    if (existing.ok) {
      const list = (await existing.json()).ocs.data || [];
      const hit = (Array.isArray(list) ? list : [list]).find((s) => String(s.share_type) === '3' && s.url);
      if (hit) return hit.url;
    }
    const res = await call(`${ocs}?format=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `path=${encodeURIComponent(remotePath)}&shareType=3&permissions=1`,
    });
    const body = res.ok ? await res.json() : null;
    const url = body && body.ocs && body.ocs.data && body.ocs.data.url;
    if (!url) throw new Error(`owncloud: could not create a public link (${res.status})`);
    return url;
  }

  return {
    name: 'owncloud',
    label: env.OWNCLOUD_LABEL || 'ownCloud',
    enabled: !!(base && user && env.OWNCLOUD_PASSWORD),

    async share(localFile, name) {
      await ensureFolder();
      const remotePath = `/${folder}/${name}`;
      const put = await call(`${davRoot}${enc(remotePath)}`, { method: 'PUT', body: fs.readFileSync(localFile) });
      if (![201, 204].includes(put.status)) throw new Error(`owncloud: upload failed (${put.status})`);
      const url = await publicLink(remotePath);
      return { target: 'owncloud', path: remotePath, url, directUrl: `${url.replace(/\/+$/, '')}/download` };
    },
  };
}

module.exports = { create };
