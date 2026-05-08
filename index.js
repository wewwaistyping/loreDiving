/**
 * Know My Setting — interactive world library for SillyTavern
 * v0.7.0 — full mobile UI: bottom tabs, bottom sheets, single-pane navigation,
 *           immersive map, fullscreen editor, mobile top bar (world-pill + search + ⋮)
 * v0.6.0 — player layer (notes/favorites/read), FAB + hotkey, multilang bodies,
 *           chat command buttons, bundle export/import, live chat tracking, random article
 *
 * ── Data model ──
 * worlds:     { id, name, sourceFileName, description, createdAt, updatedAt }
 * sources:    { id, worldId, fileName, role, importedAt, lastUpdate, entryCount }
 * categories: { id, worldId, key, label, icon, order, isSpoiler, builtin,
 *               infoboxFields: [{key, label, type}] }
 * articles:   { id, worldId, sourceId, uid, title, subtitle, categoryKey, tags[],
 *               spoiler, snippet, body, infobox, media[], related[], source,
 *               manualEdits[], orphaned, createdAt, updatedAt }
 * media:      { id, blob, name, type, size, originalSize?, createdAt }
 * maps:       { id, worldId, mediaId, pins: [{x, y, articleId, label}], createdAt, updatedAt }
 *
 * Article id format:  `${sourceId}::entry-${uid}`     (was `${worldId}::entry-${uid}`)
 * Source id format:   `${worldId}::src-${shortId}`
 * Category id format: `${worldId}::cat-${key}`
 * Map id format:      `${worldId}::map`
 */

