// Turn a "share page" URL into one a media player can stream directly, where the provider allows it.
function directUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'drive.google.com') {
      const id = u.searchParams.get('id') || (u.pathname.match(/\/d\/([^/]+)/) || [])[1];
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    if (u.hostname.endsWith('dropbox.com')) {
      u.searchParams.set('dl', '1');
      return u.toString();
    }
    if (/\/s\/[A-Za-z0-9]+\/?$/.test(u.pathname)) {      // ownCloud / Nextcloud public link
      return `${url.replace(/\/+$/, '')}/download`;
    }
  } catch (e) { /* not a URL */ }
  return null;
}

module.exports = { directUrl };
