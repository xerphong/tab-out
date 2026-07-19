/*
 * Persistent Saved for Later storage.
 *
 * Chrome deletes chrome.storage.local when an extension is uninstalled. A
 * normal bookmarks folder belongs to the browser profile instead, so it stays
 * available when Tab Out is removed and loaded again.
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

  async function getLocalOtherBookmarksFolder() {
    const tree = await chrome.bookmarks.getTree();
    return flattenBookmarkTree(tree).find(node =>
      node.folderType === 'other' &&
      node.syncing === false &&
      !node.unmodifiable
    ) || null;
  }

  async function findOrCreateRootFolder() {
    const matches = await chrome.bookmarks.search({ title: ROOT_FOLDER_TITLE });
    const exactFolders = matches.filter(node => node.title === ROOT_FOLDER_TITLE && !node.url);
    const folder = exactFolders.find(node => node.syncing === false) || exactFolders[0];
    if (folder) return folder;

    // Chrome 134+ identifies local-only bookmark roots. Prefer that location
    // so the list stays on this computer even when bookmark sync is enabled.
    const localFolder = await getLocalOtherBookmarksFolder();
    return chrome.bookmarks.create({
      ...(localFolder ? { parentId: localFolder.id } : {}),
      title: ROOT_FOLDER_TITLE,
    });
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
        await getRootFolder();
        await migrateLegacyStorage();
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

  globalThis.SavedTabsStore = Object.freeze({
    getAll,
    save: tab => enqueueMutation(() => save(tab)),
    removeIds: ids => enqueueMutation(() => removeIds(ids)),
  });
})();
