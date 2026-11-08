function threadUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;

  const host = url.hostname.replace(/^(?:www|web|m)\./, '');
  const pathname = url.pathname.replace(/\/$/, '');
  const thread = /^(?:\/e2ee)?\/t\/[^/]+$/;
  if (host === 'facebook.com' && thread.test(pathname.replace(/^\/messages(?=\/)/, '')) && pathname.startsWith('/messages/')) {
    return url.origin + pathname;
  }
  if (host === 'messenger.com' && thread.test(pathname)) return url.origin + pathname;
  return null;
}
