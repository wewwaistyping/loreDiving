# Know My Setting — что умеет (на момент v0.7.3)

> Файл для сжатой передачи контекста другой сессии Claude, если возникнет
> необходимость уйти в отдельный бранч или начать с чистого листа.
> Дата последнего обновления: 2026-05-09

---

## Концепция

SillyTavern-расширение, которое превращает **ST-лорбук** в **интерактивную
энциклопедию мира**. Креатор оформляет (картинки, длинные тексты, карта,
спойлеры), игрок читает (с заметками, избранным, прочитано/непрочитано,
автоссылками между статьями).

**Сейчас расширение НЕ редактирует лорбук ST** — оно работает с собственной
копией данных в IndexedDB, лорбук используется только как источник для
импорта.

---

## Data Model (IndexedDB `kms-wiki` v4)

### Stores

| Store | Назначение | keyPath |
|---|---|---|
| `worlds` | Сеттинги/миры | `id` |
| `sources` | Лорбуки внутри одного мира (multi-source) | `id` |
| `categories` | Категории статей per-world | `id` |
| `articles` | Сами статьи | `id` |
| `media` | Картинки (Blob) | `id` |
| `maps` | Карты миров (один на мир) | `id` |

### Article (главная сущность)

```js
{
  id:           `${sourceId}::entry-${uid}`,
  worldId:      'world-xxx',
  sourceId:     'world-xxx::src-yyy',
  uid:          7,                          // оригинальный uid из лорбука
  title:        'Tyoma',
  subtitle:     'The gloved boy',
  categoryKey:  'character',                // ссылка на categories.key
  tags:         ['Tyoma', 'Юг'],
  spoiler:      false,
  snippet:      '...',                      // оригинальный content лорбука (read-only)
  body:         '...',                      // длинный текст энциклопедии (наше)
  bodyVariants: { ru: '...', en: '...' },   // многоязычность
  infobox:      { age: '24', status: 'жив' },// per-category поля
  media:        ['img-xxx', 'img-yyy'],     // ссылки на media store
  related:      [],                         // зарезервировано (граф связей не сделан)
  source: {                                 // backup данных из лорбука
    keys:    [...],                         // regex/keywords активации
    comment: 'оригинальный comment',
    disabled: false,
  },
  manualEdits:  ['title', 'tags'],          // какие поля юзер правил вручную → не перезаписывать при merge
  orphaned:     false,                      // запись исчезла из лорбука при re-import
  createdAt, updatedAt
}
```

### Категория

```js
{
  id: `${worldId}::cat-${key}`,
  worldId, key, label, icon, order, isSpoiler, builtin,
  infoboxFields:    [{ key, label, type }],  // схема полей для статей этой категории
  commandTemplates: [{ label, template }],   // шаблоны для кнопок "вставить в чат"
}
```

### Source (multi-source: один мир — много лорбуков)

```js
{ id, worldId, fileName, role, importedAt, lastUpdate, entryCount }
```

### Map

```js
{
  id: `${worldId}::map`,
  worldId, mediaId,
  pins: [{ id, x, y, articleId, label }],   // x,y в процентах от картинки
}
```

### Player layer (отдельно от articles, в `extensionSettings.know_my_setting.playerData`)

```js
{ [articleId]: { notes: '...', favorite: bool, read: bool } }
```

Не теряется при re-import лорбука.

---

## Файлы расширения

| Файл | Размер | Что внутри |
|---|---|---|
| `manifest.json` | < 300B | ST extension manifest |
| `index.js` | ~3700 строк | вся логика, IIFE без зависимостей |
| `style.css` | ~2200 строк | drawer + mobile + темная пергаментная тема |
| `README.md` | — | публичный README для GitHub |
| `mocks/mobile.html` | — | мокапы мобильного UI |

---

## История версий

