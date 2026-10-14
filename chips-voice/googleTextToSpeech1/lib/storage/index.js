// Places a clip can be shared to. Configure one or both with environment variables
// (see rclone.js and owncloud.js); STORAGE_DEFAULT picks which one is used when none is named.
const { slug } = require('../signing');

function createStorage(env = process.env, overrides = {}) {
  const adapters = {
    rclone: overrides.rclone || require('./rclone').create(env),
    owncloud: overrides.owncloud || require('./owncloud').create(env),
  };
  const enabled = Object.values(adapters).filter((a) => a.enabled);

  return {
    targets: enabled.map((a) => ({ name: a.name, label: a.label })),
    enabled: enabled.length > 0,

    async share(clip, localFile, targetName) {
      const wanted = targetName || env.STORAGE_DEFAULT || (enabled[0] && enabled[0].name);
      const adapter = enabled.find((a) => a.name === wanted);
      if (!adapter) throw new Error(enabled.length ? `unknown storage target "${wanted}"` : 'no cloud storage is configured');
      const name = `${slug(clip.title)}-${clip.id.slice(0, 8)}.${clip.ext}`;
      return adapter.share(localFile, name);
    },
  };
}

module.exports = { createStorage };
