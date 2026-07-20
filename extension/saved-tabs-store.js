/*
 * Persistent Saved for Later storage.
 *
 * Chrome deletes chrome.storage.local when an extension is uninstalled. A
 * normal bookmarks folder belongs to the browser profile instead, so it stays
 * available when Tab Out is removed and follows Chrome bookmark sync.
 */

'use strict';

(() => {
  const ROOT_FOLDER_TITLE = 'Tab Out - Saved for Later';
  const LEGACY_STORAGE_KEY = 'deferred';
  const MIGRATION_KEY = 'savedTabsBookmarksMigrationComplete';
  const METADATA_KEY = 'savedTabsBookmarkMetadata';

  let rootFolderPromise = null;
  let initializationPromise = null;
  let mutationQueue = Promise.resolve();

  function flattenBookmarkTree(nodes) {
    const result = [];
    const pending = [...(nodes || [])];
    while (pending.length > 0) {
      const node = pending.shift();
      result.push(node);
      if (node.children) pending.push(...node.children);
    }
    return result;
  }

  function compareBookmarkFolders(a, b) {
    const dateDifference = (a.dateAdded || Number.MAX_SAFE_INTEGER) -
      (b.dateAdded || Number.MAX_SAFE_INTEGER);
    if (dateDifference !== 0) return dateDifference;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  }

  async function getOtherBookmarksFolders() {
    const tree = await chrome.bookmarks.getTree();
    return flattenBookmarkTree(tree).filter(node =>
      node.folderType === 'other' &&
      !node.unmodifiable
    );
  }

  async function mergeSavedFolders(target, sourceFolders) {
    for (const source of sourceFolders) {
      if (source.id === target.id) continue;

      const children = await chrome.bookmarks.getChildren(source.id);
      for (const child of children.slice().reverse()) {
        await chrome.bookmarks.move(child.id, { parentId: target.id, index: 0 });
      }

      await chrome.bookmarks.remove(source.id).catch(() => {});
    }
  }

  function normalizeSavedUrl(url) {
    return String(url || '').trim();
  }

  function compareSavedBookmarks(a, b) {
    const dateDifference = (a.dateAdded || Number.MAX_SAFE_INTEGER) -
      (b.dateAdded || Number.MAX_SAFE_INTEGER);
    if (dateDifference !== 0) return dateDifference;

    const titleDifference = String(a.title || '').localeCompare(String(b.title || ''));
    if (titleDifference !== 0) return titleDifference;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  }

  async function deduplicateSavedBookmarks(folder) {
    const children = await chrome.bookmarks.getChildren(folder.id);
    const bookmarksByUrl = new Map();

    for (const bookmark of children.filter(node => Boolean(node.url))) {
      const url = normalizeSavedUrl(bookmark.url);
      if (!url) continue;
      if (!bookmarksByUrl.has(url)) bookmarksByUrl.set(url, []);
      bookmarksByUrl.get(url).push(bookmark);
    }

    const duplicateIds = [];
    for (const bookmarks of bookmarksByUrl.values()) {
      if (bookmarks.length < 2) continue;
      bookmarks.sort(compareSavedBookmarks);
      duplicateIds.push(...bookmarks.slice(1).map(bookmark => bookmark.id));
    }

    if (duplicateIds.length === 0) return;

    await Promise.allSettled(duplicateIds.map(id => chrome.bookmarks.remove(id)));
    const metadata = await getMetadata();
    for (const id of duplicateIds) delete metadata[id];
    await setMetadata(metadata);
  }

  async function findOrCreateRootFolder() {
    const matches = await chrome.bookmarks.search({ title: ROOT_FOLDER_TITLE });
    const exactFolders = matches.filter(node => node.title === ROOT_FOLDER_TITLE && !node.url);
    const otherFolders = await getOtherBookmarksFolders();
    const syncingParent = otherFolders.find(node => node.syncing === true);
    const fallbackParent = otherFolders.find(node => node.syncing !== false) || otherFolders[0];
    const syncingRoots = exactFolders
      .filter(node => node.syncing === true)
      .sort(compareBookmarkFolders);

    let folder = syncingRoots[0];
    if (!folder && syncingParent) {
      folder = await chrome.bookmarks.create({
        parentId: syncingParent.id,
        title: ROOT_FOLDER_TITLE,
      });
    }
    if (!folder) {
      folder = exactFolders.sort(compareBookmarkFolders)[0] || await chrome.bookmarks.create({
        ...(fallbackParent ? { parentId: fallbackParent.id } : {}),
        title: ROOT_FOLDER_TITLE,
      });
    }

    // Consolidate older local-only folders and duplicate synced folders into
    // the selected synced folder without dropping saved pages.
    await mergeSavedFolders(folder, exactFolders);
    await deduplicateSavedBookmarks(folder);
    return folder;
  }

  async function getRootFolder() {
    if (!rootFolderPromise) {
      rootFolderPromise = findOrCreateRootFolder();
    }
    return rootFolderPromise;
  }

  async function getMetadata() {
    const { [METADATA_KEY]: metadata = {} } = await chrome.storage.local.get(METADATA_KEY);
    return metadata && typeof metadata === 'object' ? metadata : {};
  }

  async function setMetadata(metadata) {
    await chrome.storage.local.set({ [METADATA_KEY]: metadata });
  }

  function visibleLegacyItems(items) {
    return Array.isArray(items)
      ? items.filter(item => item?.url && !item.completed && !item.dismissed)
      : [];
  }

  async function migrateLegacyStorage() {
    const state = await chrome.storage.local.get([MIGRATION_KEY, LEGACY_STORAGE_KEY]);
    if (state[MIGRATION_KEY]) return;

    const legacyItems = visibleLegacyItems(state[LEGACY_STORAGE_KEY]);
    if (legacyItems.length > 0) {
      const root = await getRootFolder();
      const metadata = await getMetadata();

      // Oldest first keeps the newest migrated item at the top of the folder.
      for (const item of legacyItems.slice().reverse()) {
        const bookmark = await chrome.bookmarks.create({
          parentId: root.id,
          index: 0,
          title: item.title || item.url,
          url: item.url,
        });
        metadata[bookmark.id] = {
          savedAt: item.savedAt || new Date().toISOString(),
          savedGroup: item.savedGroup || null,
        };
      }

      await setMetadata(metadata);
    }

    await chrome.storage.local.set({ [MIGRATION_KEY]: true });
  }

  async function initialize() {
    if (!initializationPromise) {
      initializationPromise = (async () => {
        const root = await getRootFolder();
        await migrateLegacyStorage();
        await deduplicateSavedBookmarks(root);
      })().catch(error => {
        initializationPromise = null;
        throw error;
      });
    }
    return initializationPromise;
  }

  async function getAll() {
    await initialize();
    const root = await getRootFolder();
    const [children, metadata] = await Promise.all([
      chrome.bookmarks.getChildren(root.id),
      getMetadata(),
    ]);

    return children
      .filter(node => Boolean(node.url))
      .map(node => ({
        id: node.id,
        url: node.url,
        title: node.title || node.url,
        savedAt: metadata[node.id]?.savedAt || new Date(node.dateAdded || Date.now()).toISOString(),
        completed: false,
        dismissed: false,
        savedGroup: metadata[node.id]?.savedGroup || null,
      }));
  }

  async function save(tab) {
    if (!tab?.url) throw new Error('A URL is required to save a tab');

    await initialize();
    const root = await getRootFolder();
    const existingBookmarks = await chrome.bookmarks.getChildren(root.id);
    const targetUrl = normalizeSavedUrl(tab.url);
    const existing = existingBookmarks
      .filter(node => normalizeSavedUrl(node.url) === targetUrl)
      .sort(compareSavedBookmarks)[0];

    if (existing) {
      const metadata = await getMetadata();
      if (!metadata[existing.id]) {
        metadata[existing.id] = {
          savedAt: new Date(existing.dateAdded || Date.now()).toISOString(),
          savedGroup: tab.savedGroup || null,
        };
        await setMetadata(metadata);
      }
      return existing.id;
    }

    const bookmark = await chrome.bookmarks.create({
      parentId: root.id,
      index: 0,
      title: tab.title || tab.url,
      url: tab.url,
    });

    const metadata = await getMetadata();
    metadata[bookmark.id] = {
      savedAt: new Date().toISOString(),
      savedGroup: tab.savedGroup || null,
    };
    await setMetadata(metadata);
    return bookmark.id;
  }

  async function removeIds(ids) {
    const uniqueIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
    if (uniqueIds.length === 0) return;

    await Promise.allSettled(uniqueIds.map(id => chrome.bookmarks.remove(id)));

    const metadata = await getMetadata();
    for (const id of uniqueIds) delete metadata[id];
    await setMetadata(metadata);
  }

  function enqueueMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function invalidateRootFolder() {
    rootFolderPromise = null;
  }

  globalThis.SavedTabsStore = Object.freeze({
    getAll,
    save: tab => enqueueMutation(() => save(tab)),
    removeIds: ids => enqueueMutation(() => removeIds(ids)),
    invalidateRootFolder,
  });
})();