(function knowMySetting() {
    'use strict';

    const KMS = 'know_my_setting';
    const VERSION = '0.7.0';
    const DB_NAME = 'kms-wiki';
    const DB_VERSION = 4;

    // ── Settings ───────────────────────────────────────────────
    const defaults = Object.freeze({
        creatorMode: false,
        drawerWidth: 540,
        statusLogOpen: false,
        showSpoilersGlobal: false,
        currentWorldId: null,
        theme: 'parchment',
        lastImport: null,
        fullscreen: false,
        catalogCollapsed: false,
        // v0.6.0
        showFab: true,                 // floating button visible
        hotkey: 'Alt+K',               // open/close drawer hotkey
        preferredLanguage: 'ru',
        liveTracking: true,            // observe chat & highlight mentioned articles in catalog
        mentionToasts: true,           // show popup toast when articles get mentioned
        playerData: {},                // { [articleId]: { notes, favorite, read } }
        catalogFilter: 'all',          // all | favorite | unread | read
    });

    function getSettings() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[KMS]) {
            ctx.extensionSettings[KMS] = structuredClone(defaults);
        }
        const s = ctx.extensionSettings[KMS];
        for (const k of Object.keys(defaults)) {
            if (!Object.hasOwn(s, k)) s[k] = defaults[k];
        }
        return s;
    }

    function saveSettings() {
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch (_) {}
    }

    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

    // ── Status / event log ────────────────────────────────────
    const eventLog = [];
    const MAX_EVENTS = 100;

    function status(msg, level = 'info') {
        const evt = { ts: Date.now(), level, msg };
        eventLog.unshift(evt);
        if (eventLog.length > MAX_EVENTS) eventLog.length = MAX_EVENTS;
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(`[KMS ${VERSION}]`, msg);
        renderStatus();
    }

    function clearEventLog() {
        eventLog.length = 0;
        status('Журнал очищен.', 'info');
    }

    // ── IndexedDB ──────────────────────────────────────────────
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('articles')) {
                    db.createObjectStore('articles', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('media')) {
                    db.createObjectStore('media', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('worlds')) {
                    db.createObjectStore('worlds', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('categories')) {
                    const store = db.createObjectStore('categories', { keyPath: 'id' });
                    try { store.createIndex('byWorld', 'worldId', { unique: false }); } catch (_) {}
                }
                if (!db.objectStoreNames.contains('maps')) {
                    db.createObjectStore('maps', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('sources')) {
                    const store = db.createObjectStore('sources', { keyPath: 'id' });
                    try { store.createIndex('byWorld', 'worldId', { unique: false }); } catch (_) {}
                }
            };
        });
    }

    async function dbGetAll(store) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbGet(store, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(store, 'readonly').objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbPut(store, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(store, 'readwrite').objectStore(store).put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function dbDelete(store, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // ── Default categories ─────────────────────────────────────
    const DEFAULT_CATEGORIES = [
        { key: 'world',     label: 'Мир и сеттинг',  icon: '🌍', order: 10, infoboxFields: [] },
        { key: 'location',  label: 'Места',          icon: '🏛', order: 20, infoboxFields: [
            { key: 'region',     label: 'Регион',     type: 'text' },
            { key: 'population', label: 'Население',  type: 'text' },
            { key: 'climate',    label: 'Климат',     type: 'text' },
        ]},
        { key: 'character', label: 'Персонажи',      icon: '👤', order: 30, infoboxFields: [
            { key: 'age',        label: 'Возраст',    type: 'text' },
            { key: 'occupation', label: 'Род занятий',type: 'text' },
            { key: 'status',     label: 'Статус',     type: 'text' },
            { key: 'origin',     label: 'Откуда',     type: 'text' },
        ]},
        { key: 'creature',  label: 'Существа',       icon: '🐾', order: 40, infoboxFields: [
            { key: 'species',    label: 'Вид',        type: 'text' },
            { key: 'habitat',    label: 'Среда',      type: 'text' },
        ]},
        { key: 'faction',   label: 'Группы',         icon: '🤝', order: 50, infoboxFields: [
            { key: 'leader',     label: 'Лидер',      type: 'text' },
            { key: 'members',    label: 'Численность',type: 'text' },
        ]},
        { key: 'event',     label: 'События',        icon: '📅', order: 60, infoboxFields: [
            { key: 'date',       label: 'Дата',       type: 'text' },
            { key: 'place',      label: 'Место',      type: 'text' },
        ]},
        { key: 'spoilers',  label: 'Спойлеры',       icon: '🔒', order: 90, isSpoiler: true, infoboxFields: [] },
        { key: 'misc',      label: 'Прочее',         icon: '📎', order: 100, infoboxFields: [] },
    ];

    async function seedCategoriesForWorld(worldId) {
        for (const def of DEFAULT_CATEGORIES) {
            await dbPut('categories', {
                id: `${worldId}::cat-${def.key}`,
                worldId,
                key: def.key,
                label: def.label,
                icon: def.icon,
                order: def.order,
                isSpoiler: !!def.isSpoiler,
                infoboxFields: def.infoboxFields || [],
                builtin: true,
            });
        }
    }

    async function getCategoriesForWorld(worldId) {
        const all = await dbGetAll('categories');
        return all.filter(c => c.worldId === worldId).sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    async function getCategoryByKey(worldId, key) {
        return dbGet('categories', `${worldId}::cat-${key}`);
    }

    async function createCategory(worldId, { label, icon = '📎', isSpoiler = false }) {
        const key = `custom-${uid()}`;
        const all = await getCategoriesForWorld(worldId);
        const maxOrder = Math.max(0, ...all.map(c => c.order || 0));
        const cat = {
            id: `${worldId}::cat-${key}`,
            worldId, key, label, icon,
            order: maxOrder + 10,
            isSpoiler,
            infoboxFields: [],
            builtin: false,
        };
        await dbPut('categories', cat);
        status(`➕ Создана категория «${label}».`);
        return cat;
    }

    async function setCategoryInfoboxFields(catId, fields) {
        const c = await dbGet('categories', catId);
        if (!c) return;
        c.infoboxFields = fields;
        await dbPut('categories', c);
        status(`📋 Обновлены поля категории «${c.label}» (${fields.length} шт).`);
    }

    async function updateCategory(id, patch) {
        const c = await dbGet('categories', id);
        if (!c) return;
        Object.assign(c, patch);
        await dbPut('categories', c);
    }

    async function deleteCategory(id, fallbackKey = 'misc') {
        const c = await dbGet('categories', id);
        if (!c || c.builtin) {
            status('Встроенную категорию удалить нельзя.', 'warn');
            return;
        }
        // reassign articles
        const articles = await dbGetAll('articles');
        const inThis = articles.filter(a => a.worldId === c.worldId && a.categoryKey === c.key);
        for (const a of inThis) {
            a.categoryKey = fallbackKey;
            a.updatedAt = Date.now();
            await dbPut('articles', a);
        }
        await dbDelete('categories', id);
        status(`🗑 Удалена категория «${c.label}». Перенесено статей: ${inThis.length}.`);
    }

    // ── Player overlay (notes/favorite/read) ──────────────────
    // Stored in settings (kept separate from articles so re-import never wipes them).
    function getPlayerData(articleId) {
        const s = getSettings();
        return s.playerData[articleId] || { notes: '', favorite: false, read: false };
    }
    function setPlayerData(articleId, patch) {
        const s = getSettings();
        const cur = s.playerData[articleId] || { notes: '', favorite: false, read: false };
        s.playerData[articleId] = { ...cur, ...patch };
        saveSettings();
    }
    function clearPlayerData(articleId) {
        const s = getSettings();
        delete s.playerData[articleId];
        saveSettings();
    }

    // ── Player journal articles ───────────────────────────────
    // These are articles with sourceId starting "journal-" — created by the player,
    // not imported from any lorebook. They live inside their world's "journal" pseudo-source.
    async function ensureJournalSource(worldId) {
        const id = `${worldId}::src-journal`;
        let src = await dbGet('sources', id);
        if (!src) {
            src = {
                id, worldId,
                fileName: '(дневник игрока)',
                role: 'journal',
                importedAt: Date.now(),
                lastUpdate: Date.now(),
                entryCount: 0,
            };
            await dbPut('sources', src);
        }
        return src;
    }

    async function ensureJournalCategory(worldId) {
        const catId = `${worldId}::cat-journal`;
        let c = await dbGet('categories', catId);
        if (!c) {
            c = {
                id: catId, worldId,
                key: 'journal',
                label: 'Мой дневник',
                icon: '📓',
                order: 95,
                isSpoiler: false,
                infoboxFields: [],
                builtin: true,
            };
            await dbPut('categories', c);
        }
        return c;
    }

    async function createJournalArticle(worldId, title) {
        const src = await ensureJournalSource(worldId);
        await ensureJournalCategory(worldId);
        const u = Date.now() % 100000000;
        const a = {
            id: `${src.id}::entry-${u}-${Math.random().toString(36).slice(2,5)}`,
            worldId,
            sourceId: src.id,
            uid: u,
            title: title || 'Без названия',
            subtitle: '',
            categoryKey: 'journal',
            tags: [],
            spoiler: false,
            snippet: '',
            body: '',
            infobox: {},
            media: [],
            related: [],
            source: { keys: [], comment: title, disabled: false },
            manualEdits: ['title','subtitle','categoryKey','tags'],
            orphaned: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await dbPut('articles', a);
        status(`📓 Создана запись дневника «${a.title}».`);
        return a;
    }

    // ── Sources CRUD ───────────────────────────────────────────
    async function getSourcesForWorld(worldId) {
        const all = await dbGetAll('sources');
        return all.filter(s => s.worldId === worldId).sort((a, b) => (a.importedAt || 0) - (b.importedAt || 0));
    }

    async function createSource(worldId, fileName, role = 'main') {
        const id = `${worldId}::src-${uid()}`;
        const src = {
            id, worldId, fileName, role,
            importedAt: Date.now(),
            lastUpdate: Date.now(),
            entryCount: 0,
        };
        await dbPut('sources', src);
        status(`📄 Создан source «${fileName}» (${role}).`);
        return src;
    }

    async function updateSourceMeta(id, patch) {
        const s = await dbGet('sources', id);
        if (!s) return;
        Object.assign(s, patch);
        await dbPut('sources', s);
    }

    async function deleteSourceWithArticles(sourceId) {
        const s = await dbGet('sources', sourceId);
        if (!s) return;
        const articles = (await dbGetAll('articles')).filter(a => a.sourceId === sourceId);
        // Update map pins that referenced these articles → mark as orphan-link
        const map = await dbGet('maps', `${s.worldId}::map`);
        if (map?.pins?.length) {
            const ids = new Set(articles.map(a => a.id));
            map.pins = map.pins.map(p => ids.has(p.articleId) ? { ...p, articleId: null } : p);
            await dbPut('maps', map);
        }
        for (const a of articles) await dbDelete('articles', a.id);
        await dbDelete('sources', sourceId);
        status(`🗑 Удалён source «${s.fileName}» вместе с ${articles.length} статьями.`);
    }

    // ── World CRUD ─────────────────────────────────────────────
    async function getWorlds() {
        const all = await dbGetAll('worlds');
        return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    async function createWorld(name, sourceFileName = '') {
        const id = `world-${uid()}`;
        const world = {
            id, name,
            sourceFileName,
            description: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await dbPut('worlds', world);
        await seedCategoriesForWorld(id);
        status(`🌍 Создан мир «${name}».`);
        return world;
    }

    async function getCurrentWorld() {
        const s = getSettings();
        if (!s.currentWorldId) return null;
        return dbGet('worlds', s.currentWorldId);
    }

    async function setCurrentWorld(worldId) {
        const s = getSettings();
        s.currentWorldId = worldId;
        saveSettings();
        const w = await dbGet('worlds', worldId);
        if (w) status(`📚 Активный мир: «${w.name}».`);
        currentArticleId = null;
        if (isMobile()) mobileTab = 'catalog';
        await renderWorldSelector();
        await renderMobileWorldPill();
        await renderCatalog();
        await renderEmptyArticle();
        applyMobileTabClass();
    }

    // ── Migration v0.4.0 → v0.5.0 (per-world → per-source articles) ──
    async function migrateToSourcesIfNeeded() {
        const articles = await dbGetAll('articles');
        const orphans = articles.filter(a => !a.sourceId);
        if (orphans.length === 0) return false;

        status(`🔄 Миграция к multi-source: ${orphans.length} статей переезжают в source-привязку…`, 'warn');

        // group by world
        const byWorld = {};
        for (const a of orphans) (byWorld[a.worldId] = byWorld[a.worldId] || []).push(a);

        for (const wid of Object.keys(byWorld)) {
            const w = await dbGet('worlds', wid);
            const fileName = w?.sourceFileName || 'Unknown';
            const src = await createSource(wid, fileName, 'main');
            const list = byWorld[wid];
            const idMap = new Map(); // oldId → newId
            for (const a of list) idMap.set(a.id, `${src.id}::entry-${a.uid}`);

            // 1. Update map pins BEFORE re-iding articles
            const m = await dbGet('maps', `${wid}::map`);
            if (m?.pins?.length) {
                m.pins = m.pins.map(p => idMap.has(p.articleId)
                    ? { ...p, articleId: idMap.get(p.articleId) }
                    : p);
                await dbPut('maps', m);
            }

            // 2. Re-id articles
            for (const a of list) {
                const oldId = a.id;
                const newId = idMap.get(oldId);
                const updated = { ...a, id: newId, sourceId: src.id };
                await dbPut('articles', updated);
                if (newId !== oldId) await dbDelete('articles', oldId);
            }

            // 3. Update source entry count
            await updateSourceMeta(src.id, { entryCount: list.length });

            status(`✅ «${w?.name || wid}»: ${list.length} статей привязаны к «${fileName}».`);
        }
        return true;
    }

    // ── Migration v0.2.0 → v0.3.0 ──────────────────────────────
    async function migrateLegacyDataIfNeeded() {
        const articles = await dbGetAll('articles');
        const legacy = articles.filter(a => !a.worldId);
        if (legacy.length === 0) return false;

        status(`🔄 Миграция: найдено ${legacy.length} статей без world. Создаю мир «Импортированный мир»…`, 'warn');
        const world = await createWorld('Импортированный мир', '(legacy)');

        for (const a of legacy) {
            const newId = `${world.id}::entry-${a.uid}`;
            const updated = {
                ...a,
                id: newId,
                worldId: world.id,
                categoryKey: a.category || 'misc',
                tags: a.arc ? [a.arc] : (Array.isArray(a.tags) ? a.tags : []),
                spoiler: false,
                manualEdits: [],
                orphaned: false,
                infobox: a.infobox || {},
                media: a.media || [],
                related: a.related || [],
            };
            delete updated.category;
            delete updated.arc;
            await dbDelete('articles', a.id);
            await dbPut('articles', updated);
        }

        const s = getSettings();
        if (!s.currentWorldId) { s.currentWorldId = world.id; saveSettings(); }
        status(`✅ Мигрировано ${legacy.length} статей в «${world.name}».`);
        return true;
    }

    // ── Lorebook → Articles ────────────────────────────────────
    const EMOJI_CATEGORY = [
        { cat: 'character', re: /[\u{1F464}\u{1F9D1}\u{1F468}\u{1F469}\u{1F476}\u{1F9D2}\u{1F9D3}\u{1F9D9}-\u{1F9DF}\u{1F478}\u{1F934}\u{1F470}\u{1F471}\u{1F473}\u{1F474}\u{1F475}\u{1F46E}-\u{1F46F}\u{1F47C}-\u{1F47F}]/u },
        { cat: 'location',  re: /[\u{1F4CD}\u{1F5FA}\u{1F3DB}-\u{1F3F0}\u{1F3E0}-\u{1F3EC}\u{1F30B}\u{26F2}\u{1F305}\u{1F306}\u{1F307}\u{1F309}\u{1F30C}\u{1F3D5}\u{1F3D6}\u{1F3D7}\u{1F3D8}\u{1F3D9}\u{1F3DA}]/u },
        { cat: 'creature',  re: /[\u{1F400}-\u{1F43F}\u{1F980}-\u{1F9AE}\u{1F995}-\u{1F999}\u{1F47B}\u{1F432}\u{1F409}]/u },
        { cat: 'event',     re: /[\u{1F4C5}\u{1F4C6}\u{1F389}\u{1F38A}\u{1F38B}\u{1F38C}\u{1F38D}\u{1F38F}\u{1F396}\u{1F397}\u{1F3C6}\u{1F3C7}\u{1F3C1}\u{2694}]/u },
        { cat: 'faction',   re: /[\u{1F91D}\u{2694}\u{1F6E1}\u{1F3F4}\u{1F3F3}\u{2620}]/u },
        { cat: 'world',     re: /[\u{1F310}\u{1F30D}-\u{1F30F}\u{1F5FF}\u{26B0}]/u },
    ];

    function detectCategoryFromEmoji(s) {
        if (!s) return null;
        const head = s.trim().slice(0, 6);
        for (const { cat, re } of EMOJI_CATEGORY) if (re.test(head)) return cat;
        return null;
    }

    function categorizeByText(c) {
        c = c || '';
        if (/setting|world\s+rule|core\s+rule|reality/i.test(c))           return 'world';
        if (/\bmeetup\b|\bevent\b|\bplan\b|\bparty\b|\bparade\b/i.test(c)) return 'event';
        if (/\bcat\b|\bdog\b|кот[её]ныш|\bпёс\b|\banimal\b|\bpet\b/i.test(c)) return 'creature';
        if (/\b(friend|owner|lover|boyfriend|girlfriend|partner|brother|sister|mother|father|mom|dad|husband|wife|daughter|son|child|boy|girl|landlord|landlady|barista|the one who)\b/i.test(c)) return 'character';
        if (/\bdiscord\b|\bserver\b|\bgroup\b|community/i.test(c))         return 'faction';
        if (/\bhouse\b|\bbar\b|\bcity\b|\bcafe\b|\bclub\b|\blocation\b|residence|\bдом\b/i.test(c)) return 'location';
        if (/^[A-ZА-Я]/.test(c.trim())) return 'character';
        return 'misc';
    }

    function categorize(c) { return detectCategoryFromEmoji(c) || categorizeByText(c); }

    function extractTags(comment) {
        // collect all [Bracket] tags, return as array of unique strings
        const tags = [];
        const seen = new Set();
        const re = /\[([^\]]+)\]/g;
        let m;
        while ((m = re.exec(comment)) !== null) {
            const t = m[1].trim();
            if (t && !seen.has(t.toLowerCase())) {
                seen.add(t.toLowerCase());
                tags.push(t);
            }
        }
        return tags;
    }

    function cleanTitle(comment) {
        return comment.replace(/\[[^\]]+\]/g, '').trim();
    }

    function splitTitleSubtitle(cleaned) {
        const parts = cleaned.split(/\s*[—–]\s*|\s+-\s+/);
        if (parts.length >= 2 && parts[1]) {
            return { title: parts[0].trim(), subtitle: parts.slice(1).join(' — ').trim() };
        }
        return { title: cleaned, subtitle: '' };
    }

    function buildOriginalDataMap(lorebook) {
        const map = new Map();
        const od = lorebook.originalData;
        if (!od || !Array.isArray(od.entries)) return map;
        for (const oe of od.entries) {
            if (oe && typeof oe.id === 'number') map.set(oe.id, oe);
        }
        return map;
    }

    function pickBestComment(liveComment, originalEntry) {
        const oc = originalEntry?.comment;
        if (!oc) return liveComment;
        const liveHasSep = /\s*[—–]\s*|\s+-\s+/.test(liveComment);
        const origHasSep = /\s*[—–]\s*|\s+-\s+/.test(oc);
        if (origHasSep && !liveHasSep) return oc;
        return oc.length > liveComment.length ? oc : liveComment;
    }

    function lorebookToArticles(lorebook, worldId, sourceId) {
        const entries = lorebook.entries || {};
        const originalMap = buildOriginalDataMap(lorebook);
        const out = [];
        const seen = new Set();
        for (const k of Object.keys(entries)) {
            const e = entries[k];
            if (!e) continue;
            const liveComment = e.comment || `Entry ${e.uid ?? k}`;
            const originalEntry = originalMap.get(e.uid);
            const fullComment = pickBestComment(liveComment, originalEntry);
            const tags = extractTags(fullComment);
            const cleaned = cleanTitle(fullComment);
            const { title, subtitle } = splitTitleSubtitle(cleaned);
            const dedupeKey = `${title.toLowerCase()}|${subtitle.toLowerCase()}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const entryUid = e.uid ?? Number(k);
            out.push({
                id: `${sourceId}::entry-${entryUid}`,
                worldId,
                sourceId,
                uid: entryUid,
                title,
                subtitle,
                categoryKey: categorize(fullComment),
                tags,
                spoiler: false,
                snippet: e.content || '',
                body: '',
                infobox: {},
                media: [],
                related: [],
                source: {
                    keys: Array.isArray(e.key) ? e.key : [],
                    comment: fullComment,
                    disabled: !!e.disable,
                },
                manualEdits: [],
                orphaned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
        }
        return out;
    }

    // ── Smart merge ────────────────────────────────────────────
    // Scoped to a single source — re-importing source A does NOT touch articles from source B.
    async function smartMergeImport(lorebook, worldId, sourceId) {
        const fresh = lorebookToArticles(lorebook, worldId, sourceId);
        const all = await dbGetAll('articles');
        const inSource = all.filter(a => a.sourceId === sourceId);
        const byUid = new Map(inSource.map(a => [a.uid, a]));

        let added = 0, updated = 0, orphaned = 0, restored = 0;
        const seenUids = new Set();

        for (const f of fresh) {
            seenUids.add(f.uid);
            const old = byUid.get(f.uid);
            if (!old) {
                await dbPut('articles', f);
                added++;
                continue;
            }
            const wasOrphaned = !!old.orphaned;
            const me = old.manualEdits || [];
            const merged = {
                ...f,
                title:       me.includes('title')       ? old.title       : f.title,
                subtitle:    me.includes('subtitle')    ? old.subtitle    : f.subtitle,
                categoryKey: me.includes('categoryKey') ? old.categoryKey : f.categoryKey,
                tags:        me.includes('tags')        ? old.tags        : (old.tags?.length ? old.tags : f.tags),
                body:        old.body || '',
                media:       old.media || [],
                infobox:     old.infobox || {},
                related:     old.related || [],
                spoiler:     !!old.spoiler,
                manualEdits: me,
                orphaned:    false,
                createdAt:   old.createdAt,
                updatedAt:   Date.now(),
            };
            await dbPut('articles', merged);
            if (wasOrphaned) restored++;
            updated++;
        }

        for (const old of inSource) {
            if (!seenUids.has(old.uid) && !old.orphaned) {
                old.orphaned = true;
                old.updatedAt = Date.now();
                await dbPut('articles', old);
                orphaned++;
            }
        }

        // Update source meta
        await updateSourceMeta(sourceId, {
            lastUpdate: Date.now(),
            entryCount: fresh.length,
        });

        return { added, updated, orphaned, restored, total: fresh.length };
    }

    // ── Image storage ──────────────────────────────────────────
    const IMAGE_MAX_DIM = 1920;
    const IMAGE_QUALITY = 0.85;
    const IMAGE_MAX_INPUT_BYTES = 50 * 1024 * 1024; // hard reject above 50MB

    function fmtBytes(n) {
        if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
        if (n > 1024) return `${Math.round(n / 1024)} КБ`;
        return `${n} Б`;
    }

    async function resizeImageIfNeeded(file) {
        // Returns { blob, type, finalSize, resized, dims }
        // GIFs and other animated formats — keep as-is (canvas would lose animation).
        if (file.type === 'image/gif' || file.type === 'image/webp') {
            return { blob: file, type: file.type, finalSize: file.size, resized: false };
        }
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const { width, height } = img;
                const tooBig = width > IMAGE_MAX_DIM || height > IMAGE_MAX_DIM;
                const tooHeavy = file.size > 1024 * 1024; // > 1 MB → recompress
                if (!tooBig && !tooHeavy) {
                    resolve({ blob: file, type: file.type, finalSize: file.size, resized: false });
                    return;
                }
                const scale = Math.min(IMAGE_MAX_DIM / width, IMAGE_MAX_DIM / height, 1);
                const newW = Math.round(width * scale);
                const newH = Math.round(height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = newW;
                canvas.height = newH;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, newW, newH);
                const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                canvas.toBlob((blob) => {
                    if (!blob) { reject(new Error('Не удалось сжать картинку')); return; }
                    resolve({
                        blob, type: outType, finalSize: blob.size, resized: true,
                        dims: { from: { w: width, h: height }, to: { w: newW, h: newH } },
                    });
                }, outType, IMAGE_QUALITY);
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть картинку')); };
            img.src = url;
        });
    }

    async function saveImageBlob(file) {
        if (!file.type.startsWith('image/')) throw new Error('Это не картинка.');
        if (file.size > IMAGE_MAX_INPUT_BYTES) throw new Error(`Файл больше ${fmtBytes(IMAGE_MAX_INPUT_BYTES)}.`);
        const result = await resizeImageIfNeeded(file);
        const id = `img-${uid()}`;
        await dbPut('media', {
            id,
            blob: result.blob,
            name: file.name,
            type: result.type,
            size: result.finalSize,
            originalSize: file.size,
            createdAt: Date.now(),
        });
        if (result.resized) {
            const ratio = Math.round((1 - result.finalSize / file.size) * 100);
            status(`📷 «${file.name}»: ${fmtBytes(file.size)} → ${fmtBytes(result.finalSize)} (-${ratio}%, ${result.dims.to.w}×${result.dims.to.h})`);
        } else {
            status(`📷 Сохранена «${file.name}» (${fmtBytes(result.finalSize)})`);
        }
        return id;
    }

    const liveURLs = new Set();
    function trackURL(url) { liveURLs.add(url); return url; }
    function revokeAllURLs() { for (const u of liveURLs) URL.revokeObjectURL(u); liveURLs.clear(); }

    async function getImageURL(id) {
        const rec = await dbGet('media', id);
        if (!rec || !rec.blob) return null;
        return trackURL(URL.createObjectURL(rec.blob));
    }

    // ── Spoilers ───────────────────────────────────────────────
    function renderBodyWithSpoilers(text, showAll) {
        const html = escHtml(text);
        if (showAll) {
            return html.replace(/\|\|([^|]+)\|\|/g, '<span class="kms-spoiler kms-spoiler-revealed">$1</span>');
        }
        return html.replace(/\|\|([^|]+)\|\|/g,
            '<span class="kms-spoiler" data-kms-spoiler tabindex="0" title="клик чтобы раскрыть">$1</span>');
    }

    // ── Auto-glossary ──────────────────────────────────────────
    // Find mentions of OTHER articles' titles (or their lorebook regex-keys) inside body
    // and turn them into links. Longest matches win; already-linked ranges aren't re-linked.

    function escapeRegexLiteral(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function compileGlossaryPatterns(articles) {
        // returns: [{ regex, articleId, title, snippet }] sorted longest-first
        const patterns = [];
        for (const a of articles) {
            if (!a.title) continue;
            // 1) Extract usable regex keys from lorebook source.keys (if any).
            //    Keys come as strings like "/foo/i" or plain text. Skip plain text duplicates of title.
            const keys = (a.source?.keys || []).filter(k => typeof k === 'string');
            let usedRegex = false;
            for (const k of keys) {
                const m = k.match(/^\/(.+)\/([gimsuy]*)$/);
                if (!m) continue;
                try {
                    // We strip 'g' flag (we use match, not exec-loop) and ensure 'u' for unicode safety
                    let flags = (m[2] || '').replace(/g/g, '');
                    if (!flags.includes('i')) flags += 'i';
                    const re = new RegExp(m[1], flags);
                    patterns.push({ regex: re, articleId: a.id, title: a.title, snippet: shortSnippet(a) });
                    usedRegex = true;
                } catch (_) { /* skip bad regex */ }
            }
            // 2) Fallback: literal title with word boundaries
            if (!usedRegex) {
                const lit = escapeRegexLiteral(a.title);
                // Cyrillic-friendly boundary: not letter on either side
                const re = new RegExp(`(?<![\\p{L}\\p{N}])${lit}(?![\\p{L}\\p{N}])`, 'iu');
                patterns.push({ regex: re, articleId: a.id, title: a.title, snippet: shortSnippet(a) });
            }
        }
        // Longest title first, so "Tyoma's House" wins over "Tyoma"
        patterns.sort((a, b) => (b.title?.length || 0) - (a.title?.length || 0));
        return patterns;
    }

    function shortSnippet(a) {
        const src = (a.body || a.snippet || '').replace(/\s+/g, ' ').trim();
        return src.slice(0, 110) + (src.length > 110 ? '…' : '');
    }

    // Trim non-content punctuation/whitespace from a match (some lorebook regexes
    // capture leading boundary char like a space because they use groups not lookbehinds)
    const TRIM_LEAD = /^[\s.,;:!?\-—()«»\[\]"'@#%&*+=<>]+/;
    const TRIM_TAIL = /[\s.,;:!?\-—()«»\[\]"'@#%&*+=<>]+$/;

    function linkifyBody(text, otherArticles, showSpoilers) {
        if (!text) return '';

        // Step 1: split raw text by spoiler blocks ||...||
        const blocks = []; // [{text, isSpoiler}]
        let lastEnd = 0;
        const spoilerRe = /\|\|([^|]+)\|\|/g;
        let m;
        while ((m = spoilerRe.exec(text)) !== null) {
            if (m.index > lastEnd) blocks.push({ text: text.slice(lastEnd, m.index), isSpoiler: false });
            blocks.push({ text: m[1], isSpoiler: true });
            lastEnd = spoilerRe.lastIndex;
        }
        if (lastEnd < text.length) blocks.push({ text: text.slice(lastEnd), isSpoiler: false });

        // Step 2: glossary patterns
        const patterns = otherArticles?.length ? compileGlossaryPatterns(otherArticles) : [];

        // Step 3: render each block — apply glossary on RAW text, then escape, then wrap if spoiler
        return blocks.map(block => {
            const inner = applyGlossaryToRawText(block.text, patterns);
            if (block.isSpoiler) {
                const cls = showSpoilers ? 'kms-spoiler kms-spoiler-revealed' : 'kms-spoiler';
                const attrs = showSpoilers ? '' : 'data-kms-spoiler tabindex="0" title="клик чтобы раскрыть"';
                return `<span class="${cls}" ${attrs}>${inner}</span>`;
            }
            return inner;
        }).join('');
    }

    function applyGlossaryToRawText(text, patterns) {
        if (!text) return '';
        if (!patterns.length) return escHtml(text);

        // segments: 'text' (raw, not escaped yet) | 'link' (resolved)
        let segments = [{ text, type: 'text' }];

        for (const p of patterns) {
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (seg.type !== 'text') continue;
                const m = seg.text.match(p.regex);
                if (!m || m.index === undefined) continue;

                // Trim non-content boundary chars from match
                let matchText = m[0];
                const lead = matchText.match(TRIM_LEAD);
                let leadStr = '';
                if (lead) { leadStr = lead[0]; matchText = matchText.slice(leadStr.length); }
                const tail = matchText.match(TRIM_TAIL);
                let tailStr = '';
                if (tail) { tailStr = tail[0]; matchText = matchText.slice(0, matchText.length - tailStr.length); }
                if (!matchText) continue; // pure punctuation, skip

                const matchStart = m.index + leadStr.length;
                const matchEnd = matchStart + matchText.length;
                const before = seg.text.slice(0, matchStart);
                const after = seg.text.slice(matchEnd);

                segments.splice(i, 1,
                    { text: before, type: 'text' },
                    { text: matchText, type: 'link', articleId: p.articleId, snippet: p.snippet },
                    { text: after, type: 'text' }
                );
                i += 1; // skip the link segment we just inserted
            }
        }

        return segments.map(seg => {
            if (seg.type === 'link') {
                return `<a href="#" class="kms-glossary-link" data-kms-glossary-link="${escAttr(seg.articleId)}" title="${escAttr(seg.snippet)}">${escHtml(seg.text)}</a>`;
            }
            return escHtml(seg.text);
        }).join('');
    }

    function escAttr(s) {
        return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // ── UI helpers ─────────────────────────────────────────────
    function escHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }
    function fmtTime(ts) {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ── Drawer ─────────────────────────────────────────────────
    let drawerEl = null;
    let currentArticleId = null;
    let activeTagFilter = null;
    let isOpen = false;
    const mentionedArticleIds = new Set(); // article ids mentioned in last chat msg (live tracking)

    // ── Mobile state ──────────────────────────────────────────
    const MOBILE_BREAKPOINT = 820;
    let mobileTab = 'catalog'; // 'catalog' | 'article' | 'map'
    let mapImmersive = false;
    function isMobile() { return window.innerWidth <= MOBILE_BREAKPOINT; }
    function applyMobileClass() {
        if (!drawerEl) return;
        drawerEl.classList.toggle('kms-mobile', isMobile());
        applyMobileTabClass();
    }
    function applyMobileTabClass() {
        if (!drawerEl) return;
        drawerEl.classList.remove('kms-mtab-catalog', 'kms-mtab-article', 'kms-mtab-map', 'kms-mtab-more');
        drawerEl.classList.add(`kms-mtab-${mobileTab}`);
        // bottom tab active state
        drawerEl.querySelectorAll('[data-mtab]').forEach(el => {
            el.classList.toggle('kms-mtab-on', el.dataset.mtab === mobileTab);
        });
        // article tab disabled if no article picked
        const articleTab = drawerEl.querySelector('[data-mtab="article"]');
        if (articleTab) articleTab.classList.toggle('kms-mtab-disabled', !currentArticleId);
        // back button visibility
        const back = drawerEl.querySelector('[data-kms-mback]');
        if (back) back.hidden = !(mobileTab === 'article' || mobileTab === 'map');
        updateMobileCrumb();
    }
    function switchMobileTab(tab) {
        mobileTab = tab;
        applyMobileTabClass();
        if (tab === 'article' && currentArticleId) {
            renderArticle(currentArticleId);
        } else if (tab === 'map') {
            renderMapView();
        } else if (tab === 'catalog') {
            renderCatalog();
            renderEmptyArticle();
        }
    }
    function updateMobileCrumb() {
        if (!drawerEl) return;
        const crumb = drawerEl.querySelector('[data-kms-mcrumb]');
        if (!crumb) return;
        if (mobileTab === 'catalog') {
            crumb.hidden = true;
        } else if (mobileTab === 'article' && currentArticleId) {
            crumb.hidden = false;
            // Title is set in renderReader
        } else if (mobileTab === 'map') {
            crumb.hidden = false;
            crumb.textContent = 'Карта';
        }
    }

    function updateFilterButtons() {
        if (!drawerEl) return;
        const cur = getSettings().catalogFilter || 'all';
        drawerEl.querySelectorAll('[data-kms-filter]').forEach(el => {
            el.classList.toggle('kms-mini-active', el.dataset.kmsFilter === cur);
        });
    }

    async function openRandomArticle() {
        const w = await getCurrentWorld();
        if (!w) return;
        const articles = (await dbGetAll('articles'))
            .filter(a => a.worldId === w.id && !a.spoiler && !a.orphaned);
        if (articles.length === 0) { status('Нет статей для случайного выбора.', 'warn'); return; }
        const pick = articles[Math.floor(Math.random() * articles.length)];
        status(`🎲 Случайно: «${pick.title}»`);
        renderArticle(pick.id);
    }

    function buildDrawer() {
        const root = document.createElement('aside');
        root.id = 'kms-drawer';
        root.className = 'kms-drawer kms-closed';
        root.innerHTML = `
            <div class="kms-drawer-inner">

                <!-- Mobile top bar (only visible on .kms-mobile) -->
                <header class="kms-mtopbar">
                    <button class="kms-mback" data-kms-mback hidden title="Назад">←</button>
                    <button class="kms-mworld" data-kms-mworld title="Сменить мир">
                        <span class="kms-mworld-icon">🌍</span>
                        <span class="kms-mworld-name" data-kms-mworld-name>—</span>
                        <span class="kms-mworld-arrow">▾</span>
                    </button>
                    <span class="kms-mcrumb" data-kms-mcrumb hidden></span>
                    <button class="kms-icon-btn" data-kms-msearch title="Поиск">🔍</button>
                    <button class="kms-icon-btn" data-kms-mmore title="Меню">⋮</button>
                    <button class="kms-icon-btn kms-mclose-btn" data-kms-mclose title="Закрыть библиотеку">✕</button>
                </header>

                <header class="kms-topbar">
                    <div class="kms-title-block">
                        <span class="kms-icon">📖</span>
                        <span class="kms-title">Know My Setting</span>
                        <span class="kms-version">v${VERSION}</span>
                    </div>
                    <div class="kms-toolbar">
                        <button class="kms-btn kms-btn-ghost" data-kms-toasts-toggle title="Уведомления о упоминаниях">🔔</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-spoilers-toggle title="Показать/скрыть все спойлеры">🔒</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-creator-toggle title="Режим креатора">✏️</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-fullscreen-toggle title="На весь экран">⛶</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-close aria-label="Закрыть">✕</button>
                    </div>
                </header>

                <div class="kms-worldbar">
                    <button class="kms-btn kms-btn-ghost kms-catalog-toggle-btn" data-kms-catalog-toggle title="Скрыть/показать каталог">☰</button>
                    <div class="kms-world-selector" data-kms-world-selector></div>
                    <div class="kms-world-actions">
                        <button class="kms-btn" data-kms-import title="Импорт ST-лорбука">📥 Лорбук</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-show-map title="Карта мира">🗺</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-sources-manager title="Лорбуки в этом мире">📚</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-cats-manager title="Категории">⚙️</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-export title="Экспорт мира в .kms.json">📦</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-bundle-import title="Импорт пакета (.kms.json)">📂</button>
                        <input type="file" accept=".kms.json,application/json" class="kms-file-input" data-kms-file-bundle hidden/>
                    </div>
                </div>

                <div class="kms-body">
                    <aside class="kms-catalog">
                        <input class="kms-search" type="search" placeholder="Поиск по миру…" data-kms-search/>
                        <div class="kms-catalog-filters">
                            <button class="kms-mini-btn" data-kms-filter="all" title="все статьи">all</button>
                            <button class="kms-mini-btn" data-kms-filter="favorite" title="только избранное">⭐</button>
                            <button class="kms-mini-btn" data-kms-filter="unread" title="непрочитанные">●</button>
                            <button class="kms-mini-btn" data-kms-filter="read" title="прочитанные">✓</button>
                            <span class="kms-catalog-spacer"></span>
                            <button class="kms-mini-btn" data-kms-random title="случайная статья">🎲</button>
                            <button class="kms-mini-btn" data-kms-new-journal title="новая запись в дневник">+📓</button>
                        </div>
                        <div class="kms-tag-cloud" data-kms-tag-cloud hidden></div>
                        <nav class="kms-nav"></nav>
                    </aside>
                    <main class="kms-article">
                        <div class="kms-empty">
                            <h2>Библиотека пуста</h2>
                            <p>Импортируй ST-лорбук — я создам мир и разложу всё по полочкам.</p>
                        </div>
                    </main>
                </div>

                <footer class="kms-statusbar" data-kms-status>
                    <span class="kms-status-dot"></span>
                    <span class="kms-status-msg">Готов к работе.</span>
                    <button class="kms-status-toggle" data-kms-status-toggle title="Журнал событий">⌃</button>
                </footer>
                <div class="kms-status-log" data-kms-status-log hidden>
                    <div class="kms-status-log-head">
                        <span>Журнал событий</span>
                        <button class="kms-btn kms-btn-ghost" data-kms-status-clear>Очистить</button>
                    </div>
                    <ul class="kms-status-log-list"></ul>
                </div>

                <input type="file" accept="application/json,.json" class="kms-file-input" data-kms-file-lorebook hidden/>

                <!-- Mobile bottom tabs (only visible on .kms-mobile) -->
                <nav class="kms-mtabs">
                    <button class="kms-mtab" data-mtab="catalog">
                        <span class="kms-mtab-ico">📚</span><span class="kms-mtab-lbl">Каталог</span>
                    </button>
                    <button class="kms-mtab" data-mtab="article">
                        <span class="kms-mtab-ico">📖</span><span class="kms-mtab-lbl">Статья</span>
                    </button>
                    <button class="kms-mtab" data-mtab="map">
                        <span class="kms-mtab-ico">🗺</span><span class="kms-mtab-lbl">Карта</span>
                    </button>
                    <button class="kms-mtab" data-mtab="more">
                        <span class="kms-mtab-ico">⋯</span><span class="kms-mtab-lbl">Ещё</span>
                    </button>
                </nav>
            </div>
            <div class="kms-resize-handle" data-kms-resize title="Потяни, чтобы изменить ширину"></div>
        `;
        document.body.appendChild(root);

        root.querySelector('[data-kms-close]').addEventListener('click', closeDrawer);
        root.querySelector('[data-kms-import]').addEventListener('click', () =>
            root.querySelector('[data-kms-file-lorebook]').click());
        root.querySelector('[data-kms-file-lorebook]').addEventListener('change', onLorebookSelected);
        root.querySelector('[data-kms-search]').addEventListener('input', () => renderCatalog());
        root.querySelector('[data-kms-creator-toggle]').addEventListener('click', toggleCreatorMode);
        root.querySelector('[data-kms-spoilers-toggle]').addEventListener('click', toggleSpoilersGlobal);
        root.querySelector('[data-kms-toasts-toggle]').addEventListener('click', toggleToasts);
        root.querySelector('[data-kms-status-toggle]').addEventListener('click', toggleStatusLog);
        root.querySelector('[data-kms-status-clear]').addEventListener('click', clearEventLog);
        root.querySelector('[data-kms-cats-manager]').addEventListener('click', renderCategoriesManager);
        root.querySelector('[data-kms-sources-manager]').addEventListener('click', renderSourcesManager);
        root.querySelector('[data-kms-export]').addEventListener('click', exportCurrentWorld);
        root.querySelector('[data-kms-bundle-import]').addEventListener('click', () =>
            root.querySelector('[data-kms-file-bundle]').click());
        root.querySelector('[data-kms-file-bundle]').addEventListener('change', onBundleSelected);
        root.querySelector('[data-kms-show-map]').addEventListener('click', renderMapView);
        root.querySelector('[data-kms-fullscreen-toggle]').addEventListener('click', toggleFullscreen);
        root.querySelector('[data-kms-catalog-toggle]').addEventListener('click', toggleCatalogCollapsed);
        root.querySelectorAll('[data-kms-filter]').forEach(el => el.addEventListener('click', () => {
            const s = getSettings();
            s.catalogFilter = el.dataset.kmsFilter;
            saveSettings();
            renderCatalog();
            updateFilterButtons();
        }));
        root.querySelector('[data-kms-random]').addEventListener('click', openRandomArticle);
        root.querySelector('[data-kms-new-journal]').addEventListener('click', async () => {
            const w = await getCurrentWorld();
            if (!w) { status('Сначала создай мир.', 'warn'); return; }
            const title = prompt('Название записи:', 'Без названия');
            if (!title) return;
            const a = await createJournalArticle(w.id, title.trim());
            await renderCatalog();
            renderArticle(a.id);
        });

        bindResize(root.querySelector('[data-kms-resize]'), root);

        // ── Mobile bindings ────────────────────────────────
        root.querySelectorAll('[data-mtab]').forEach(el => {
            el.addEventListener('click', () => {
                const t = el.dataset.mtab;
                if (t === 'more') { openMoreMenuSheet(); return; }
                if (t === 'article' && !currentArticleId) {
                    status('Сначала выбери статью в каталоге.', 'warn');
                    return;
                }
                switchMobileTab(t);
            });
        });
        root.querySelector('[data-kms-mback]').addEventListener('click', () => {
            // Map immersive mode → exit instead of back
            if (mobileTab === 'map' && mapImmersive) { mapImmersive = false; root.classList.remove('kms-map-immersive'); return; }
            switchMobileTab('catalog');
        });
        root.querySelector('[data-kms-mworld]').addEventListener('click', openWorldSwitcherSheet);
        root.querySelector('[data-kms-msearch]').addEventListener('click', openSearchOverlay);
        root.querySelector('[data-kms-mmore]').addEventListener('click', openMoreMenuSheet);
        root.querySelector('[data-kms-mclose]').addEventListener('click', closeDrawer);

        // Re-apply mobile class on resize
        window.addEventListener('resize', applyMobileClass);

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && isOpen && !document.querySelector('.kms-lightbox') && !document.querySelector('.kms-modal-overlay')) {
                closeDrawer();
            }
        });

        const s = getSettings();
        root.style.width = `${s.drawerWidth}px`;
        if (s.creatorMode) root.classList.add('kms-creator-on');
        if (s.showSpoilersGlobal) root.classList.add('kms-spoilers-on');
        if (s.statusLogOpen) root.querySelector('[data-kms-status-log]').hidden = false;
        if (s.fullscreen) root.classList.add('kms-fullscreen');
        if (s.catalogCollapsed) root.classList.add('kms-catalog-collapsed');
        if (s.mentionToasts) root.classList.add('kms-toasts-on');

        return root;
    }

    function toggleToasts() {
        const s = getSettings();
        s.mentionToasts = !s.mentionToasts;
        saveSettings();
        drawerEl.classList.toggle('kms-toasts-on', s.mentionToasts);
        status(s.mentionToasts ? '🔔 Уведомления включены.' : '🔕 Уведомления выключены.');
    }

    function toggleFullscreen() {
        const s = getSettings();
        s.fullscreen = !s.fullscreen;
        saveSettings();
        drawerEl.classList.toggle('kms-fullscreen', s.fullscreen);
        status(s.fullscreen ? '⛶ Во весь экран.' : '↘ Обратно в drawer.');
    }

    function toggleCatalogCollapsed() {
        const s = getSettings();
        s.catalogCollapsed = !s.catalogCollapsed;
        saveSettings();
        drawerEl.classList.toggle('kms-catalog-collapsed', s.catalogCollapsed);
    }

    function ensureDrawer() {
        if (!drawerEl) drawerEl = buildDrawer();
        return drawerEl;
    }

    async function openDrawer() {
        const d = ensureDrawer();
        void d.offsetWidth;
        d.classList.remove('kms-closed');
        isOpen = true;
        applyMobileClass();
        await ensureSomeWorld();
        await renderWorldSelector();
        await renderMobileWorldPill();
        await renderCatalog();
        renderStatus();
        if (currentArticleId) await renderArticle(currentArticleId);
        else await renderEmptyArticle();
        applyMobileTabClass();
        status('Библиотека открыта.');
    }

    async function renderMobileWorldPill() {
        if (!drawerEl) return;
        const el = drawerEl.querySelector('[data-kms-mworld-name]');
        if (!el) return;
        const w = await getCurrentWorld();
        el.textContent = w?.name || 'нет мира';
    }

    function closeDrawer() {
        if (!drawerEl) return;
        drawerEl.classList.add('kms-closed');
        isOpen = false;
        setTimeout(revokeAllURLs, 400);
    }

    async function ensureSomeWorld() {
        const s = getSettings();
        if (s.currentWorldId) {
            const w = await dbGet('worlds', s.currentWorldId);
            if (w) return;
        }
        const all = await getWorlds();
        if (all.length > 0) {
            s.currentWorldId = all[0].id;
            saveSettings();
        }
    }

    function toggleCreatorMode() {
        const s = getSettings();
        s.creatorMode = !s.creatorMode;
        saveSettings();
        drawerEl.classList.toggle('kms-creator-on', s.creatorMode);
        status(s.creatorMode ? '✏️ Режим креатора включён.' : '👁 Режим читателя.');
        if (currentArticleId) renderArticle(currentArticleId);
    }

    function toggleSpoilersGlobal() {
        const s = getSettings();
        s.showSpoilersGlobal = !s.showSpoilersGlobal;
        saveSettings();
        drawerEl.classList.toggle('kms-spoilers-on', s.showSpoilersGlobal);
        status(s.showSpoilersGlobal ? '🔓 Спойлеры показываются.' : '🔒 Спойлеры скрыты.');
        renderCatalog();
        if (currentArticleId) renderArticle(currentArticleId);
    }

    // ── Resize ─────────────────────────────────────────────────
    function bindResize(handle, drawer) {
        let dragging = false;
        const MIN = 360, MAX_FRAC = 0.9;
        const onMove = (e) => {
            if (!dragging) return;
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            const max = Math.floor(window.innerWidth * MAX_FRAC);
            const w = Math.max(MIN, Math.min(max, x));
            drawer.style.width = `${w}px`;
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('kms-resizing');
            const w = parseInt(drawer.style.width, 10) || defaults.drawerWidth;
            const s = getSettings();
            s.drawerWidth = w;
            saveSettings();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
        };
        const onDown = (e) => {
            dragging = true;
            document.body.classList.add('kms-resizing');
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            window.addEventListener('touchmove', onMove, { passive: true });
            window.addEventListener('touchend', onUp);
            e.preventDefault();
        };
        handle.addEventListener('mousedown', onDown);
        handle.addEventListener('touchstart', onDown, { passive: false });
    }

    // ── Status panel ───────────────────────────────────────────
    function renderStatus() {
        if (!drawerEl) return;
        const last = eventLog[0];
        const bar = drawerEl.querySelector('.kms-status-msg');
        const dot = drawerEl.querySelector('.kms-status-dot');
        if (bar) bar.textContent = last ? `${fmtTime(last.ts)} · ${last.msg}` : 'Готов к работе.';
        if (dot) dot.dataset.level = last?.level || 'idle';
        const list = drawerEl.querySelector('.kms-status-log-list');
        if (list) {
            list.innerHTML = eventLog.slice(0, 50).map(e => `
                <li class="kms-log-item kms-log-${e.level}">
                    <span class="kms-log-time">${fmtTime(e.ts)}</span>
                    <span class="kms-log-msg">${escHtml(e.msg)}</span>
                </li>
            `).join('');
        }
    }

    function toggleStatusLog() {
        const log = drawerEl.querySelector('[data-kms-status-log]');
        if (!log) return;
        log.hidden = !log.hidden;
        const s = getSettings();
        s.statusLogOpen = !log.hidden;
        saveSettings();
    }

    // ── World selector ─────────────────────────────────────────
    async function renderWorldSelector() {
        if (!drawerEl) return;
        const el = drawerEl.querySelector('[data-kms-world-selector]');
        const worlds = await getWorlds();
        const current = await getCurrentWorld();

        if (worlds.length === 0) {
            el.innerHTML = `<span class="kms-world-empty">нет миров</span>`;
            return;
        }

        const opts = worlds.map(w =>
            `<option value="${escHtml(w.id)}" ${w.id === current?.id ? 'selected' : ''}>${escHtml(w.name)}</option>`
        ).join('');

        el.innerHTML = `
            <span class="kms-world-icon">🌍</span>
            <select class="kms-world-select" data-kms-world-pick>${opts}</select>
            <button class="kms-btn kms-btn-ghost kms-world-rename" data-kms-world-rename title="Переименовать">✎</button>
        `;
        el.querySelector('[data-kms-world-pick]').addEventListener('change', e => setCurrentWorld(e.target.value));
        el.querySelector('[data-kms-world-rename]').addEventListener('click', renameCurrentWorld);
    }

    async function renameCurrentWorld() {
        const w = await getCurrentWorld();
        if (!w) return;
        const next = prompt('Новое имя мира:', w.name);
        if (!next || next.trim() === w.name) return;
        w.name = next.trim();
        w.updatedAt = Date.now();
        await dbPut('worlds', w);
        status(`📝 Мир переименован: «${w.name}».`);
        await renderWorldSelector();
    }

    // ── Import flow ────────────────────────────────────────────
    async function onLorebookSelected(e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
            status(`📥 Чтение «${file.name}»…`);
            const text = await file.text();
            const json = JSON.parse(text);
            if (!json?.entries) throw new Error('Это не похоже на ST-лорбук — нет поля "entries".');

            const choice = await chooseImportTarget(file.name);
            if (!choice) { status('Импорт отменён.'); return; }

            let world, source;
            if (choice.action === 'newWorld') {
                world = await createWorld(choice.name, file.name);
                source = await createSource(world.id, file.name, choice.role || 'main');
            } else if (choice.action === 'newSource') {
                world = await dbGet('worlds', choice.worldId);
                source = await createSource(world.id, file.name, choice.role || 'addon');
            } else { // updateSource
                world = await dbGet('worlds', choice.worldId);
                source = await dbGet('sources', choice.sourceId);
                // update fileName if it changed
                if (source.fileName !== file.name) {
                    await updateSourceMeta(source.id, { fileName: file.name });
                }
            }

            const s = getSettings();
            s.currentWorldId = world.id;
            saveSettings();

            status(`🔍 Smart merge в source «${source.fileName}» (${world.name})…`);
            const r = await smartMergeImport(json, world.id, source.id);
            world.updatedAt = Date.now();
            await dbPut('worlds', world);

            s.lastImport = { fileName: file.name, worldId: world.id, sourceId: source.id, ...r, at: Date.now() };
            saveSettings();

            const parts = [
                r.added    ? `новых: ${r.added}`             : '',
                r.updated  ? `обновлено: ${r.updated}`       : '',
                r.restored ? `восстановлено: ${r.restored}`  : '',
                r.orphaned ? `осталось без пары: ${r.orphaned}` : '',
            ].filter(Boolean).join(', ');
            status(`✅ Импорт «${file.name}» в «${world.name}» (${parts || 'без изменений'}).`);

            await renderWorldSelector();
            await renderCatalog();
            const articles = (await dbGetAll('articles')).filter(a => a.worldId === world.id);
            if (articles[0]) await renderArticle(articles[0].id);
        } catch (err) {
            status(`❌ Импорт не удался: ${err.message}`, 'error');
        } finally {
            e.target.value = '';
        }
    }

    async function chooseImportTarget(fileName) {
        const worlds = await getWorlds();
        // For each world, fetch its sources
        const worldSources = {};
        for (const w of worlds) {
            worldSources[w.id] = await getSourcesForWorld(w.id);
        }

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'kms-modal-overlay';

            const defaultName = fileName.replace(/\.json$/i,'').slice(0,40);

            overlay.innerHTML = `
                <div class="kms-dialog">
                    <h3>Импорт лорбука</h3>
                    <p class="kms-dialog-sub">«${escHtml(fileName)}»</p>

                    <label class="kms-radio-row">
                        <input type="radio" name="kms-target" value="newWorld" checked/>
                        <span>🌍 Создать <b>новый мир</b></span>
                    </label>
                    <input type="text" class="kms-dialog-input kms-indent" data-kms-new-name placeholder="Имя нового мира" value="${escHtml(defaultName)}"/>

                    ${worlds.length ? `
                    <label class="kms-radio-row">
                        <input type="radio" name="kms-target" value="newSource"/>
                        <span>📄 Добавить как <b>новый source</b> в существующий мир</span>
                    </label>
                    <select class="kms-dialog-input kms-indent" data-kms-newsource-world disabled>
                        ${worlds.map(w => `<option value="${escHtml(w.id)}">${escHtml(w.name)}</option>`).join('')}
                    </select>

                    <label class="kms-radio-row">
                        <input type="radio" name="kms-target" value="updateSource"/>
                        <span>🔄 <b>Обновить существующий source</b> (smart merge)</span>
                    </label>
                    <select class="kms-dialog-input kms-indent" data-kms-update-source disabled>
                        ${worlds.flatMap(w => (worldSources[w.id] || []).map(src =>
                            `<option value="${escHtml(src.id)}">${escHtml(w.name)} → ${escHtml(src.fileName)} (${src.entryCount || 0})</option>`
                        )).join('') || '<option disabled>нет существующих sources</option>'}
                    </select>
                    ` : ''}

                    <div class="kms-dialog-actions">
                        <button class="kms-btn kms-btn-ghost" data-kms-cancel>Отмена</button>
                        <button class="kms-btn" data-kms-confirm>Импортировать</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const newName = overlay.querySelector('[data-kms-new-name]');
            const newSourceWorld = overlay.querySelector('[data-kms-newsource-world]');
            const updateSourceSel = overlay.querySelector('[data-kms-update-source]');

            const updateState = () => {
                const val = overlay.querySelector('input[name="kms-target"]:checked').value;
                newName.disabled = val !== 'newWorld';
                if (newSourceWorld) newSourceWorld.disabled = val !== 'newSource';
                if (updateSourceSel) updateSourceSel.disabled = val !== 'updateSource';
            };
            overlay.querySelectorAll('input[name="kms-target"]').forEach(r => r.addEventListener('change', updateState));

            const finish = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('[data-kms-cancel]').addEventListener('click', () => finish(null));
            overlay.querySelector('[data-kms-confirm]').addEventListener('click', () => {
                const val = overlay.querySelector('input[name="kms-target"]:checked').value;
                if (val === 'newWorld') {
                    finish({ action: 'newWorld', name: newName.value.trim() || 'Новый мир' });
                } else if (val === 'newSource') {
                    finish({ action: 'newSource', worldId: newSourceWorld.value });
                } else {
                    // find the world for the chosen source
                    const sid = updateSourceSel.value;
                    let wid = null;
                    for (const w of worlds) {
                        if ((worldSources[w.id] || []).find(s => s.id === sid)) { wid = w.id; break; }
                    }
                    finish({ action: 'updateSource', sourceId: sid, worldId: wid });
                }
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
        });
    }

    // ── Render catalog ─────────────────────────────────────────
    const ALL_TAGS_KEY = '__all__';

    async function renderCatalog() {
        if (!drawerEl) return;
        const w = await getCurrentWorld();
        const nav = drawerEl.querySelector('.kms-nav');
        if (!w) {
            nav.innerHTML = `<div class="kms-nav-empty">Импортируй лорбук — создастся мир.</div>`;
            drawerEl.querySelector('[data-kms-tag-cloud]').hidden = true;
            return;
        }

        const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);
        const cats = await getCategoriesForWorld(w.id);
        const settings = getSettings();
        const showSpoilers = settings.showSpoilersGlobal;
        const q = (drawerEl.querySelector('[data-kms-search]')?.value || '').trim().toLowerCase();

        // tag cloud
        renderTagCloud(articles);

        let filtered = articles;
        if (q) {
            filtered = filtered.filter(a =>
                a.title.toLowerCase().includes(q) ||
                (a.subtitle || '').toLowerCase().includes(q) ||
                (a.snippet || '').toLowerCase().includes(q) ||
                (a.body || '').toLowerCase().includes(q) ||
                (a.tags || []).some(t => t.toLowerCase().includes(q)));
        }
        if (activeTagFilter && activeTagFilter !== ALL_TAGS_KEY) {
            filtered = filtered.filter(a => (a.tags || []).includes(activeTagFilter));
        }
        // Player filter
        const pf = settings.catalogFilter || 'all';
        if (pf === 'favorite') filtered = filtered.filter(a => getPlayerData(a.id).favorite);
        else if (pf === 'read')   filtered = filtered.filter(a => getPlayerData(a.id).read);
        else if (pf === 'unread') filtered = filtered.filter(a => !getPlayerData(a.id).read);
        updateFilterButtons();

        const byCat = {};
        for (const a of filtered) (byCat[a.categoryKey] = byCat[a.categoryKey] || []).push(a);

        if (filtered.length === 0) {
            nav.innerHTML = `<div class="kms-nav-empty">${
                q || activeTagFilter ? 'Ничего не найдено' : 'В мире нет записей'
            }</div>`;
            return;
        }

        const orderedCats = [
            ...cats,
            ...Object.keys(byCat).filter(k => !cats.find(c => c.key === k)).map(k =>
                ({ key: k, label: k, icon: '📎', isSpoiler: false, order: 999 })
            ),
        ];

        let html = '';
        for (const cat of orderedCats) {
            const items = byCat[cat.key];
            if (!items?.length) continue;
            items.sort((x, y) => x.title.localeCompare(y.title, 'ru'));

            const isSpoilerCat = cat.isSpoiler && !showSpoilers;
            html += `<details class="kms-cat ${cat.isSpoiler ? 'kms-cat-spoiler' : ''}" ${isSpoilerCat ? '' : 'open'}>
                <summary>
                    <span class="kms-cat-name">${cat.icon || ''} ${escHtml(cat.label)}</span>
                    <span class="kms-count">${items.length}</span>
                </summary>
                <ul>`;
            for (const a of items) {
                const isHidden = (a.spoiler || cat.isSpoiler) && !showSpoilers;
                const titleDisplay = isHidden ? '🔒 [Засекречено]' : escHtml(a.title);
                const tagsHtml = renderArticleTags(a.tags);
                const active = a.id === currentArticleId ? ' kms-nav-active' : '';
                const orphan = a.orphaned ? ' kms-nav-orphan' : '';
                const hasMedia = (a.media?.length || 0) > 0;
                const pdata = getPlayerData(a.id);
                const mediaDot = hasMedia ? '<span class="kms-media-dot" title="есть картинки">●</span>' : '';
                const favStar = pdata.favorite ? '<span class="kms-fav-star" title="избранное">⭐</span>' : '';
                const readDot = pdata.read ? '' : '<span class="kms-unread-dot" title="не прочитано">●</span>';
                const mentioned = mentionedArticleIds.has(a.id) ? ' kms-nav-mentioned' : '';
                html += `<li><a href="#" class="kms-nav-link${active}${orphan}${mentioned}" data-kms-article="${escHtml(a.id)}" ${isHidden ? 'data-kms-spoiler-link' : ''}>
                    ${readDot}<span class="kms-nav-title">${titleDisplay}${mediaDot}${favStar}</span>${tagsHtml}
                </a></li>`;
            }
            html += `</ul></details>`;
        }
        nav.innerHTML = html;
        nav.querySelectorAll('[data-kms-article]').forEach(el => {
            el.addEventListener('click', e => {
                e.preventDefault();
                if (el.hasAttribute('data-kms-spoiler-link')) {
                    if (!confirm('Эта запись помечена как спойлер. Точно открыть?')) return;
                }
                renderArticle(el.dataset.kmsArticle);
            });
        });
    }

    function renderArticleTags(tags) {
        if (!tags?.length) return '';
        const first = escHtml(tags[0]);
        if (tags.length === 1) return `<span class="kms-arc-tag">${first}</span>`;
        return `<span class="kms-arc-tag">${first}</span><span class="kms-arc-more" title="${escHtml(tags.slice(1).join(', '))}">+${tags.length - 1}</span>`;
    }

    function renderTagCloud(articles) {
        const cloudEl = drawerEl.querySelector('[data-kms-tag-cloud]');
        const counts = new Map();
        for (const a of articles) for (const t of (a.tags || [])) {
            counts.set(t, (counts.get(t) || 0) + 1);
        }
        if (counts.size === 0) {
            cloudEl.hidden = true;
            cloudEl.innerHTML = '';
            return;
        }
        cloudEl.hidden = false;
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const allActive = !activeTagFilter || activeTagFilter === ALL_TAGS_KEY;
        cloudEl.innerHTML = `
            <button class="kms-tag-chip ${allActive ? 'kms-tag-active' : ''}" data-kms-tag="${ALL_TAGS_KEY}">все</button>
            ${sorted.map(([t, n]) => `
                <button class="kms-tag-chip ${activeTagFilter === t ? 'kms-tag-active' : ''}" data-kms-tag="${escHtml(t)}">
                    ${escHtml(t)}<span class="kms-tag-count">${n}</span>
                </button>
            `).join('')}
        `;
        cloudEl.querySelectorAll('[data-kms-tag]').forEach(el => {
            el.addEventListener('click', () => {
                const t = el.dataset.kmsTag;
                activeTagFilter = (t === ALL_TAGS_KEY || activeTagFilter === t) ? null : t;
                renderCatalog();
            });
        });
    }

    // ── Article (reader/editor) ────────────────────────────────
    async function renderEmptyArticle() {
        const main = drawerEl.querySelector('.kms-article');
        main.innerHTML = `
            <div class="kms-empty">
                <h2>Выбери запись</h2>
                <p>Слева — каталог. Кликни на статью чтобы открыть.</p>
            </div>
        `;
    }

    async function renderArticle(id) {
        const a = await dbGet('articles', id);
        if (!a) return;
        currentArticleId = id;
        const allowEdit = getSettings().creatorMode;
        await renderReader(a, allowEdit);
        markActiveInNav(id);
        // Update mobile breadcrumb
        if (drawerEl) {
            const crumb = drawerEl.querySelector('[data-kms-mcrumb]');
            if (crumb) { crumb.textContent = a.title; }
        }
        // On mobile, ensure we're on the article tab without triggering a re-render
        if (isMobile() && mobileTab !== 'article') {
            mobileTab = 'article';
        }
        applyMobileTabClass();
    }

    function markActiveInNav(id) {
        if (!drawerEl) return;
        drawerEl.querySelectorAll('.kms-nav-link').forEach(el => {
            el.classList.toggle('kms-nav-active', el.dataset.kmsArticle === id);
        });
    }

    async function renderReader(a, allowEdit) {
        const main = drawerEl.querySelector('.kms-article');
        const cat = await getCategoryByKey(a.worldId, a.categoryKey);
        const catLabel = cat ? `${cat.icon} ${cat.label}` : a.categoryKey;
        const settings = getSettings();
        const showSpoilers = settings.showSpoilersGlobal;

        // Auto-mark as read on open
        const player = getPlayerData(a.id);
        if (!player.read) setPlayerData(a.id, { read: true });

        const keys = a.source?.keys || [];
        const mediaIds = a.media || [];
        const mediaURLs = await Promise.all(mediaIds.map(getImageURL));
        const validMedia = mediaURLs.map((url, i) => url ? { id: mediaIds[i], url } : null).filter(Boolean);

        // Pick body in preferred language (with fallback to default body)
        const lang = settings.preferredLanguage || 'ru';
        const variants = a.bodyVariants || {};
        const availableLangs = Object.keys(variants).filter(k => variants[k]?.trim());
        const bodyText = (variants[lang] && variants[lang].trim())
            ? variants[lang]
            : (a.body || (availableLangs.length ? variants[availableLangs[0]] : ''));

        // Infobox: only show fields that have values (per user's rule)
        const infoboxFields = cat?.infoboxFields || [];
        const infoboxData = a.infobox || {};
        const visibleInfoFields = infoboxFields
            .filter(f => infoboxData[f.key] && String(infoboxData[f.key]).trim());
        const infoboxBlock = visibleInfoFields.length
            ? `<aside class="kms-infobox">
                 <div class="kms-infobox-title">${cat.icon || ''} ${escHtml(cat.label)}</div>
                 <dl class="kms-infobox-list">
                     ${visibleInfoFields.map(f => `
                         <dt>${escHtml(f.label)}</dt>
                         <dd>${escHtml(infoboxData[f.key])}</dd>
                     `).join('')}
                 </dl>
               </aside>`
            : '';

        // Auto-glossary: linkify other-article mentions
        const allArticles = (await dbGetAll('articles')).filter(x => x.worldId === a.worldId && x.id !== a.id);
        const linkedBody = bodyText ? linkifyBody(bodyText, allArticles, showSpoilers) : '';

        // Chat command buttons (per category)
        const cmdTemplates = cat?.commandTemplates || [];
        const chatCmdBlock = cmdTemplates.length ? `
            <div class="kms-chat-cmds">
                ${cmdTemplates.map((t, i) => `
                    <button class="kms-btn kms-chat-cmd-btn" data-kms-cmd="${i}" title="Подставить в поле чата">${escHtml(t.label)}</button>
                `).join('')}
            </div>` : '';

        // Language switcher
        const langBlock = availableLangs.length > 1 ? `
            <div class="kms-lang-switch">
                ${availableLangs.map(l => `
                    <button class="kms-btn kms-btn-ghost ${l === lang ? 'kms-lang-active' : ''}" data-kms-lang="${escHtml(l)}">${escHtml(l).toUpperCase()}</button>
                `).join('')}
            </div>` : '';

        // Player controls block (favorite, journal note)
        const playerControls = `
            <div class="kms-player-controls">
                <button class="kms-btn kms-btn-ghost ${player.favorite ? 'kms-fav-on' : ''}" data-kms-fav title="Избранное">${player.favorite ? '⭐' : '☆'}</button>
                <button class="kms-btn kms-btn-ghost" data-kms-toggle-notes title="Заметки игрока">📓</button>
            </div>`;

        // Player notes section (collapsible)
        const notesBlock = `
            <details class="kms-player-notes" ${player.notes ? 'open' : ''}>
                <summary>📓 Мои заметки${player.notes ? ' · есть' : ''}</summary>
                <textarea class="kms-player-notes-text" placeholder="Записывай свои наблюдения, теории, напоминалки…" data-kms-notes>${escHtml(player.notes || '')}</textarea>
            </details>`;

        const editBtn = allowEdit
            ? `<button class="kms-btn kms-btn-ghost kms-edit-btn" data-kms-edit>✏️ Редактировать</button>`
            : '';

        const tagsBlock = (a.tags?.length)
            ? `<div class="kms-tags-row">${a.tags.map(t => `<span class="kms-arc-tag">${escHtml(t)}</span>`).join(' ')}</div>`
            : '';

        const orphanWarn = a.orphaned
            ? `<div class="kms-orphan-warn">⚠️ Эта запись осталась без пары в исходном лорбуке (была удалена или переименована). Снимок сохранён.</div>`
            : '';

        const spoilerBadge = a.spoiler
            ? `<span class="kms-spoiler-badge" title="Эта статья — спойлер">🔒 спойлер</span>`
            : '';

        main.innerHTML = `
            <article class="kms-article-content">
                ${orphanWarn}
                <header class="kms-article-head">
                    <div class="kms-cat-badge">${escHtml(catLabel)} ${spoilerBadge}</div>
                    <h1 class="kms-h1">${escHtml(a.title)}</h1>
                    ${a.subtitle ? `<p class="kms-subtitle">${escHtml(a.subtitle)}</p>` : ''}
                    ${tagsBlock}
                    ${langBlock}
                    ${playerControls}
                    ${editBtn}
                </header>

                ${chatCmdBlock}

                ${validMedia.length ? `
                <div class="kms-gallery ${validMedia.length === 1 ? 'kms-gallery-single' : validMedia.length === 2 ? 'kms-gallery-pair' : ''}">
                    ${validMedia.map(m => `
                        <figure class="kms-gallery-item" data-kms-lightbox="${escHtml(m.url)}">
                            <img src="${escHtml(m.url)}" alt=""/>
                        </figure>`).join('')}
                </div>` : ''}

                ${infoboxBlock}

                ${bodyText
                    ? `<div class="kms-body-text">${linkedBody}</div>`
                    : `<div class="kms-body-placeholder">
                         <em>Длинный текст для этой статьи ещё не написан.</em>
                         <small>Ниже — то, что лежит в самом лорбуке (snippet для AI).</small>
                       </div>`
                }

                ${notesBlock}

                <details class="kms-snippet" ${bodyText ? '' : 'open'}>
                    <summary>📜 Из лорбука (snippet для AI)</summary>
                    <pre class="kms-snippet-text">${escHtml(a.snippet || '— пусто —')}</pre>
                </details>

                ${keys.length ? `
                <details class="kms-source-keys">
                    <summary>🔑 Ключи срабатывания · ${keys.length}</summary>
                    <ul>${keys.map(k => `<li><code>${escHtml(k)}</code></li>`).join('')}</ul>
                </details>` : ''}
            </article>
        `;

        if (allowEdit) main.querySelector('[data-kms-edit]').addEventListener('click', () => renderEditor(a));
        main.querySelectorAll('[data-kms-lightbox]').forEach(el =>
            el.addEventListener('click', () => openLightbox(el.dataset.kmsLightbox)));
        main.querySelectorAll('[data-kms-spoiler]').forEach(el =>
            el.addEventListener('click', () => el.classList.toggle('kms-spoiler-revealed')));
        main.querySelectorAll('[data-kms-glossary-link]').forEach(el =>
            el.addEventListener('click', e => {
                e.preventDefault();
                renderArticle(el.dataset.kmsGlossaryLink);
            }));

        // Player favorite toggle
        main.querySelector('[data-kms-fav]').addEventListener('click', () => {
            const cur = getPlayerData(a.id);
            setPlayerData(a.id, { favorite: !cur.favorite });
            renderReader(a, allowEdit);
            renderCatalog();
        });
        // Show notes (just opens the details)
        main.querySelector('[data-kms-toggle-notes]').addEventListener('click', () => {
            const det = main.querySelector('.kms-player-notes');
            if (det) { det.open = !det.open; if (det.open) det.querySelector('textarea')?.focus(); }
        });
        // Notes auto-save (debounced)
        const notesEl = main.querySelector('[data-kms-notes]');
        if (notesEl) {
            let t = null;
            notesEl.addEventListener('input', () => {
                clearTimeout(t);
                t = setTimeout(() => {
                    setPlayerData(a.id, { notes: notesEl.value });
                    status(`📓 Заметка сохранена.`);
                }, 600);
            });
        }
        // Language switcher
        main.querySelectorAll('[data-kms-lang]').forEach(el => {
            el.addEventListener('click', () => {
                const s = getSettings();
                s.preferredLanguage = el.dataset.kmsLang;
                saveSettings();
                renderReader(a, allowEdit);
            });
        });
        // Chat command buttons
        main.querySelectorAll('[data-kms-cmd]').forEach(el => {
            el.addEventListener('click', () => {
                const tpl = cmdTemplates[+el.dataset.kmsCmd];
                if (tpl) injectIntoChat(tpl.template.replace(/\{title\}/g, a.title).replace(/\{subtitle\}/g, a.subtitle || ''));
            });
        });
    }

    // ── Inject text into ST chat input ─────────────────────────
    function injectIntoChat(text) {
        const ta = document.querySelector('#send_textarea')
              || document.querySelector('textarea[placeholder*="message" i]')
              || document.querySelector('textarea');
        if (!ta) {
            status('Не нашёл поле ввода чата ST.', 'warn');
            return;
        }
        const prefix = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
        ta.value = ta.value + prefix + text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        // move cursor to end
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
        status(`💬 В чат подставлено: «${text.slice(0, 40)}${text.length > 40 ? '…' : ''}»`);
    }

    // ── Editor ─────────────────────────────────────────────────
    async function renderEditor(a) {
        const main = drawerEl.querySelector('.kms-article');
        const cats = await getCategoriesForWorld(a.worldId);
        const currentCat = cats.find(c => c.key === a.categoryKey);
        const infoFields = currentCat?.infoboxFields || [];
        const mediaIds = a.media || [];
        const mediaURLs = await Promise.all(mediaIds.map(async (id) => ({ id, url: await getImageURL(id) })));
        const validMedia = mediaURLs.filter(m => m.url);

        const catOptions = cats.map(c =>
            `<option value="${escHtml(c.key)}" ${c.key === a.categoryKey ? 'selected' : ''}>${c.icon} ${escHtml(c.label)}</option>`
        ).join('');

        const tagsValue = (a.tags || []).join(', ');

        const infoboxBlock = infoFields.length
            ? `<div class="kms-field">
                 <span class="kms-label">Карточка категории «${escHtml(currentCat.label)}»
                     <small class="kms-label-hint"> · пустые поля игроку не показываются</small>
                 </span>
                 <div class="kms-infobox-edit">
                     ${infoFields.map(f => `
                         <label class="kms-infobox-edit-row">
                             <span class="kms-infobox-field-label">${escHtml(f.label)}</span>
                             <input type="text" data-info-key="${escHtml(f.key)}" value="${escHtml(a.infobox?.[f.key] || '')}" placeholder="—"/>
                         </label>
                     `).join('')}
                 </div>
               </div>`
            : '';

        // Mark drawer as in editor mode (for mobile fullscreen overlay styling)
        drawerEl.classList.add('kms-editor-open');

        main.innerHTML = `
            <article class="kms-article-content kms-editor">
                <div class="kms-editor-head">
                    <button class="kms-mback kms-editor-back" data-kms-cancel title="Отмена">✕</button>
                    <div class="kms-cat-badge kms-editor-crumb">${escHtml(a.title)}</div>
                    <div class="kms-edit-actions">
                        <button class="kms-btn kms-btn-ghost kms-editor-cancel-btn" data-kms-cancel>Отмена</button>
                        <button class="kms-btn" data-kms-save>Сохранить</button>
                    </div>
                </div>

                <label class="kms-field">
                    <span class="kms-label">Название</span>
                    <input type="text" data-f="title" value="${escHtml(a.title)}"/>
                </label>
                <label class="kms-field">
                    <span class="kms-label">Подзаголовок</span>
                    <input type="text" data-f="subtitle" value="${escHtml(a.subtitle || '')}" placeholder="например: The City"/>
                </label>
                <div class="kms-field-row">
                    <label class="kms-field">
                        <span class="kms-label">Категория</span>
                        <select data-f="categoryKey">${catOptions}</select>
                    </label>
                    <label class="kms-field">
                        <span class="kms-label">Теги (через запятую)</span>
                        <input type="text" data-f="tags" value="${escHtml(tagsValue)}" placeholder="Tyoma, Юг, Друзья"/>
                    </label>
                </div>

                <label class="kms-checkbox-row">
                    <input type="checkbox" data-f="spoiler" ${a.spoiler ? 'checked' : ''}/>
                    <span>🔒 Эта статья — спойлер (скрывать пока юзер сам не откроет)</span>
                </label>

                ${infoboxBlock}

                <div class="kms-field">
                    <span class="kms-label">Изображения</span>
                    <div class="kms-dropzone" data-kms-dropzone>
                        Перетащи картинки сюда <br/>
                        <small>или <button class="kms-btn kms-btn-ghost" data-kms-pick-image>выбери файл</button></small>
                        <input type="file" accept="image/*" multiple hidden data-kms-file-image/>
                    </div>
                    <div class="kms-edit-gallery">
                        ${validMedia.map(m => `
                            <figure class="kms-edit-gallery-item">
                                <img src="${escHtml(m.url)}" alt=""/>
                                <button class="kms-img-remove" title="Удалить" data-kms-remove-media="${escHtml(m.id)}">✕</button>
                            </figure>`).join('')}
                    </div>
                </div>

                <label class="kms-field">
                    <span class="kms-label">Основной текст
                        <small class="kms-label-hint"> · спойлеры: <code>||так||</code> · автоссылки на другие статьи работают</small>
                    </span>
                    <div class="kms-lang-tabs" data-kms-lang-tabs>
                        ${(() => {
                            const variants = a.bodyVariants || {};
                            const langs = ['ru', 'en', ...Object.keys(variants).filter(k => k !== 'ru' && k !== 'en')];
                            const seen = new Set();
                            return langs.filter(l => !seen.has(l) && (seen.add(l), true)).map(l => `
                                <button class="kms-lang-tab ${l === (getSettings().preferredLanguage || 'ru') ? 'kms-lang-tab-active' : ''}" data-tab-lang="${escHtml(l)}">${escHtml(l).toUpperCase()}</button>
                            `).join('');
                        })()}
                        <button class="kms-lang-tab kms-lang-tab-add" data-tab-add title="Добавить язык">+</button>
                    </div>
                    <textarea data-f="body" rows="14" placeholder="Длинное описание для энциклопедии…">${escHtml((() => {
                        const lang = getSettings().preferredLanguage || 'ru';
                        const v = a.bodyVariants || {};
                        return v[lang] !== undefined ? v[lang] : (a.body || '');
                    })())}</textarea>
                </label>

                <details class="kms-snippet" open>
                    <summary>📜 Snippet из лорбука (только для чтения)</summary>
                    <pre class="kms-snippet-text">${escHtml(a.snippet || '— пусто —')}</pre>
                </details>
            </article>
        `;

        main.querySelectorAll('[data-kms-cancel]').forEach(b => b.addEventListener('click', () => {
            drawerEl.classList.remove('kms-editor-open');
            renderArticle(a.id);
        }));
        main.querySelector('[data-kms-save]').addEventListener('click', () => {
            drawerEl.classList.remove('kms-editor-open');
            saveEdits(a);
        });
        // Re-render editor when category changes (infobox fields differ per category)
        main.querySelector('[data-f="categoryKey"]').addEventListener('change', async (e) => {
            const tempPatch = { ...a, categoryKey: e.target.value };
            // grab current user input so we don't lose it on re-render
            const get = sel => main.querySelector(`[data-f="${sel}"]`);
            tempPatch.title    = get('title').value;
            tempPatch.subtitle = get('subtitle').value;
            tempPatch.tags     = parseTags(get('tags').value);
            tempPatch.spoiler  = get('spoiler').checked;
            tempPatch.body     = get('body').value;
            tempPatch.infobox = { ...(a.infobox || {}) };
            main.querySelectorAll('[data-info-key]').forEach(el => {
                const v = el.value.trim();
                if (v) tempPatch.infobox[el.dataset.infoKey] = v;
            });
            await renderEditor(tempPatch);
        });
        main.querySelector('[data-kms-pick-image]').addEventListener('click', (e) => {
            e.preventDefault();
            main.querySelector('[data-kms-file-image]').click();
        });
        main.querySelector('[data-kms-file-image]').addEventListener('change', (e) =>
            handleImageFiles(e.target.files, a));
        main.querySelectorAll('[data-kms-remove-media]').forEach(el => {
            el.addEventListener('click', () => removeImage(el.dataset.kmsRemoveMedia, a));
        });
        bindDropZone(main.querySelector('[data-kms-dropzone]'), a);

        // Language tabs in editor
        // We keep an in-flight `editorLangBuffer` map per language so switching tabs preserves unsaved typing
        if (!a._editorLangBuffer) {
            a._editorLangBuffer = { ...(a.bodyVariants || {}) };
            // seed default body into preferred language slot if no variants exist yet
            if (Object.keys(a._editorLangBuffer).length === 0 && a.body) {
                a._editorLangBuffer[getSettings().preferredLanguage || 'ru'] = a.body;
            }
        }
        let activeLang = getSettings().preferredLanguage || 'ru';

        const bodyTa = main.querySelector('[data-f="body"]');
        const langTabs = main.querySelectorAll('[data-tab-lang]');
        const switchLang = (newLang) => {
            // store current text in the old lang slot
            a._editorLangBuffer[activeLang] = bodyTa.value;
            activeLang = newLang;
            bodyTa.value = a._editorLangBuffer[activeLang] || '';
            langTabs.forEach(t => t.classList.toggle('kms-lang-tab-active', t.dataset.tabLang === newLang));
        };
        langTabs.forEach(t => t.addEventListener('click', (e) => {
            e.preventDefault();
            switchLang(t.dataset.tabLang);
        }));
        const addBtn = main.querySelector('[data-tab-add]');
        if (addBtn) addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const code = prompt('Код языка (2 буквы, например: de, fr, es):');
            if (!code) return;
            const norm = code.trim().toLowerCase().slice(0, 5);
            if (!norm) return;
            a._editorLangBuffer[norm] = a._editorLangBuffer[norm] || '';
            renderEditor(a); // re-render to show new tab
        });
    }

    function parseTags(str) {
        return str.split(',').map(s => s.trim()).filter(Boolean);
    }

    async function saveEdits(a) {
        const main = drawerEl.querySelector('.kms-article');
        const get = sel => main.querySelector(`[data-f="${sel}"]`);

        const newTitle    = get('title').value.trim() || a.title;
        const newSubtitle = get('subtitle').value.trim();
        const newCatKey   = get('categoryKey').value;
        const newTags     = parseTags(get('tags').value);
        const newSpoiler  = get('spoiler').checked;
        const newBody     = get('body').value;

        // Infobox fields — collect all data-info-key inputs
        const newInfobox = { ...(a.infobox || {}) };
        main.querySelectorAll('[data-info-key]').forEach(el => {
            const k = el.dataset.infoKey;
            const v = el.value.trim();
            if (v) newInfobox[k] = v; else delete newInfobox[k];
        });

        const me = new Set(a.manualEdits || []);
        if (newTitle !== a.title)            me.add('title');
        if (newSubtitle !== (a.subtitle||''))me.add('subtitle');
        if (newCatKey !== a.categoryKey)     me.add('categoryKey');
        if (JSON.stringify(newTags) !== JSON.stringify(a.tags || [])) me.add('tags');

        // Persist multilang buffer: use active lang's text from the textarea + buffered other langs
        const buf = a._editorLangBuffer || {};
        // Determine current active lang from the active tab
        const activeTab = main.querySelector('.kms-lang-tab-active');
        const activeLang = activeTab?.dataset.tabLang || (getSettings().preferredLanguage || 'ru');
        buf[activeLang] = newBody;
        // Strip empty langs
        const cleanedVariants = {};
        for (const [k, v] of Object.entries(buf)) if (v && v.trim()) cleanedVariants[k] = v;

        const updated = {
            ...a,
            title: newTitle,
            subtitle: newSubtitle,
            categoryKey: newCatKey,
            tags: newTags,
            spoiler: newSpoiler,
            body: newBody, // keep .body in sync with active lang as legacy fallback
            bodyVariants: cleanedVariants,
            infobox: newInfobox,
            manualEdits: [...me],
            updatedAt: Date.now(),
        };
        delete updated._editorLangBuffer;
        await dbPut('articles', updated);
        status(`💾 Сохранено: «${updated.title}»`);
        await renderCatalog();
        await renderArticle(updated.id);
    }

    // ── Image handling ─────────────────────────────────────────
    function bindDropZone(zone, article) {
        if (!zone) return;
        ['dragenter','dragover'].forEach(ev =>
            zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('kms-drop-hover'); }));
        ['dragleave','drop'].forEach(ev =>
            zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('kms-drop-hover'); }));
        zone.addEventListener('drop', e => {
            const files = e.dataTransfer?.files;
            if (files?.length) handleImageFiles(files, article);
        });
    }

    async function handleImageFiles(files, article) {
        const fresh = await dbGet('articles', article.id) || article;
        const newIds = [];
        for (const f of files) {
            try { newIds.push(await saveImageBlob(f)); }
            catch (err) { status(`❌ ${f.name}: ${err.message}`, 'error'); }
        }
        if (newIds.length) {
            fresh.media = [...(fresh.media || []), ...newIds];
            fresh.updatedAt = Date.now();
            await dbPut('articles', fresh);
            renderEditor(fresh);
            renderCatalog();
        }
    }

    async function removeImage(mediaId, article) {
        const fresh = await dbGet('articles', article.id) || article;
        fresh.media = (fresh.media || []).filter(id => id !== mediaId);
        fresh.updatedAt = Date.now();
        await dbPut('articles', fresh);
        await dbDelete('media', mediaId);
        status(`🗑 Удалена картинка.`);
        renderEditor(fresh);
        renderCatalog();
    }

    // ── Lightbox ───────────────────────────────────────────────
    function openLightbox(url) {
        const lb = document.createElement('div');
        lb.className = 'kms-lightbox';
        lb.innerHTML = `<img src="${escHtml(url)}" alt=""/><button class="kms-lightbox-close">✕</button>`;
        const close = () => lb.remove();
        lb.addEventListener('click', e => {
            if (e.target === lb || e.target.classList.contains('kms-lightbox-close')) close();
        });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
        });
        document.body.appendChild(lb);
    }

    // ── Categories manager ─────────────────────────────────────
    async function renderCategoriesManager() {
        const w = await getCurrentWorld();
        if (!w) { status('Сначала импортируй лорбук — нужен мир.', 'warn'); return; }
        const cats = await getCategoriesForWorld(w.id);
        const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);
        const counts = {};
        for (const a of articles) counts[a.categoryKey] = (counts[a.categoryKey] || 0) + 1;

        const overlay = document.createElement('div');
        overlay.className = 'kms-modal-overlay';
        overlay.innerHTML = `
            <div class="kms-dialog kms-dialog-wide">
                <h3>Категории мира «${escHtml(w.name)}»</h3>
                <p class="kms-dialog-sub">встроенные удалить нельзя; кастомные — можно</p>

                <ul class="kms-cats-list">
                    ${cats.map(c => `
                        <li class="kms-cats-item ${c.builtin ? 'kms-cat-builtin' : ''} ${c.isSpoiler ? 'kms-cat-spoiler' : ''}">
                            <span class="kms-cat-icon-cell">
                                <input type="text" class="kms-cat-icon-input" maxlength="3" value="${escHtml(c.icon || '')}" data-cat-id="${escHtml(c.id)}" data-cat-field="icon"/>
                            </span>
                            <input type="text" class="kms-cat-label-input" value="${escHtml(c.label)}" data-cat-id="${escHtml(c.id)}" data-cat-field="label"/>
                            <span class="kms-cat-count">${counts[c.key] || 0}</span>
                            <button class="kms-btn kms-btn-ghost kms-cat-fields" data-fields="${escHtml(c.id)}" title="Поля карточки">📋 ${(c.infoboxFields||[]).length}</button>
                            <button class="kms-btn kms-btn-ghost kms-cat-cmds" data-cmds="${escHtml(c.id)}" title="Кнопки-команды в чат">💬 ${(c.commandTemplates||[]).length}</button>
                            <label class="kms-cat-spoiler-toggle" title="Спойлер-категория (свёрнута по дефолту)">
                                <input type="checkbox" ${c.isSpoiler ? 'checked' : ''} data-cat-id="${escHtml(c.id)}" data-cat-field="isSpoiler"/>
                                🔒
                            </label>
                            <button class="kms-btn kms-btn-ghost kms-cat-del" ${c.builtin ? 'disabled' : ''} data-del="${escHtml(c.id)}" title="${c.builtin ? 'встроенная — нельзя удалить' : 'удалить'}">✕</button>
                        </li>
                    `).join('')}
                </ul>

                <div class="kms-cats-add">
                    <input type="text" class="kms-cat-icon-input" maxlength="3" placeholder="📎" data-new-icon/>
                    <input type="text" class="kms-cat-label-input" placeholder="Имя новой категории" data-new-label/>
                    <label class="kms-cat-spoiler-toggle">
                        <input type="checkbox" data-new-spoiler/>🔒
                    </label>
                    <button class="kms-btn" data-add>+ Добавить</button>
                </div>

                <div class="kms-dialog-actions">
                    <button class="kms-btn" data-kms-close-dialog>Готово</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => { overlay.remove(); renderCatalog(); };
        overlay.querySelector('[data-kms-close-dialog]').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        // inline edits
        overlay.querySelectorAll('[data-cat-field]').forEach(el => {
            el.addEventListener('change', async () => {
                const id = el.dataset.catId;
                const field = el.dataset.catField;
                const val = el.type === 'checkbox' ? el.checked : el.value;
                await updateCategory(id, { [field]: val });
                status(`📝 Категория обновлена.`);
            });
        });

        // delete
        overlay.querySelectorAll('[data-del]').forEach(el => {
            el.addEventListener('click', async () => {
                const id = el.dataset.del;
                if (!confirm('Удалить категорию? Статьи переедут в "Прочее".')) return;
                await deleteCategory(id, 'misc');
                overlay.remove();
                renderCategoriesManager();
            });
        });

        // edit infobox fields
        overlay.querySelectorAll('[data-fields]').forEach(el => {
            el.addEventListener('click', async () => {
                await renderInfoboxFieldsEditor(el.dataset.fields);
                overlay.remove();
                renderCategoriesManager();
            });
        });

        // edit chat command templates
        overlay.querySelectorAll('[data-cmds]').forEach(el => {
            el.addEventListener('click', async () => {
                await renderCommandTemplatesEditor(el.dataset.cmds);
                overlay.remove();
                renderCategoriesManager();
            });
        });

        // add
        overlay.querySelector('[data-add]').addEventListener('click', async () => {
            const iconEl = overlay.querySelector('[data-new-icon]');
            const labelEl = overlay.querySelector('[data-new-label]');
            const spoilerEl = overlay.querySelector('[data-new-spoiler]');
            const label = labelEl.value.trim();
            if (!label) { status('Введи имя категории.', 'warn'); return; }
            await createCategory(w.id, {
                label,
                icon: iconEl.value.trim() || '📎',
                isSpoiler: spoilerEl.checked,
            });
            overlay.remove();
            renderCategoriesManager();
        });
    }

    // ── Map ────────────────────────────────────────────────────
    async function getMapForWorld(worldId) {
        return dbGet('maps', `${worldId}::map`);
    }

    async function setMapForWorld(worldId, mediaId) {
        const existing = await getMapForWorld(worldId);
        const map = existing || { id: `${worldId}::map`, worldId, pins: [], createdAt: Date.now() };
        if (mediaId) map.mediaId = mediaId;
        map.updatedAt = Date.now();
        await dbPut('maps', map);
        return map;
    }

    async function deleteMap(worldId) {
        const m = await getMapForWorld(worldId);
        if (!m) return;
        if (m.mediaId) try { await dbDelete('media', m.mediaId); } catch (_) {}
        await dbDelete('maps', m.id);
    }

    async function addMapPin(worldId, x, y, articleId, label) {
        const m = await setMapForWorld(worldId);
        m.pins = m.pins || [];
        m.pins.push({ id: `pin-${uid()}`, x, y, articleId, label });
        m.updatedAt = Date.now();
        await dbPut('maps', m);
    }

    async function removeMapPin(worldId, pinId) {
        const m = await getMapForWorld(worldId);
        if (!m) return;
        m.pins = (m.pins || []).filter(p => p.id !== pinId);
        m.updatedAt = Date.now();
        await dbPut('maps', m);
    }

    async function renderMapView() {
        const w = await getCurrentWorld();
        if (!w) { status('Сначала импортируй лорбук — нужен мир.', 'warn'); return; }
        const main = drawerEl.querySelector('.kms-article');
        const map = await getMapForWorld(w.id);
        const isCreator = getSettings().creatorMode;
        const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);

        // Save scroll position so it survives the re-render (e.g. after adding/deleting a pin)
        const oldCanvas = main.querySelector('[data-kms-map-canvas]');
        const savedScroll = oldCanvas
            ? { top: oldCanvas.scrollTop, left: oldCanvas.scrollLeft }
            : null;

        currentArticleId = null;
        markActiveInNav(null);

        // No map yet
        if (!map?.mediaId) {
            main.innerHTML = `
                <div class="kms-empty">
                    <h2>🗺 Карта мира</h2>
                    <p>Карты ещё нет. ${isCreator ? 'Загрузи картинку — карту, схему, что угодно — потом расставишь пины с привязкой к статьям.' : 'Креатор её ещё не загрузил.'}</p>
                    ${isCreator ? `<div class="kms-map-upload">
                        <button class="kms-btn" data-kms-map-pick>📷 Загрузить карту</button>
                        <input type="file" accept="image/*" hidden data-kms-map-file/>
                    </div>` : ''}
                </div>
            `;
            if (isCreator) {
                const fileEl = main.querySelector('[data-kms-map-file]');
                main.querySelector('[data-kms-map-pick]').addEventListener('click', () => fileEl.click());
                fileEl.addEventListener('change', async (e) => {
                    const f = e.target.files[0];
                    if (!f) return;
                    try {
                        const mediaId = await saveImageBlob(f);
                        await setMapForWorld(w.id, mediaId);
                        status('🗺 Карта загружена.');
                        renderMapView();
                    } catch (err) {
                        status(`❌ ${err.message}`, 'error');
                    }
                });
            }
            return;
        }

        const mapURL = await getImageURL(map.mediaId);
        const pinsHtml = (map.pins || []).map(p => {
            const a = articles.find(x => x.id === p.articleId);
            const label = p.label || a?.title || 'без статьи';
            return `<button class="kms-map-pin ${a ? '' : 'kms-map-pin-orphan'}"
                style="left:${p.x}%; top:${p.y}%"
                data-pin-id="${escAttr(p.id)}"
                data-pin-article="${escAttr(p.articleId || '')}"
                title="${escAttr(label)}">
                📍 <span class="kms-pin-label">${escHtml(label)}</span>
            </button>`;
        }).join('');

        main.innerHTML = `
            <div class="kms-map-view">
                <div class="kms-map-toolbar">
                    <h2 class="kms-map-title">🗺 Карта · ${escHtml(w.name)}</h2>
                    <div class="kms-map-zoom-controls">
                        <button class="kms-btn kms-btn-ghost" data-kms-zoom-out title="Уменьшить">−</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-zoom-reset title="100%">⤢</button>
                        <button class="kms-btn kms-btn-ghost" data-kms-zoom-in title="Увеличить">+</button>
                        <span class="kms-zoom-label" data-kms-zoom-label>100%</span>
                    </div>
                    ${isCreator ? `
                        <div class="kms-map-toolbar-actions">
                            <span class="kms-map-hint" data-kms-map-hint>клик → пин · колесо → зум · тащи → pan</span>
                            <button class="kms-btn kms-btn-ghost" data-kms-map-pin-move title="Включить режим перемещения пинов">✋ Двигать</button>
                            <button class="kms-btn kms-btn-ghost" data-kms-map-pin-delete title="Включить режим удаления пинов">🗑 Удалить пин</button>
                            <button class="kms-btn" data-kms-map-replace>📷 Заменить карту</button>
                            <button class="kms-btn kms-btn-ghost" data-kms-map-delete>🗑 Удалить карту</button>
                            <input type="file" accept="image/*" hidden data-kms-map-file/>
                        </div>
                    ` : ''}
                </div>
                <div class="kms-map-canvas" data-kms-map-canvas>
                    <div class="kms-map-stage" data-kms-map-stage>
                        <img src="${escAttr(mapURL)}" alt="map" class="kms-map-image" draggable="false"/>
                        ${pinsHtml}
                    </div>
                </div>
            </div>
        `;

        const canvas = main.querySelector('[data-kms-map-canvas]');
        const stage = main.querySelector('[data-kms-map-stage]');
        const img = main.querySelector('.kms-map-image');
        const zoomLabel = main.querySelector('[data-kms-zoom-label]');

        // Restore scroll: if image is already cached, restore immediately;
        // otherwise wait for it to load (its height affects max scroll).
        if (canvas && savedScroll) {
            const restore = () => {
                canvas.scrollTop = savedScroll.top;
                canvas.scrollLeft = savedScroll.left;
            };
            if (img && !img.complete) {
                img.addEventListener('load', restore, { once: true });
            } else {
                restore();
            }
        }

        // ── Zoom + pan state ──────────────────────────────────
        const ZOOM_MIN = 0.5, ZOOM_MAX = 6;
        let zoom = 1, panX = 0, panY = 0;

        function applyTransform() {
            stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
            if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        }
        applyTransform();

        // zoom around a fixed screen-space point (so the point under cursor/finger stays put)
        function zoomTo(newZoom, anchorClientX, anchorClientY) {
            newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
            const cb = canvas.getBoundingClientRect();
            const ax = (anchorClientX !== undefined ? anchorClientX : cb.left + cb.width / 2) - cb.left + canvas.scrollLeft;
            const ay = (anchorClientY !== undefined ? anchorClientY : cb.top  + cb.height / 2) - cb.top  + canvas.scrollTop;
            const pRawX = (ax - panX) / zoom;
            const pRawY = (ay - panY) / zoom;
            panX = ax - newZoom * pRawX;
            panY = ay - newZoom * pRawY;
            zoom = newZoom;
            applyTransform();
        }

        function resetZoom() { zoom = 1; panX = 0; panY = 0; applyTransform(); }

        // Wheel zoom
        canvas.addEventListener('wheel', (e) => {
            if (!e.ctrlKey && !e.metaKey) {
                // also allow plain wheel zoom; if user wants page scroll we steal it,
                // but on a focused map view it makes sense
            }
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            zoomTo(zoom * factor, e.clientX, e.clientY);
        }, { passive: false });

        // Buttons
        main.querySelector('[data-kms-zoom-in]').addEventListener('click', () => zoomTo(zoom * 1.25));
        main.querySelector('[data-kms-zoom-out]').addEventListener('click', () => zoomTo(zoom / 1.25));
        main.querySelector('[data-kms-zoom-reset]').addEventListener('click', resetZoom);

        // Pan via mouse drag on empty stage (NOT in delete/move pin modes; NOT on a pin)
        let pan = null;            // { startX, startY, startPanX, startPanY, moved }
        let suppressNextClick = false;

        // Pinch zoom + single-touch pan on touch devices
        let pinch = null;          // { startDist, startZoom, startPanX, startPanY, centerX, centerY }
        let touchPan = null;       // { startX, startY, startPanX, startPanY, moved }

        let pinDeleteMode = false;
        let pinMoveMode = false;
        let drag = null;           // pin-drag state in move mode

        function pinCoordsFromEvent(e) {
            const rect = img.getBoundingClientRect();
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            const x = ((cx - rect.left) / rect.width) * 100;
            const y = ((cy - rect.top) / rect.height) * 100;
            return { x, y };
        }

        // Pin click — navigate / delete (depending on mode)
        main.querySelectorAll('.kms-map-pin').forEach(el => {
            // mousedown for drag
            const onDragStart = (e) => {
                if (!isCreator || !pinMoveMode) return;
                e.preventDefault();
                e.stopPropagation();
                drag = { pinEl: el, pinId: el.dataset.pinId, moved: false };
            };
            el.addEventListener('mousedown', onDragStart);
            el.addEventListener('touchstart', onDragStart, { passive: false });

            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                // suppress click after drag
                if (drag && drag.moved) { drag = null; return; }
                if (isCreator && pinDeleteMode) {
                    await removeMapPin(w.id, el.dataset.pinId);
                    status(`🗑 Пин удалён.`);
                    renderMapView();
                    return;
                }
                if (pinMoveMode) return; // in move mode, click does nothing on its own
                const aid = el.dataset.pinArticle;
                if (aid) renderArticle(aid);
            });
        });

        // Document-level mousemove/mouseup for drag (must reach outside the pin)
        const onDragMove = (e) => {
            if (!drag) return;
            e.preventDefault();
            const { x, y } = pinCoordsFromEvent(e);
            if (x < 0 || x > 100 || y < 0 || y > 100) return;
            drag.pinEl.style.left = `${x}%`;
            drag.pinEl.style.top = `${y}%`;
            drag.lastX = x;
            drag.lastY = y;
            drag.moved = true;
        };
        const onDragEnd = async () => {
            if (!drag) return;
            const d = drag;
            // keep drag alive for the click-suppression check
            setTimeout(() => { if (drag === d) drag = null; }, 50);
            if (!d.moved || d.lastX === undefined) return;
            const m = await getMapForWorld(w.id);
            const pin = m?.pins?.find(p => p.id === d.pinId);
            if (!pin) return;
            pin.x = d.lastX;
            pin.y = d.lastY;
            m.updatedAt = Date.now();
            await dbPut('maps', m);
            status(`✋ Пин перемещён.`);
        };
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd);
        // Save listeners on drawerEl so we can clean them on next render
        if (drawerEl._kmsMapCleanup) drawerEl._kmsMapCleanup();
        drawerEl._kmsMapCleanup = () => {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('touchend', onDragEnd);
            document.removeEventListener('mousemove', onPanMove);
            document.removeEventListener('mouseup', onPanUp);
        };

        // Mobile immersive: tap on map (no drag, no pin) toggles UI chrome
        let tapStart = null;
        canvas.addEventListener('mousedown', (e) => {
            if (!isMobile()) return;
            tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
        });
        canvas.addEventListener('mouseup', (e) => {
            if (!isMobile() || !tapStart) return;
            const dx = e.clientX - tapStart.x, dy = e.clientY - tapStart.y;
            const dt = Date.now() - tapStart.t;
            tapStart = null;
            if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && dt < 350) {
                if (e.target.closest('.kms-map-pin')) return; // pin click handled separately
                if (e.target.closest('.kms-map-toolbar')) return;
                mapImmersive = !mapImmersive;
                drawerEl.classList.toggle('kms-map-immersive', mapImmersive);
            }
        });

        // Pan via mouse drag on empty area (works for everyone, not just creator)
        canvas.addEventListener('mousedown', (e) => {
            if (e.target.closest('.kms-map-pin')) return;
            if (pinDeleteMode || pinMoveMode) return; // those modes have their own handlers
            if (e.button !== 0) return;
            pan = { startX: e.clientX, startY: e.clientY, startPanX: panX, startPanY: panY, moved: false };
        });
        const onPanMove = (e) => {
            if (!pan) return;
            const dx = e.clientX - pan.startX, dy = e.clientY - pan.startY;
            if (!pan.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) pan.moved = true;
            if (pan.moved) {
                panX = pan.startPanX + dx;
                panY = pan.startPanY + dy;
                applyTransform();
            }
        };
        const onPanUp = () => {
            if (!pan) return;
            const wasDrag = pan.moved;
            pan = null;
            if (wasDrag) suppressNextClick = true;
        };
        document.addEventListener('mousemove', onPanMove);
        document.addEventListener('mouseup', onPanUp);

        // Touch: pinch (2 fingers) zoom; single touch pan
        canvas.addEventListener('touchstart', (e) => {
            if (e.target.closest('.kms-map-pin')) return;
            if (pinDeleteMode || pinMoveMode) return;
            if (e.touches.length === 2) {
                e.preventDefault();
                const t1 = e.touches[0], t2 = e.touches[1];
                const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
                pinch = {
                    startDist: Math.hypot(dx, dy),
                    startZoom: zoom,
                    centerX: (t1.clientX + t2.clientX) / 2,
                    centerY: (t1.clientY + t2.clientY) / 2,
                };
                touchPan = null;
            } else if (e.touches.length === 1) {
                touchPan = {
                    startX: e.touches[0].clientX,
                    startY: e.touches[0].clientY,
                    startPanX: panX, startPanY: panY,
                    moved: false,
                };
            }
        }, { passive: false });
        canvas.addEventListener('touchmove', (e) => {
            if (pinch && e.touches.length === 2) {
                e.preventDefault();
                const t1 = e.touches[0], t2 = e.touches[1];
                const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
                const dist = Math.hypot(dx, dy);
                zoomTo(pinch.startZoom * (dist / pinch.startDist), pinch.centerX, pinch.centerY);
            } else if (touchPan && e.touches.length === 1) {
                const dx = e.touches[0].clientX - touchPan.startX;
                const dy = e.touches[0].clientY - touchPan.startY;
                if (!touchPan.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) touchPan.moved = true;
                if (touchPan.moved) {
                    e.preventDefault();
                    panX = touchPan.startPanX + dx;
                    panY = touchPan.startPanY + dy;
                    applyTransform();
                }
            }
        }, { passive: false });
        canvas.addEventListener('touchend', () => {
            if (touchPan?.moved) suppressNextClick = true;
            pinch = null;
            touchPan = null;
        });

        if (isCreator) {
            // Add-pin: click on empty canvas (only in normal mode, and only if not a drag)
            canvas.addEventListener('click', async (e) => {
                if (suppressNextClick) { suppressNextClick = false; return; }
                if (e.target.closest('.kms-map-pin')) return;
                if (pinDeleteMode || pinMoveMode) return;
                const { x, y } = pinCoordsFromEvent(e);
                if (x < 0 || x > 100 || y < 0 || y > 100) return;
                const choice = await pickArticleForPin(articles);
                if (!choice) return;
                await addMapPin(w.id, x, y, choice.articleId, choice.label);
                status(`📍 Добавлен пин: ${choice.label}`);
                renderMapView();
            });

            const delBtn = main.querySelector('[data-kms-map-pin-delete]');
            const moveBtn = main.querySelector('[data-kms-map-pin-move]');
            const hint = main.querySelector('[data-kms-map-hint]');

            const updateModeUI = () => {
                canvas.classList.toggle('kms-map-delete-mode', pinDeleteMode);
                canvas.classList.toggle('kms-map-move-mode', pinMoveMode);
                delBtn.classList.toggle('kms-btn-danger', pinDeleteMode);
                moveBtn.classList.toggle('kms-btn-active', pinMoveMode);
                delBtn.textContent = pinDeleteMode ? '✓ Готово' : '🗑 Удалить пин';
                moveBtn.textContent = pinMoveMode ? '✓ Готово' : '✋ Двигать';
                hint.textContent = pinDeleteMode
                    ? 'тыкай по пинам — удаляются. жми «Готово» чтобы выйти.'
                    : pinMoveMode
                        ? 'тащи пины мышкой. жми «Готово» чтобы выйти.'
                        : 'клик по карте → новый пин';
            };

            delBtn.addEventListener('click', () => {
                pinDeleteMode = !pinDeleteMode;
                if (pinDeleteMode) pinMoveMode = false; // mutex
                updateModeUI();
                status(pinDeleteMode ? '🗑 Режим удаления пинов.' : '👁 Обычный режим.');
            });
            moveBtn.addEventListener('click', () => {
                pinMoveMode = !pinMoveMode;
                if (pinMoveMode) pinDeleteMode = false; // mutex
                updateModeUI();
                status(pinMoveMode ? '✋ Режим перемещения пинов.' : '👁 Обычный режим.');
            });

            const replaceFile = main.querySelector('[data-kms-map-file]');
            main.querySelector('[data-kms-map-replace]').addEventListener('click', () => replaceFile.click());
            replaceFile.addEventListener('change', async (e) => {
                const f = e.target.files[0]; if (!f) return;
                try {
                    if (map.mediaId) await dbDelete('media', map.mediaId);
                    const mediaId = await saveImageBlob(f);
                    await setMapForWorld(w.id, mediaId);
                    renderMapView();
                } catch (err) { status(`❌ ${err.message}`, 'error'); }
            });
            main.querySelector('[data-kms-map-delete]').addEventListener('click', async () => {
                if (!confirm('Удалить карту вместе со всеми пинами?')) return;
                await deleteMap(w.id);
                renderMapView();
            });
        }
    }

    function pickArticleForPin(articles) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'kms-modal-overlay';
            const sorted = [...articles].sort((a,b) => a.title.localeCompare(b.title, 'ru'));
            overlay.innerHTML = `
                <div class="kms-dialog">
                    <h3>Привязать пин к статье</h3>
                    <p class="kms-dialog-sub">или оставь без статьи — будет просто метка с подписью</p>
                    <input type="search" class="kms-dialog-input" placeholder="Поиск статьи…" data-search/>
                    <select class="kms-dialog-input" size="8" data-pick>
                        <option value="">— без статьи (свободная метка) —</option>
                        ${sorted.map(a => `<option value="${escAttr(a.id)}">${escHtml(a.title)}${a.subtitle ? ' — ' + escHtml(a.subtitle) : ''}</option>`).join('')}
                    </select>
                    <input type="text" class="kms-dialog-input" placeholder="Подпись пина (опционально)" data-label/>
                    <div class="kms-dialog-actions">
                        <button class="kms-btn kms-btn-ghost" data-cancel>Отмена</button>
                        <button class="kms-btn" data-confirm>Поставить</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const sel = overlay.querySelector('[data-pick]');
            const search = overlay.querySelector('[data-search]');
            const labelEl = overlay.querySelector('[data-label]');
            search.addEventListener('input', () => {
                const q = search.value.toLowerCase();
                [...sel.options].forEach(o => {
                    o.hidden = o.value !== '' && !o.textContent.toLowerCase().includes(q);
                });
            });
            sel.addEventListener('change', () => {
                const opt = sel.options[sel.selectedIndex];
                if (opt && opt.value && !labelEl.value) {
                    labelEl.value = opt.textContent.split(' — ')[0];
                }
            });
            const finish = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
            overlay.querySelector('[data-confirm]').addEventListener('click', () => {
                finish({ articleId: sel.value || null, label: labelEl.value.trim() });
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
        });
    }

    // ── Infobox fields editor ──────────────────────────────────
    async function renderInfoboxFieldsEditor(catId) {
        const c = await dbGet('categories', catId);
        if (!c) return;

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'kms-modal-overlay';
            const fields = JSON.parse(JSON.stringify(c.infoboxFields || []));

            const render = () => {
                overlay.innerHTML = `
                    <div class="kms-dialog kms-dialog-wide">
                        <h3>Поля карточки: ${escHtml(c.icon || '')} ${escHtml(c.label)}</h3>
                        <p class="kms-dialog-sub">эти поля появятся в редакторе любой статьи этой категории. У игрока пустые поля скрыты.</p>

                        ${fields.length ? `
                        <ul class="kms-fields-list">
                            ${fields.map((f, i) => `
                                <li class="kms-fields-item">
                                    <input type="text" class="kms-field-key-input" value="${escHtml(f.key)}" data-fi="${i}" data-fk="key" placeholder="key (без пробелов)"/>
                                    <input type="text" class="kms-field-label-input" value="${escHtml(f.label)}" data-fi="${i}" data-fk="label" placeholder="Видимое название"/>
                                    <button class="kms-btn kms-btn-ghost" data-fi-up="${i}" ${i === 0 ? 'disabled' : ''} title="вверх">▲</button>
                                    <button class="kms-btn kms-btn-ghost" data-fi-down="${i}" ${i === fields.length - 1 ? 'disabled' : ''} title="вниз">▼</button>
                                    <button class="kms-btn kms-btn-ghost" data-fi-del="${i}" title="удалить">✕</button>
                                </li>
                            `).join('')}
                        </ul>` : `<div class="kms-empty-mini">Полей пока нет</div>`}

                        <div class="kms-fields-add">
                            <input type="text" class="kms-field-key-input" placeholder="key" data-new-key/>
                            <input type="text" class="kms-field-label-input" placeholder="Видимое название" data-new-label/>
                            <button class="kms-btn" data-add-field>+ Добавить поле</button>
                        </div>

                        <div class="kms-dialog-actions">
                            <button class="kms-btn kms-btn-ghost" data-cancel>Отмена</button>
                            <button class="kms-btn" data-save>Сохранить</button>
                        </div>
                    </div>
                `;
                bindHandlers();
            };

            const bindHandlers = () => {
                overlay.querySelectorAll('[data-fi]').forEach(el => {
                    el.addEventListener('change', () => {
                        const i = +el.dataset.fi;
                        const k = el.dataset.fk;
                        fields[i][k] = el.value.trim();
                    });
                });
                overlay.querySelectorAll('[data-fi-up]').forEach(el => el.addEventListener('click', () => {
                    const i = +el.dataset.fiUp;
                    [fields[i-1], fields[i]] = [fields[i], fields[i-1]];
                    render();
                }));
                overlay.querySelectorAll('[data-fi-down]').forEach(el => el.addEventListener('click', () => {
                    const i = +el.dataset.fiDown;
                    [fields[i+1], fields[i]] = [fields[i], fields[i+1]];
                    render();
                }));
                overlay.querySelectorAll('[data-fi-del]').forEach(el => el.addEventListener('click', () => {
                    const i = +el.dataset.fiDel;
                    fields.splice(i, 1);
                    render();
                }));
                overlay.querySelector('[data-add-field]').addEventListener('click', () => {
                    const k = overlay.querySelector('[data-new-key]').value.trim();
                    const l = overlay.querySelector('[data-new-label]').value.trim();
                    if (!k || !l) { status('Введи и key и название.', 'warn'); return; }
                    if (fields.find(f => f.key === k)) { status('Такой key уже есть.', 'warn'); return; }
                    fields.push({ key: k, label: l, type: 'text' });
                    render();
                });
                overlay.querySelector('[data-cancel]').addEventListener('click', () => { overlay.remove(); resolve(false); });
                overlay.querySelector('[data-save]').addEventListener('click', async () => {
                    await setCategoryInfoboxFields(c.id, fields);
                    overlay.remove();
                    resolve(true);
                });
            };

            document.body.appendChild(overlay);
            render();
        });
    }

    // ── Chat command templates editor (per category) ──────────
    async function renderCommandTemplatesEditor(catId) {
        const c = await dbGet('categories', catId);
        if (!c) return;
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'kms-modal-overlay';
            const cmds = JSON.parse(JSON.stringify(c.commandTemplates || []));

            const render = () => {
                overlay.innerHTML = `
                    <div class="kms-dialog kms-dialog-wide">
                        <h3>Кнопки-команды: ${escHtml(c.icon || '')} ${escHtml(c.label)}</h3>
                        <p class="kms-dialog-sub">Эти кнопки появятся под шапкой статьи. По клику текст подставится в поле чата ST. Плейсхолдеры: <code>{title}</code>, <code>{subtitle}</code>.</p>

                        ${cmds.length ? `
                        <ul class="kms-fields-list">
                            ${cmds.map((t, i) => `
                                <li class="kms-fields-item">
                                    <input type="text" class="kms-field-key-input" value="${escHtml(t.label)}" data-ti="${i}" data-tk="label" placeholder="Кнопка"/>
                                    <input type="text" class="kms-field-label-input" value="${escHtml(t.template)}" data-ti="${i}" data-tk="template" placeholder="Шаблон. Например: *спрашивает {title} о…*"/>
                                    <button class="kms-btn kms-btn-ghost" data-ti-up="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                                    <button class="kms-btn kms-btn-ghost" data-ti-down="${i}" ${i === cmds.length - 1 ? 'disabled' : ''}>▼</button>
                                    <button class="kms-btn kms-btn-ghost" data-ti-del="${i}">✕</button>
                                </li>
                            `).join('')}
                        </ul>` : `<div class="kms-empty-mini">Кнопок пока нет</div>`}

                        <div class="kms-fields-add">
                            <input type="text" class="kms-field-key-input" placeholder="Кнопка" data-new-label/>
                            <input type="text" class="kms-field-label-input" placeholder="Шаблон с {title}" data-new-template/>
                            <button class="kms-btn" data-add-cmd>+ Добавить</button>
                        </div>

                        <div class="kms-dialog-actions">
                            <button class="kms-btn kms-btn-ghost" data-cancel>Отмена</button>
                            <button class="kms-btn" data-save>Сохранить</button>
                        </div>
                    </div>
                `;
                bindHandlers();
            };
            const bindHandlers = () => {
                overlay.querySelectorAll('[data-ti]').forEach(el => el.addEventListener('change', () => {
                    cmds[+el.dataset.ti][el.dataset.tk] = el.value;
                }));
                overlay.querySelectorAll('[data-ti-up]').forEach(el => el.addEventListener('click', () => {
                    const i = +el.dataset.tiUp;
                    [cmds[i-1], cmds[i]] = [cmds[i], cmds[i-1]];
                    render();
                }));
                overlay.querySelectorAll('[data-ti-down]').forEach(el => el.addEventListener('click', () => {
                    const i = +el.dataset.tiDown;
                    [cmds[i+1], cmds[i]] = [cmds[i], cmds[i+1]];
                    render();
                }));
                overlay.querySelectorAll('[data-ti-del]').forEach(el => el.addEventListener('click', () => {
                    cmds.splice(+el.dataset.tiDel, 1);
                    render();
                }));
                overlay.querySelector('[data-add-cmd]').addEventListener('click', () => {
                    const lbl = overlay.querySelector('[data-new-label]').value.trim();
                    const tpl = overlay.querySelector('[data-new-template]').value.trim();
                    if (!lbl || !tpl) { status('Введи и кнопку и шаблон.', 'warn'); return; }
                    cmds.push({ label: lbl, template: tpl });
                    render();
                });
                overlay.querySelector('[data-cancel]').addEventListener('click', () => { overlay.remove(); resolve(false); });
                overlay.querySelector('[data-save]').addEventListener('click', async () => {
                    c.commandTemplates = cmds;
                    await dbPut('categories', c);
                    status(`💬 Команды категории «${c.label}» сохранены (${cmds.length} шт).`);
                    overlay.remove();
                    resolve(true);
                });
            };
            document.body.appendChild(overlay);
            render();
        });
    }

    // ── Sources manager ────────────────────────────────────────
    async function renderSourcesManager() {
        const w = await getCurrentWorld();
        if (!w) { status('Сначала импортируй лорбук — нужен мир.', 'warn'); return; }
        const sources = await getSourcesForWorld(w.id);
        const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);

        const overlay = document.createElement('div');
        overlay.className = 'kms-modal-overlay';

        const fmtDate = (ts) => {
            if (!ts) return '—';
            const d = new Date(ts);
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()}`;
        };

        overlay.innerHTML = `
            <div class="kms-dialog kms-dialog-wide">
                <h3>Лорбуки мира «${escHtml(w.name)}»</h3>
                <p class="kms-dialog-sub">в одном мире можно держать несколько лорбуков (например: основной + NPC-пак). Smart merge работает per-source — обновление одного не задевает другие.</p>

                ${sources.length ? `
                <ul class="kms-sources-list">
                    ${sources.map(s => {
                        const cnt = articles.filter(a => a.sourceId === s.id).length;
                        return `
                        <li class="kms-source-item">
                            <span class="kms-source-icon">📄</span>
                            <div class="kms-source-meta">
                                <div class="kms-source-name">${escHtml(s.fileName)}</div>
                                <div class="kms-source-info">
                                    <input type="text" class="kms-source-role-input" value="${escHtml(s.role || '')}" data-role-id="${escHtml(s.id)}" placeholder="роль (main/npcs/locations/…)" maxlength="20"/>
                                    <span class="kms-source-meta-text">${cnt} статей · обновлён ${fmtDate(s.lastUpdate)}</span>
                                </div>
                            </div>
                            <button class="kms-btn kms-btn-ghost kms-source-del" data-del="${escHtml(s.id)}" data-name="${escHtml(s.fileName)}" data-cnt="${cnt}" title="удалить source со всеми его статьями">🗑</button>
                        </li>`;
                    }).join('')}
                </ul>` : `<div class="kms-empty-mini">В этом мире пока нет sources. Странно — обычно они создаются при импорте.</div>`}

                <div class="kms-sources-add">
                    <p class="kms-sources-hint">Чтобы добавить новый лорбук в этот мир — закрой это окно, жми <b>📥 Лорбук</b> и выбери «📄 Добавить как новый source».</p>
                </div>

                <div class="kms-dialog-actions">
                    <button class="kms-btn" data-kms-close-dialog>Готово</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => { overlay.remove(); renderCatalog(); };
        overlay.querySelector('[data-kms-close-dialog]').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        // role inline edit
        overlay.querySelectorAll('[data-role-id]').forEach(el => {
            el.addEventListener('change', async () => {
                await updateSourceMeta(el.dataset.roleId, { role: el.value.trim() || 'misc' });
                status('📝 Роль source обновлена.');
            });
        });

        // delete with confirm
        overlay.querySelectorAll('[data-del]').forEach(el => {
            el.addEventListener('click', async () => {
                const cnt = el.dataset.cnt;
                const name = el.dataset.name;
                if (!confirm(`Удалить source «${name}» вместе с ${cnt} статьями? Это действие нельзя отменить.`)) return;
                await deleteSourceWithArticles(el.dataset.del);
                overlay.remove();
                renderSourcesManager(); // re-open with updated list
            });
        });
    }

    // ── Bottom sheet (generic mobile component) ───────────────
    function openBottomSheet({ title, html, onMount }) {
        // close any existing
        document.querySelector('.kms-bsheet-backdrop')?.remove();
        const bd = document.createElement('div');
        bd.className = 'kms-bsheet-backdrop';
        bd.innerHTML = `
            <div class="kms-bsheet">
                <div class="kms-bsheet-handle"></div>
                ${title ? `<div class="kms-bsheet-title">${escHtml(title)}</div>` : ''}
                <div class="kms-bsheet-body">${html}</div>
            </div>
        `;
        const close = () => bd.remove();
        bd.addEventListener('click', e => { if (e.target === bd) close(); });
        document.body.appendChild(bd);
        if (onMount) onMount(bd, close);
        return { el: bd, close };
    }

    // ── More menu (mobile sheet) ──────────────────────────────
    function openMoreMenuSheet() {
        const s = getSettings();
        const html = `
            <div class="kms-bsheet-toggle" data-toggle="creator">
                <span class="kms-bsheet-icon">✏️</span>
                <span>Режим креатора</span>
                <span class="kms-bsheet-tg ${s.creatorMode ? 'on' : ''}"></span>
            </div>
            <div class="kms-bsheet-toggle" data-toggle="spoilers">
                <span class="kms-bsheet-icon">🔒</span>
                <span>Показать спойлеры</span>
                <span class="kms-bsheet-tg ${s.showSpoilersGlobal ? 'on' : ''}"></span>
            </div>
            <div class="kms-bsheet-toggle" data-toggle="toasts">
                <span class="kms-bsheet-icon">🔔</span>
                <span>Уведомления о упоминаниях</span>
                <span class="kms-bsheet-tg ${s.mentionToasts ? 'on' : ''}"></span>
            </div>
            <div class="kms-bsheet-toggle" data-toggle="livetrack">
                <span class="kms-bsheet-icon">👁</span>
                <span>Live-tracking чата</span>
                <span class="kms-bsheet-tg ${s.liveTracking ? 'on' : ''}"></span>
            </div>

            <div class="kms-bsheet-divider"></div>

            <div class="kms-bsheet-row" data-act="import-lorebook">
                <span class="kms-bsheet-icon">📥</span><span>Импорт ST-лорбука</span>
            </div>
            <div class="kms-bsheet-row" data-act="export">
                <span class="kms-bsheet-icon">📦</span><span>Экспорт мира (.kms.json)</span>
            </div>
            <div class="kms-bsheet-row" data-act="bundle-import">
                <span class="kms-bsheet-icon">📂</span><span>Импорт пакета (.kms.json)</span>
            </div>

            <div class="kms-bsheet-divider"></div>

            <div class="kms-bsheet-row" data-act="sources"><span class="kms-bsheet-icon">📚</span><span>Лорбуки в этом мире</span></div>
            <div class="kms-bsheet-row" data-act="categories"><span class="kms-bsheet-icon">⚙️</span><span>Категории</span></div>
            <div class="kms-bsheet-row" data-act="map-from-more"><span class="kms-bsheet-icon">🗺</span><span>Открыть карту</span></div>
            <div class="kms-bsheet-row" data-act="journal"><span class="kms-bsheet-icon">+📓</span><span>Новая запись в дневник</span></div>
            <div class="kms-bsheet-row" data-act="random"><span class="kms-bsheet-icon">🎲</span><span>Случайная статья</span></div>
            <div class="kms-bsheet-row" data-act="status-log"><span class="kms-bsheet-icon">📋</span><span>Журнал событий</span></div>
        `;
        openBottomSheet({ title: 'Меню', html, onMount: (sheet, close) => {
            sheet.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
                const k = el.dataset.toggle;
                if (k === 'creator')      toggleCreatorMode();
                else if (k === 'spoilers') toggleSpoilersGlobal();
                else if (k === 'toasts')   toggleToasts();
                else if (k === 'livetrack') {
                    const cur = getSettings();
                    cur.liveTracking = !cur.liveTracking;
                    saveSettings();
                    if (cur.liveTracking) startChatObserver();
                    else stopChatObserver();
                    status(cur.liveTracking ? '👁 Live-tracking включён.' : '👁 Live-tracking выключен.');
                }
                el.querySelector('.kms-bsheet-tg').classList.toggle('on');
            }));
            sheet.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', () => {
                const a = el.dataset.act;
                close();
                if (a === 'import-lorebook') drawerEl.querySelector('[data-kms-file-lorebook]').click();
                else if (a === 'export') exportCurrentWorld();
                else if (a === 'bundle-import') drawerEl.querySelector('[data-kms-file-bundle]').click();
                else if (a === 'sources') renderSourcesManager();
                else if (a === 'categories') renderCategoriesManager();
                else if (a === 'map-from-more') switchMobileTab('map');
                else if (a === 'journal') createJournalFromPrompt();
                else if (a === 'random') openRandomArticle();
                else if (a === 'status-log') openStatusLogSheet();
            }));
        }});
    }

    async function createJournalFromPrompt() {
        const w = await getCurrentWorld();
        if (!w) { status('Сначала создай мир.', 'warn'); return; }
        const title = prompt('Название записи:', 'Без названия');
        if (!title) return;
        const a = await createJournalArticle(w.id, title.trim());
        await renderCatalog();
        await renderArticle(a.id); // mobile tab switch handled inside
    }

    function openStatusLogSheet() {
        const html = `<ul class="kms-status-log-list">${eventLog.slice(0, 50).map(e => `
            <li class="kms-log-item kms-log-${e.level}">
                <span class="kms-log-time">${fmtTime(e.ts)}</span>
                <span class="kms-log-msg">${escHtml(e.msg)}</span>
            </li>`).join('')}</ul>`;
        openBottomSheet({ title: 'Журнал событий', html });
    }

    // ── World switcher sheet ──────────────────────────────────
    async function openWorldSwitcherSheet() {
        const worlds = await getWorlds();
        const cur = await getCurrentWorld();
        const counts = {};
        const articles = await dbGetAll('articles');
        for (const a of articles) counts[a.worldId] = (counts[a.worldId] || 0) + 1;

        const html = `
            ${worlds.length === 0 ? `<div class="kms-bsheet-empty">Миров пока нет — импортируй лорбук</div>` : ''}
            ${worlds.map(w => `
                <div class="kms-bsheet-row ${w.id === cur?.id ? 'kms-bsheet-active' : ''}" data-pick="${escHtml(w.id)}">
                    <span class="kms-bsheet-icon">🌍</span>
                    <span>${escHtml(w.name)}</span>
                    <span class="kms-bsheet-meta">${counts[w.id] || 0} статей</span>
                </div>
            `).join('')}
            <div class="kms-bsheet-divider"></div>
            <div class="kms-bsheet-row" data-act="rename"><span class="kms-bsheet-icon">✎</span><span>Переименовать активный мир</span></div>
            <div class="kms-bsheet-row" data-act="new"><span class="kms-bsheet-icon">📥</span><span>Создать новый мир из лорбука</span></div>
        `;
        openBottomSheet({ title: 'Сменить мир', html, onMount: (sheet, close) => {
            sheet.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', async () => {
                close();
                await setCurrentWorld(el.dataset.pick); // also handles mobile tab
            }));
            sheet.querySelector('[data-act="rename"]')?.addEventListener('click', () => { close(); renameCurrentWorld(); });
            sheet.querySelector('[data-act="new"]')?.addEventListener('click', () => {
                close();
                drawerEl.querySelector('[data-kms-file-lorebook]').click();
            });
        }});
    }

    // ── Search overlay ────────────────────────────────────────
    function openSearchOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'kms-search-overlay';
        overlay.innerHTML = `
            <header class="kms-search-bar">
                <button class="kms-mback" data-close>←</button>
                <input class="kms-search-input" type="search" placeholder="Поиск по миру…" autofocus/>
                <button class="kms-icon-btn" data-clear>✕</button>
            </header>
            <div class="kms-search-results" data-results>
                <div class="kms-search-hint">Введи запрос — ищет по названиям, подзаголовкам, тегам, snippet и body.</div>
            </div>
        `;
        document.body.appendChild(overlay);
        const inp = overlay.querySelector('.kms-search-input');
        const results = overlay.querySelector('[data-results]');
        const close = () => overlay.remove();

        let typingTimer = null;
        const doSearch = async () => {
            const q = inp.value.trim().toLowerCase();
            if (!q) {
                results.innerHTML = `<div class="kms-search-hint">Введи запрос — ищет по названиям, подзаголовкам, тегам, snippet и body.</div>`;
                return;
            }
            const w = await getCurrentWorld();
            if (!w) { results.innerHTML = `<div class="kms-search-hint">Сначала открой мир.</div>`; return; }
            const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);
            const hits = [];
            for (const a of articles) {
                const inTitle = a.title?.toLowerCase().includes(q);
                const inSub   = a.subtitle?.toLowerCase().includes(q);
                const inTags  = (a.tags || []).some(t => t.toLowerCase().includes(q));
                const body    = a.body || '';
                const inBody  = body.toLowerCase().includes(q);
                const snip    = a.snippet || '';
                const inSnip  = snip.toLowerCase().includes(q);
                if (inTitle || inSub || inTags || inBody || inSnip) {
                    let preview = '';
                    if (!inTitle && !inSub) {
                        const src = inBody ? body : snip;
                        const idx = src.toLowerCase().indexOf(q);
                        if (idx >= 0) {
                            const start = Math.max(0, idx - 30);
                            const end = Math.min(src.length, idx + q.length + 60);
                            preview = (start > 0 ? '…' : '') + src.slice(start, end) + (end < src.length ? '…' : '');
                        }
                    }
                    hits.push({ a, preview });
                }
            }
            if (hits.length === 0) {
                results.innerHTML = `<div class="kms-search-hint">Ничего не найдено.</div>`;
                return;
            }
            const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const highlight = (s) => escHtml(s).replace(re, m => `<mark>${m}</mark>`);
            results.innerHTML = `
                <div class="kms-search-meta">${hits.length} совпадений</div>
                <ul class="kms-search-list">
                    ${hits.slice(0, 50).map(({a, preview}) => `
                        <li data-go="${escHtml(a.id)}">
                            <div class="kms-search-title">${highlight(a.title)}${a.subtitle ? ` <span class="kms-search-sub">— ${highlight(a.subtitle)}</span>` : ''}</div>
                            ${preview ? `<div class="kms-search-preview">${highlight(preview).replace(/\n+/g, ' ')}</div>` : ''}
                        </li>
                    `).join('')}
                </ul>
            `;
            results.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
                close();
                renderArticle(el.dataset.go);
            }));
        };
        inp.addEventListener('input', () => { clearTimeout(typingTimer); typingTimer = setTimeout(doSearch, 180); });
        overlay.querySelector('[data-close]').addEventListener('click', close);
        overlay.querySelector('[data-clear]').addEventListener('click', () => { inp.value = ''; inp.focus(); doSearch(); });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
        });
        setTimeout(() => inp.focus(), 50);
    }

    function stopChatObserver() {
        if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    }

    // ── Bundle export / import ────────────────────────────────
    // Single .kms.json file with base64 media — no zip dependency.
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => {
                const dataUrl = r.result;
                resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
            };
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
    }
    function base64ToBlob(b64, type) {
        const byteChars = atob(b64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        return new Blob([bytes], { type: type || 'application/octet-stream' });
    }

    async function exportCurrentWorld() {
        const w = await getCurrentWorld();
        if (!w) { status('Сначала открой мир для экспорта.', 'warn'); return; }
        try {
            status(`📦 Сборка бандла для «${w.name}»…`);
            const sources = await getSourcesForWorld(w.id);
            const categories = await getCategoriesForWorld(w.id);
            const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id);
            const map = await dbGet('maps', `${w.id}::map`);
            // Collect all referenced media ids
            const mediaIds = new Set();
            for (const a of articles) for (const id of (a.media || [])) mediaIds.add(id);
            if (map?.mediaId) mediaIds.add(map.mediaId);
            const mediaArr = [];
            for (const id of mediaIds) {
                const rec = await dbGet('media', id);
                if (!rec || !rec.blob) continue;
                const b64 = await blobToBase64(rec.blob);
                mediaArr.push({
                    id: rec.id,
                    name: rec.name,
                    type: rec.type,
                    size: rec.size,
                    data: b64,
                });
            }

            const bundle = {
                kmsBundleVersion: 1,
                exportedAt: Date.now(),
                exportedBy: 'Know My Setting v' + VERSION,
                world: w,
                sources,
                categories,
                articles,
                map: map || null,
                media: mediaArr,
            };
            const json = JSON.stringify(bundle, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = (w.name || 'world').replace(/[^\wÀ-￿\- ]+/g, '').slice(0, 60).trim() || 'world';
            a.href = url;
            a.download = `${safeName}.kms.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            status(`✅ Экспорт готов: ${articles.length} статей · ${mediaArr.length} картинок · ${(blob.size/1024/1024).toFixed(1)} МБ.`);
        } catch (err) {
            status(`❌ Экспорт не удался: ${err.message}`, 'error');
        }
    }

    async function onBundleSelected(e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
            status(`📂 Чтение «${file.name}»…`);
            const text = await file.text();
            const bundle = JSON.parse(text);
            if (!bundle.kmsBundleVersion || !bundle.world) {
                throw new Error('Это не похоже на пакет KMS.');
            }
            const choice = await chooseBundleImportTarget(bundle);
            if (!choice) { status('Импорт пакета отменён.'); return; }

            // Decide world id
            let world = bundle.world;
            if (choice.action === 'newWorld') {
                world = { ...world, id: `world-${uid()}`, createdAt: Date.now(), updatedAt: Date.now() };
                await dbPut('worlds', world);
                status(`🌍 Создан мир «${world.name}».`);
            } else {
                world = await dbGet('worlds', choice.worldId);
                if (!world) throw new Error('Целевой мир не найден.');
            }

            // Map old id → new id (so we can rewrite references)
            const idMap = new Map();
            idMap.set(bundle.world.id, world.id);

            // Sources: rebuild ids under the new world
            for (const src of (bundle.sources || [])) {
                const newId = `${world.id}::src-${uid()}`;
                idMap.set(src.id, newId);
                await dbPut('sources', { ...src, id: newId, worldId: world.id });
            }
            // Categories: keep keys but rewrite ids under new world
            for (const cat of (bundle.categories || [])) {
                const newId = `${world.id}::cat-${cat.key}`;
                idMap.set(cat.id, newId);
                // If a category with same key already exists in target world (merge), keep existing
                const existing = await dbGet('categories', newId);
                if (!existing) await dbPut('categories', { ...cat, id: newId, worldId: world.id });
            }
            // Media: rebuild ids
            for (const m of (bundle.media || [])) {
                const newId = `img-${uid()}`;
                idMap.set(m.id, newId);
                const blob = base64ToBlob(m.data, m.type);
                await dbPut('media', {
                    id: newId, blob, name: m.name, type: m.type, size: m.size,
                    createdAt: Date.now(),
                });
            }
            // Articles: rewrite id, sourceId, worldId, media[]
            for (const art of (bundle.articles || [])) {
                const newSourceId = idMap.get(art.sourceId) || art.sourceId;
                const newId = `${newSourceId}::entry-${art.uid}`;
                const newMedia = (art.media || []).map(mid => idMap.get(mid)).filter(Boolean);
                idMap.set(art.id, newId);
                await dbPut('articles', {
                    ...art, id: newId, sourceId: newSourceId, worldId: world.id, media: newMedia,
                });
            }
            // Map: rewrite mediaId + pin articleIds
            if (bundle.map) {
                const m = { ...bundle.map };
                m.id = `${world.id}::map`;
                m.worldId = world.id;
                m.mediaId = idMap.get(m.mediaId) || m.mediaId;
                m.pins = (m.pins || []).map(p => ({
                    ...p, articleId: p.articleId ? (idMap.get(p.articleId) || null) : null,
                }));
                await dbPut('maps', m);
            }

            // Switch to imported world
            const s = getSettings();
            s.currentWorldId = world.id;
            saveSettings();

            status(`✅ Пакет импортирован: ${(bundle.articles || []).length} статей, ${(bundle.media || []).length} картинок.`);
            await renderWorldSelector();
            await renderCatalog();
            const articles = (await dbGetAll('articles')).filter(a => a.worldId === world.id);
            if (articles[0]) await renderArticle(articles[0].id);
        } catch (err) {
            status(`❌ Импорт пакета не удался: ${err.message}`, 'error');
        } finally {
            e.target.value = '';
        }
    }

    function chooseBundleImportTarget(bundle) {
        return new Promise(async (resolve) => {
            const worlds = await getWorlds();
            const overlay = document.createElement('div');
            overlay.className = 'kms-modal-overlay';
            overlay.innerHTML = `
                <div class="kms-dialog">
                    <h3>Импорт пакета</h3>
                    <p class="kms-dialog-sub">«${escHtml(bundle.world?.name || 'мир')}» · ${(bundle.articles||[]).length} статей · ${(bundle.media||[]).length} картинок</p>
                    <label class="kms-radio-row">
                        <input type="radio" name="kms-bundle-target" value="newWorld" checked/>
                        <span>🌍 Создать как <b>новый мир</b></span>
                    </label>
                    ${worlds.length ? `
                    <label class="kms-radio-row">
                        <input type="radio" name="kms-bundle-target" value="existing"/>
                        <span>🔄 <b>Влить</b> в существующий (статьи добавятся, существующие с тем же uid обновятся)</span>
                    </label>
                    <select class="kms-dialog-input kms-indent" data-pick disabled>
                        ${worlds.map(w => `<option value="${escHtml(w.id)}">${escHtml(w.name)}</option>`).join('')}
                    </select>` : ''}
                    <div class="kms-dialog-actions">
                        <button class="kms-btn kms-btn-ghost" data-cancel>Отмена</button>
                        <button class="kms-btn" data-confirm>Импортировать</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const sel = overlay.querySelector('[data-pick]');
            overlay.querySelectorAll('input[name="kms-bundle-target"]').forEach(r => r.addEventListener('change', () => {
                if (sel) sel.disabled = overlay.querySelector('input[name="kms-bundle-target"]:checked').value !== 'existing';
            }));
            const finish = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
            overlay.querySelector('[data-confirm]').addEventListener('click', () => {
                const v = overlay.querySelector('input[name="kms-bundle-target"]:checked').value;
                if (v === 'newWorld') finish({ action: 'newWorld' });
                else finish({ action: 'existing', worldId: sel.value });
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
        });
    }

    // ── Live chat tracking ────────────────────────────────────
    let chatObserver = null;
    function startChatObserver() {
        if (chatObserver || !getSettings().liveTracking) return;
        const target = document.getElementById('chat') || document.querySelector('#chat, .chat, [data-chat]');
        if (!target) {
            // Try again later
            setTimeout(startChatObserver, 3000);
            return;
        }
        chatObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (!(n instanceof HTMLElement)) continue;
                    // Look at the message text
                    const mes = n.classList?.contains('mes') ? n : n.querySelector?.('.mes');
                    if (!mes) continue;
                    const txt = (mes.querySelector('.mes_text')?.innerText || mes.innerText || '').trim();
                    if (txt) scanForMentions(txt);
                }
            }
        });
        chatObserver.observe(target, { childList: true, subtree: true });
    }

    async function scanForMentions(text) {
        const w = await getCurrentWorld();
        if (!w) return;
        const articles = (await dbGetAll('articles')).filter(a => a.worldId === w.id && !a.spoiler);
        if (articles.length === 0) return;
        const patterns = compileGlossaryPatterns(articles);
        const matched = new Map(); // articleId → title
        for (const p of patterns) {
            if (matched.has(p.articleId)) continue;
            if (p.regex.test(text)) matched.set(p.articleId, p.title);
        }
        if (matched.size === 0) return;
        // Update mentioned set & nav
        mentionedArticleIds.clear();
        for (const id of matched.keys()) mentionedArticleIds.add(id);
        if (drawerEl && isOpen) renderCatalog();
        // Toast
        showMentionToast([...matched.values()].slice(0, 3), [...matched.keys()][0]);
    }

    function showMentionToast(titles, firstId) {
        if (!getSettings().mentionToasts) return; // user disabled toasts
        // Remove existing toast
        document.querySelector('.kms-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = 'kms-toast';
        const titleStr = titles.join(', ') + (titles.length === 3 ? '…' : '');
        toast.innerHTML = `
            <span class="kms-toast-icon">📖</span>
            <span class="kms-toast-text"><b>${escHtml(titleStr)}</b></span>
            <button class="kms-btn kms-toast-open" data-open title="Открыть статью">→</button>
            <button class="kms-btn kms-btn-ghost kms-toast-close" data-close title="Закрыть">✕</button>
        `;
        document.body.appendChild(toast);
        toast.querySelector('[data-open]').addEventListener('click', () => {
            toast.remove();
            openDrawer().then(() => renderArticle(firstId));
        });
        toast.querySelector('[data-close]').addEventListener('click', () => toast.remove());
        setTimeout(() => toast.remove(), 6000);
    }

    // ── Mount entry points (menu item + optional FAB + hotkey) ─
    function toggleDrawerOpen() { if (isOpen) closeDrawer(); else openDrawer(); }

    function mountFab() {
        if (document.querySelector('.kms-fab')) return;
        if (!getSettings().showFab) return;
        const fab = document.createElement('button');
        fab.className = 'kms-fab';
        fab.title = 'Know My Setting (хоткей: ' + (getSettings().hotkey || 'Alt+K') + ')';
        fab.textContent = '📖';
        fab.addEventListener('click', toggleDrawerOpen);
        document.body.appendChild(fab);
    }
    function unmountFab() {
        const fab = document.querySelector('.kms-fab');
        if (fab) fab.remove();
    }

    function bindHotkey() {
        document.addEventListener('keydown', (e) => {
            const hk = (getSettings().hotkey || 'Alt+K').toLowerCase();
            const parts = hk.split('+');
            const wantAlt   = parts.includes('alt');
            const wantCtrl  = parts.includes('ctrl');
            const wantShift = parts.includes('shift');
            const wantMeta  = parts.includes('meta') || parts.includes('cmd');
            const wantKey   = parts[parts.length - 1];
            if (e.altKey   !== wantAlt)   return;
            if (e.ctrlKey  !== wantCtrl)  return;
            if (e.shiftKey !== wantShift) return;
            if (e.metaKey  !== wantMeta)  return;
            if (e.key.toLowerCase() !== wantKey) return;
            // ignore if user is typing in an input outside our drawer
            const t = e.target;
            const inOurDrawer = drawerEl && drawerEl.contains(t);
            const inInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
            if (inInput && !inOurDrawer) return;
            e.preventDefault();
            toggleDrawerOpen();
        });
    }

    function mountMenuItem() {
        const tryMount = () => {
            const menu = document.getElementById('extensionsMenu');
            if (!menu) return false;
            if (menu.querySelector('[data-kms-menu-item]')) return true;
            const item = document.createElement('div');
            item.dataset.kmsMenuItem = '1';
            item.className = 'list-group-item flex-container flexGap5 interactable';
            item.tabIndex = 0;
            item.title = 'Know My Setting';
            item.innerHTML = `
                <div class="fa-fw fa-solid fa-book-atlas extensionsMenuExtensionButton"></div>
                <span>Know My Setting</span>
            `;
            item.addEventListener('click', openDrawer);
            menu.appendChild(item);
            return true;
        };
        if (tryMount()) return;
        const obs = new MutationObserver(() => { if (tryMount()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function mountButton() {
        mountMenuItem();
        mountFab();
        bindHotkey();
    }

    // ── Init ───────────────────────────────────────────────────
    async function init() {
        try { getSettings(); } catch (e) {}
        mountButton();
        try {
            await migrateLegacyDataIfNeeded();    // v0.2 → v0.3
            await migrateToSourcesIfNeeded();     // v0.4 → v0.5 (multi-source)
        } catch (e) {
            status(`⚠ Миграция не удалась: ${e.message}`, 'error');
        }
        // Live chat tracking
        startChatObserver();
        status(`Расширение готово. v${VERSION}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
