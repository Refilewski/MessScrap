const api = globalThis.browser ?? globalThis.chrome;
const STORE = 'checkpoints';
const PREFERENCES = 'messscrap.preferences';
const CHUNK_SIZE = 500;
let database;
let preferenceWrites = Promise.resolve();

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('messscrap', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  }
  return database;
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error('Checkpoint transaction aborted.'));
  });
}

const checkpointKey = id => [id, 'current'];
const revisionRange = (id, revision) => IDBKeyRange.bound([id, revision], [id, revision, []]);
const validRevision = revision => typeof revision === 'string' && /^[a-f0-9-]{36}$/.test(revision);

function validMetadata(metadata, id) {
  return validRevision(metadata?.revision) && metadata.header?.conversation?.id === id
    && Number.isSafeInteger(metadata.count) && metadata.count > 0 && metadata.header.count === metadata.count
    && metadata.chunks === Math.ceil(metadata.count / CHUNK_SIZE);
}

async function cleanStaging(store, id) {
  // An interrupted write never becomes the current snapshot. Drop old staging
  // revisions opportunistically when starting another checkpoint.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const request = store.openCursor(IDBKeyRange.bound([id], [id, []]));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const [, revision, index] = cursor.key;
      if (index === -1 && cursor.value.started < cutoff) store.delete(revisionRange(id, revision));
      if (index === undefined) cursor.continue();
      else cursor.continue([id, revision, []]);
    };
  });
}

async function checkpoint(operation, id, {revision, header, index, items} = {}) {
  if (typeof id !== 'string' || !id || id.length > 1024) throw new Error('Invalid conversation identifier.');
  const db = await openDatabase();
  const readOnly = ['info', 'read-chunk'].includes(operation);
  const transaction = db.transaction(STORE, readOnly ? 'readonly' : 'readwrite');
  const done = transactionDone(transaction);
  done.catch(() => {});
  const store = transaction.objectStore(STORE);
  const key = checkpointKey(id);

  if (operation === 'delete') {
    store.delete(IDBKeyRange.bound([id], [id, []]));
    await done;
    return null;
  }

  if (operation === 'info') {
    const metadata = await readRequest(store.get(key));
    if (metadata && !validMetadata(metadata, id)) throw new Error('Checkpoint metadata is invalid. Delete the checkpoint and restart.');
    return metadata ?? null;
  }

  if (!validRevision(revision)) throw new Error('Invalid checkpoint revision.');
  const stageKey = [id, revision, -1];
  if (operation === 'abort-checkpoint') {
    if (await readRequest(store.get(stageKey))) store.delete(revisionRange(id, revision));
    await done;
    return null;
  }
  if (operation === 'begin-checkpoint') {
    const count = header?.count;
    const metadata = {revision, header, count, chunks: Math.ceil(count / CHUNK_SIZE), started: Date.now()};
    if (!validMetadata(metadata, id)) throw new Error('Checkpoint conversation or message count is invalid.');
    await cleanStaging(store, id);
    store.put(metadata, stageKey);
    await done;
    return null;
  }
  if (operation === 'read-chunk') {
    const metadata = await readRequest(store.get(key));
    if (!validMetadata(metadata, id) || metadata.revision !== revision) {
      throw new Error('Checkpoint changed while it was being read. Reopen the panel to retry.');
    }
    const chunk = await readRequest(store.get([id, revision, index]));
    if (!Array.isArray(chunk) || chunk.length !== Math.min(CHUNK_SIZE, metadata.count - index * CHUNK_SIZE)) {
      throw new Error('Checkpoint data is incomplete. Delete the checkpoint and restart.');
    }
    return chunk;
  }
  const metadata = await readRequest(store.get(stageKey));
  if (!validMetadata(metadata, id)) throw new Error('Checkpoint write was interrupted.');
  if (operation === 'put-chunk') {
    if (!Number.isInteger(index) || index < 0 || index >= metadata.chunks || !Array.isArray(items)
      || items.length !== Math.min(CHUNK_SIZE, metadata.count - index * CHUNK_SIZE)) {
      throw new Error('Checkpoint chunk has an invalid length.');
    }
    store.put(items, [id, revision, index]);
    await done;
    return null;
  }
  if (operation === 'commit-checkpoint') {
    const current = await readRequest(store.get(key));
    if (current?.count > metadata.count) {
      store.delete(revisionRange(id, revision));
      await done;
      return {count: current.count};
    }
    const range = IDBKeyRange.bound([id, revision, 0], [id, revision, metadata.chunks - 1]);
    if (await readRequest(store.count(range)) !== metadata.chunks) throw new Error('Checkpoint write did not finish.');
    if (current && validRevision(current.revision)) store.delete(revisionRange(id, current.revision));
    store.delete(stageKey);
    store.put({...metadata, savedAt: new Date().toISOString()}, key);
    await done;
    return {count: metadata.count};
  }
  throw new Error('Unknown checkpoint operation.');
}

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.scope !== 'messscrap' || sender.id !== api.runtime.id || !sender.tab) return false;
  const {operation, id, payload} = message;
  const work = async () => {
    if (operation === 'preferences') {
      await preferenceWrites;
      return (await api.storage.local.get(PREFERENCES))[PREFERENCES] ?? {};
    }
    if (operation === 'save-preferences') {
      const write = preferenceWrites.then(async () => {
        const previous = (await api.storage.local.get(PREFERENCES))[PREFERENCES] ?? {};
        await api.storage.local.set({[PREFERENCES]: {...previous, ...payload}});
        return null;
      });
      preferenceWrites = write.catch(() => {});
      return write;
    }
    return checkpoint(operation, id, payload);
  };
  Promise.resolve().then(work).then(value => respond({value}), error => {
    respond({error: /^Checkpoint\b/.test(error?.message) ? error.message : 'Local storage could not complete the requested operation.'});
  });
  return true;
});