| Версия | Что добавлено |
|---|---|
| v0.1.0 | Drawer (fullscreen modal), импорт лорбука, базовый каталог + reader |
| v0.2.0 | Перешли на left-side drawer, добавили status log, editor, картинки + lightbox |
| v0.3.0 | Мульти-мир, smart merge при импорте, multi-tag (был `arc`), кастомные категории, спойлеры |
| v0.4.0 | Auto-resize картинок (canvas, 1920px, JPEG 85%), карта с пинами, infobox-поля per-category, автоглоссарий (regex-keys + title fallback) |
| v0.5.0 | Multi-source (один мир — много лорбуков), smart merge per-source |
| v0.6.0 | Player layer (заметки/⭐/прочитано/дневник), FAB + хоткей Alt+K, многоязычные body, кнопки-команды в чат, экспорт/импорт `.kms.json` бандла, live-tracking чата (DOM observer + toast), случайная статья |
| v0.7.0 | Полноценный мобильный UI: bottom tabs, bottom sheets, immersive map, fullscreen editor |
| v0.7.1 | Hotfix: кнопка ✕ в мобильном top bar (забыл), переменные тем на overlays |
| v0.7.2 | Hotfix iOS: bottom sheets улетали из-за `inset:0` + transformed parent |
| v0.7.3 | Categories manager на мобиле, тоггл не выкидывает на статью |

---

## Ключевые архитектурные решения

1. **Wiki ≠ лорбук** — мы храним свою копию, лорбук не трогаем
2. **Smart merge** — re-import лорбука сохраняет правки креатора (через `manualEdits[]` маркеры)
3. **Multi-source** — один мир может содержать несколько лорбуков с независимым merge
4. **Player layer** хранится в settings, отдельно от articles → не теряется при re-import
5. **Картинки в IndexedDB** как Blob, ссылки в article.media[]. Auto-resize до 1920px JPEG 85%
6. **Glossary использует regex-ключи лорбука** для падежей (fallback на literal title)
7. **Mobile через class** `.kms-mobile` (по media query 820px), bottom tabs управляют `mobileTab` state
8. **Все overlays** должны включать CSS-переменные (баг v0.7.1: на iOS transparent оверлеи)
9. **Bottom sheet — absolute, не flex** (баг v0.7.2: transformed parent ломает fixed-flex)

---

## Главные функции в index.js

| Функция | Что делает |
|---|---|
| `openDB()` | IndexedDB с миграциями v1→v4 |
| `migrateLegacyDataIfNeeded()` | v0.2 → v0.3: создаёт world для articles без worldId |
| `migrateToSourcesIfNeeded()` | v0.4 → v0.5: создаёт source для articles без sourceId |
| `lorebookToArticles(json, worldId, sourceId)` | парсер ST-лорбука → наши articles |
| `smartMergeImport(json, worldId, sourceId)` | re-import с сохранением правок |
| `categorize(comment)` | эмодзи-первые-6-символов + текстовая эвристика |
| `linkifyBody(text, articles, showSpoilers)` | автоглоссарий с trim'ом, поддержка `\|\|spoiler\|\|` |
| `compileGlossaryPatterns(articles)` | regex-keys лорбука или literal title |
| `resizeImageIfNeeded(file)` | canvas resize до 1920px, JPEG 85% |
| `buildDrawer()` | весь HTML расширения |
| `renderCatalog()` | дерево категорий + теги + фильтры + mentioned-подсветка |
| `renderReader(a, allowEdit)` | статья: gallery + infobox + body+linkify + notes + chat-cmds |
| `renderEditor(a)` | редактор: title/sub/cat/tags/spoiler/infobox/dropzone/lang-tabs/body |
| `renderMapView()` | карта + пины + zoom/pan + 3 mode (normal/delete/move) |
| `exportCurrentWorld()` | сборка `.kms.json` бандла (base64 media) |
| `onBundleSelected()` | импорт `.kms.json` с пересборкой ID |
| `startChatObserver()` | live-tracking: MutationObserver на #chat |
| `scanForMentions(text)` | прогоняет текст через glossary patterns, показывает toast |
| `openMoreMenuSheet()` | bottom sheet «Ещё» (мобильное меню) |
| `openWorldSwitcherSheet()` | bottom sheet для смены мира |
| `openSearchOverlay()` | full-screen поиск с подсветкой |

---

## Что НЕ сделано (явно решили не делать или отложили)

- **Граф связей** — обсудили, не делали (опционально, если будет настроение)
- **Аудио** — выкинули
- **LLM-ассистент по статьям** — выкинули
- **История из чатов** (post-hoc индекс) — выкинули (тяжело, creepy)
- **Несколько тем** оформления — обсуждали, не сделали
- **Highlights в Kindle-стиле** (закладки внутри текста) — отложено
- **Свайпы между табами** на мобиле — отложено (для MVP просто тапы)
