const [source, maxBytes, done] = arguments;
const url = typeof source === 'number' ? window.__messscrapInlineMedia?.[source] : source;
if (!url) return done({error: 'unavailable'});
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 12000);

(async () => {
  try {
    const response = await fetch(url, {signal: controller.signal, redirect: 'error'});
    if (!response.ok) return done({error: 'HTTP ' + response.status});
    if (!response.body) return done({error: 'empty response'});
    if (Number(response.headers.get('Content-Length')) > maxBytes) {
      controller.abort();
      return done({error: 'file exceeds size limit'});
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const {value, done: finished} = await reader.read();
      if (finished) break;
      size += value.length;
      if (size > maxBytes) {
        controller.abort();
        return done({error: 'file exceeds size limit'});
      }
      chunks.push(value);
    }
    if (!size) return done({error: 'empty response'});
    const type = response.headers.get('Content-Type') || '';
    const data = await new Promise((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onload = () => resolve(fileReader.result.split(',', 2)[1]);
      fileReader.onerror = reject;
      fileReader.readAsDataURL(new Blob(chunks));
    });
    return done({data, type});
  } catch (error) {
    return done({error: error.name === 'AbortError' ? 'timeout' : 'blocked or unavailable'});
  } finally {
    clearTimeout(timer);
  }
})();
