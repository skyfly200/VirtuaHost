// Upload and share through rclone, so it works with Google Drive, Dropbox, OneDrive, S3, and more.
//   STORAGE_RCLONE_REMOTE = "gdrive:ChipsVoice"   (a remote you set up with `rclone config`, plus a folder)
// The link comes from `rclone link`, which Google Drive, Dropbox and OneDrive support.
const { execFile } = require('child_process');
const { directUrl } = require('./links');

function defaultRun(bin) {
  return (args) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120000, maxBuffer: 1e6 }, (err, stdout, stderr) => (
      err ? reject(new Error(`rclone ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(stdout)));
  });
}

function create(env, { run } = {}) {
  const remote = (env.STORAGE_RCLONE_REMOTE || '').replace(/\/+$/, '');
  const exec = run || defaultRun(env.RCLONE_BIN || 'rclone');
  return {
    name: 'rclone',
    label: env.STORAGE_RCLONE_LABEL || 'Cloud drive',
    enabled: !!remote,

    async share(localFile, name) {
      const target = `${remote}/${name}`;
      await exec(['copyto', localFile, target]);
      const url = (await exec(['link', target])).trim();
      if (!/^https?:\/\//.test(url)) throw new Error('rclone did not return a link; this storage may not support links');
      return { target: 'rclone', path: target, url, directUrl: directUrl(url) };
    },
  };
}

module.exports = { create };
