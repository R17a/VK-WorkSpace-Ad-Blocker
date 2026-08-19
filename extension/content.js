// VK WorkSpace Ad Blocker — content script
//
// Идея: classname/URL рекламных блоков в SPA меняются при каждой сборке,
// поэтому статические CSS-селекторы (как в AdGuard) быстро протухают.
// Но по закону "О рекламе" (ФЗ-38) рекламный блок обязан нести пометку
// "Реклама" — этот текст убрать нельзя, значит на него можно опираться
// как на стабильный якорь. Плюс отдельно прячем img/iframe с известных
// рекламных хостов, кто бы их ни выдавал. Никакие сетевые запросы не
// блокируются — только скрытие уже отрисованных DOM-элементов, чтобы
// не было риска сломать загрузку самого приложения.
(function () {
  'use strict';

  const LOG = '[VKAdsBlocker]';
  const t0 = performance.now();
  const logBuffer = [];
  let dirty = false;

  function persistLog() {
    if (!dirty) return;
    dirty = false;
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ vkAdsBlockerLog: logBuffer.slice(-300) });
      }
    } catch (e) {
      /* игнорируем — storage мог быть недоступен в момент выгрузки страницы */
    }
  }
  setInterval(persistLog, 500);

  function logEvent(tag, data) {
    const entry = { t: Math.round(performance.now() - t0), tag, data };
    logBuffer.push(entry);
    if (logBuffer.length > 300) logBuffer.shift();
    dirty = true;
    // Пишем данные прямо в текст строки (не отдельным object-аргументом),
    // чтобы их было видно инструментам, которые не разворачивают объекты
    // в консоли (например, удалённое чтение логов).
    let dataStr = '';
    try {
      dataStr = data !== undefined ? JSON.stringify(data) : '';
    } catch (e) {
      dataStr = String(data);
    }
    console.log(LOG + ' [' + entry.t + 'ms] ' + tag + ' ' + dataStr);
  }

  function bodySnapshot() {
    const b = document.body;
    return b
      ? { childEls: b.childElementCount, textLen: (b.innerText || '').length, readyState: document.readyState }
      : { childEls: -1, textLen: -1, readyState: document.readyState };
  }

  // Печатаем лог с прошлой загрузки (если страница только что перезагрузилась
  // после сбоя, здесь может быть полезный хвост событий).
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get('vkAdsBlockerLog', (res) => {
        if (res && res.vkAdsBlockerLog && res.vkAdsBlockerLog.length) {
          console.log(LOG, '=== лог с ПРЕДЫДУЩЕЙ загрузки страницы ===');
          console.table(res.vkAdsBlockerLog.map((e) => ({ t: e.t, tag: e.tag, data: JSON.stringify(e.data) })));
          console.log(LOG, '=== конец предыдущего лога ===');
        }
      });
    }
  } catch (e) {}

  logEvent('script-init', { href: location.href, readyState: document.readyState });

  window.addEventListener('error', (e) => {
    logEvent('window-error', { message: e.message, filename: e.filename, lineno: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    logEvent('unhandled-rejection', { reason: String(e.reason && e.reason.message ? e.reason.message : e.reason) });
  });
  document.addEventListener('DOMContentLoaded', () => logEvent('DOMContentLoaded', bodySnapshot()));
  window.addEventListener('load', () => logEvent('window-load', bodySnapshot()));

  let healthTicks = 0;
  function healthCheck() {
    if (healthTicks >= 30) return; // первые ~30с, дальше не спамим
    healthTicks++;
    logEvent('health', bodySnapshot());
  }

  try {
    main();
  } catch (e) {
    logEvent('FATAL-init', { message: e.message, stack: e.stack });
    console.error(LOG, 'фатальная ошибка при инициализации', e);
  }

  function main() {
    // Видимая плашка "Реклама 18+" в этой рекламной сети намеренно
    // разбита на фрагменты и один кусок перевёрнут задом наперёд ("Реклам"
    // + "алкеР" + "а 18+") — явный анти-детект приём. По корню "реклам"
    // без границ слова ловим все варианты разом.
    const LABEL_RE = /реклам/i;
    // НО: "Скрыть рекламу", "О рекламе", "О Рекламодателе", "Рекламное
    // объявление" — это пункты выпадающего меню, которые React рендерит
    // ЧЕРЕЗ ПОРТАЛ отдельно от самой карточки (проверено вживую — искать
    // от них контейнер бессмысленно и один раз уже чуть не задело список
    // писем целиком при расширенных лимитах). Явно исключаем эти фразы.
    const MENU_TEXT_EXCLUDE_RE = /^(скрыть рекламу|о рекламе|о рекламодателе|рекламное объявление)$/i;
    const processed = new WeakSet();
    const stats = { blocked: 0 };
    const seenHosts = new Set();

    // Стартовый список известных рекламных хостов, подтверждённых из сети
    // (видны напрямую в Network при показе рекламы). Расширяется через
    // попап расширения (options.html) без правки кода.
    const BASE_HOSTS = ['mradx.net', 'ad.mail.ru', 'filin.mail.ru'];
    let extraHosts = [];

    function escapeRegex(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function buildHostRe(hosts) {
      if (!hosts.length) return /(?!)/; // ничего не матчит
      return new RegExp('(^|\\.)(' + hosts.map(escapeRegex).join('|') + ')$', 'i');
    }

    let BAD_HOST_RE = buildHostRe(BASE_HOSTS);

    if (chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ extraDomains: [] }, (res) => {
        extraHosts = (res.extraDomains || []).map((d) => String(d).trim()).filter(Boolean);
        BAD_HOST_RE = buildHostRe(BASE_HOSTS.concat(extraHosts));
        if (extraHosts.length) logEvent('extra-domains-loaded', extraHosts);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.extraDomains) {
          extraHosts = (changes.extraDomains.newValue || []).map((d) => String(d).trim()).filter(Boolean);
          BAD_HOST_RE = buildHostRe(BASE_HOSTS.concat(extraHosts));
          logEvent('extra-domains-updated', extraHosts);
          scan();
        }
      });
    }

    // Защита от чрезмерного скрытия: контейнер крупнее разумного
    // рекламного блока (баннер/карточка) не трогаем, чтобы случайное
    // совпадение не спрятало полезный кусок интерфейса целиком.
    // Раньше поднимал лимит до 1400px/14 ради "строчной" рекламы и словил
    // риск: текст "О Рекламодателе"/"Скрыть рекламу" живёт в ОТДЕЛЬНОМ
    // портале, и climbToContainer находил для него левый крупный
    // контейнер. Эти конкретные фразы теперь исключены отдельно (см.
    // MENU_TEXT_EXCLUDE_RE), поэтому лимит можно снова поднять — но
    // добавляю железную защиту: containsMultipleLetterItems() ниже
    // запрещает считать контейнером что угодно, где внутри 2+ строки
    // письма — это железный признак "это весь список", а не одна карточка.
    // Ширину подняли с 1400 — на широких экранах верхний баннер занимает
    // всю ширину окна (замерено 1578-1580px) и был шире лимита. Баннер
    // тонкий (48px), это в принципе не может быть "весь список писем"
    // (тот всегда высокий), поэтому по ширине можно быть куда щедрее —
    // опасность отсекает высота + containsMultipleLetterItems.
    const MAX_W = 2600;
    const MAX_H = 900;

    // Сама почта помечает СВОИ рекламные блоки в списке классом с суффиксом
    // "-adv" (advertisement) — подтверждено на "letter-list-item-adv".
    // Это авторский признак самого сайта, надёжнее размерной эвристики:
    // в виртуализированном списке реклама иногда рендерится в одной общей
    // обёртке с 2+ настоящими письмами (батчинг), и тогда размерная
    // эвристика в принципе не может её отделить, не рискуя спрятать письма.
    // ВАЖНО: на e.mail.ru (классическая вёрстка, не хэшированные классы,
    // как в workspace) первая версия проверки (просто "-adv"/"_adv" где-то
    // внутри className) случайно зацепила чужой класс и спрятала часть
    // настоящих писем (пустые пропуски в списке вместо строк). Теперь
    // требуем, чтобы "adv" было ОКОНЧАНИЕМ ЦЕЛОГО пробел-разделённого
    // CSS-токена ("letter-list-item-adv" — да, "b-some-advanced" — нет,
    // "foo-adv-bar" — нет, т.к. после adv идёт не пробел/конец токена).
    const ADV_TOKEN_RE = /(^|[-_])adv$/i;

    function hasAdvMarker(className) {
      if (typeof className !== 'string' || !className) return false;
      const tokens = className.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        if (ADV_TOKEN_RE.test(tokens[i])) return true;
      }
      return false;
    }

    function findAdvMarkerAncestor(startEl) {
      // Только дешёвые проверки (className + размер) — без querySelectorAll.
      // Строгое совпадение целого CSS-токена на "-adv" само по себе
      // достаточно надёжно (это авторская метка сайта), а вызов
      // containsMultipleLetterItems() здесь заметно утяжелял каждый
      // scanOne() при массовых DOM-мутациях (см. MAX_BATCH ниже) —
      // именно это, похоже, и подвешивало страницу при первой загрузке.
      //
      // НЕ требуем минимального размера: элемент только что вставлен в DOM
      // и может быть ещё 0×0 (картинка/контент внутри ещё не подгрузились).
      // Если ждать нормального размера — реклама успевает на мгновение
      // мелькнуть на экране до того, как периодический скан её поймает, а
      // каждый показ — это уже засчитанный показ рекламы площадке. Раз это
      // явная авторская метка "это реклама", прячем сразу, не дожидаясь
      // раскладки. Верхнюю границу оставляем — страховка от совсем
      // огромного случайного совпадения.
      let node = startEl;
      let depth = 0;
      while (node && depth < 20) {
        if (isForbiddenRoot(node)) return null;
        if (hasAdvMarker(node.className)) {
          const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          if (!r || (r.width <= MAX_W && r.height <= 1200)) {
            return node;
          }
          return null;
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    }

    function containsMultipleLetterItems(el) {
      if (!el.querySelectorAll) return false;
      // ВАЖНО: считаем только по SAFE_ZONE_CLASS_RE (настоящие НЕ-adv
      // строки писем), а не по сырой подстроке "letter-list-item" —
      // у самой рекламной "строчной" карточки внутри есть BEM-дети вида
      // "letter-list-item-adv__avatar", "letter-list-item-adv__title" и
      // т.п., которые тоже содержат эту подстроку. Сырой substring-запрос
      // считал их за "2+ письма внутри" и ошибочно блокировал climbToContainer
      // для самой рекламы — наша же защита прятала рекламу от удаления.
      const candidates = el.querySelectorAll('[class*="letter-list-item"]');
      let count = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (typeof c.className === 'string' && SAFE_ZONE_CLASS_RE.test(c.className)) {
          count++;
          if (count >= 2) return true;
        }
      }
      return false;
    }

    // Классическая вёрстка e.mail.ru именует элементы ОТКРЫТОГО письма BEM-
    // блоком "letter__..." (двойное подчёркивание), в отличие от строк
    // списка "letter-list-item" (дефис).
    //
    // Реальный случай: у mail.ru свой виджет "нативной рекламы"
    // (рекомендации, r.mradx.net) с текстом "Мы используем ваши ответы,
    // чтобы подбирать для вас подходящую рекламу". Когда его скрипт не
    // загрузился (заблокирован сторонним блокировщиком — НЕ нами, мы
    // никогда не блокируем сеть), собственный код mail.ru
    // (t.handlePlacementFail) перерисовывает fallback-разметку этого
    // виджета. climbToContainer поднимался по её тексту "Реклама" и прятал
    // ближайший подходящий по размеру контейнер — но этот контейнер
    // оказался ОБЩИМ родителем и для виджета, и для панели открытого
    // письма (общая колонка вёрстки). В результате прятался не только
    // виджет, а вся панель письма целиком — то же самое, что раньше
    // случилось с <body> из-за vkAuth.html (см. isForbiddenRoot), только
    // на уровень ниже. Отдельной проверки "текст внутри letter__" (см.
    // inSafeZone) здесь недостаточно: опасный текст был СНАРУЖИ письма, а
    // не внутри него.
    //
    // Поэтому запрещаем считать контейнером-обёрткой любой элемент, который
    // сам СОДЕРЖИТ открытое письмо как потомка — по тому же принципу, что и
    // containsMultipleLetterItems() для списка: если внутри найденного
    // "рекламного" контейнера прячется письмо целиком, это не рекламная
    // карточка, а общий layout-контейнер, который нельзя трогать.
    const LETTER_VIEW_SELECTOR = '[class*="letter__"]';

    function containsLetterView(el) {
      return !!(el.querySelectorAll && el.querySelector(LETTER_VIEW_SELECTOR));
    }

    // ЖЁСТКИЙ, БЕЗУСЛОВНЫЙ запрет: никогда не считаем <body>/<html>/<head>
    // валидным "рекламным контейнером", независимо от размера. Реальный
    // случай: iframe авторизации VK ID (vkAuth.html) отдаётся с домена
    // ad.mail.ru наравне с настоящей рекламой — при не найденном маленьком
    // контейнере climbToContainer поднимался до <BODY> (он вполне попадал
    // в лимиты MAX_W/MAX_H по размеру вьюпорта) и прятал ВСЮ страницу
    // целиком. После этого у всех остальных элементов getBoundingClientRect
    // тоже возвращал 0×0 (раз предок скрыт), что маскировало сам баг под
    // видом "текст стены не находит контейнер". Проверяется на каждом шаге
    // подъёма и отдельно ещё раз в hide() — второй эшелон защиты.
    function isForbiddenRoot(el) {
      return el === document.body || el === document.documentElement || el === document.head;
    }

    let lastClimbFailReason = null;

    function climbToContainer(startEl) {
      // Раньше требовался вложенный <img>/<svg>/<iframe> — но у некоторых
      // карточек ВСЯ картинка задана через CSS background-image, внутри
      // нет ни одного такого тега вообще (проверено вживую: 28 элементов,
      // ни одного img/svg). Поэтому просто поднимаемся до первого предка
      // разумного "карточного" размера, не требуя конкретных тегов внутри.
      // Контейнер крупнее одной рекламной карточки не трогаем — попытка
      // "подняться выше до стабильного слота" один раз уже случайно
      // спрятала весь блок письма целиком (белый экран), это того не стоит.
      const advHit = findAdvMarkerAncestor(startEl);
      if (advHit) return advHit;

      let el = startEl;
      let depth = 0;
      lastClimbFailReason = 'no-sized-ancestor';
      while (el && depth < 14) {
        if (isForbiddenRoot(el)) {
          lastClimbFailReason = 'hit-forbidden-root';
          break;
        }
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r && r.width >= 60 && r.height >= 40 && r.width <= MAX_W && r.height <= MAX_H) {
          if (containsMultipleLetterItems(el)) {
            // Похоже на список писем целиком, а не на рекламную карточку —
            // пропускаем этого кандидата и продолжаем подниматься... но
            // выше будет только крупнее, так что просто отказываемся.
            lastClimbFailReason = 'multi-letter-items-blocked:' + el.tagName + '.' + String(el.className).slice(0, 40);
            return null;
          }
          if (containsLetterView(el)) {
            // Контейнер оборачивает открытое письмо целиком (см. комментарий
            // у containsLetterView) — реальный случай в узком окне PWA
            // ("Установить страницу как приложение"): тот же контейнер по
            // размеру подходил под лимиты и вмещал одновременно виджет
            // "рекомендаций" mail.ru и панель письма, из-за чего вместе с
            // виджетом пряталось и само письмо.
            lastClimbFailReason = 'contains-letter-view:' + el.tagName + '.' + String(el.className).slice(0, 40);
            return null;
          }
          return el;
        }
        if (r && (r.width > MAX_W || r.height > MAX_H)) {
          lastClimbFailReason = 'too-large:' + Math.round(r.width) + 'x' + Math.round(r.height);
          break; // дальше только крупнее — останавливаемся
        }
        el = el.parentElement;
        depth++;
      }
      return null;
    }

    function findAdContainer(textNode) {
      return climbToContainer(textNode.parentElement);
    }

    function hide(el, reason) {
      if (!el) return;
      // Второй, независимый эшелон защиты — даже если какой-то из путей
      // выше по ошибке передаст сюда <body>/<html>/<head> (см. isForbiddenRoot),
      // здесь это финальная точка перед реальным display:none. Именно
      // отсутствие такой проверки привело к тому, что ошибочное совпадение
      // по домену ad.mail.ru (на самом деле — легитимный iframe авторизации
      // VK ID vkAuth.html) один раз спрятало всю страницу e.mail.ru целиком.
      if (isForbiddenRoot(el)) {
        logEvent('hide-refused-forbidden-root', { reason, tag: el.tagName });
        return;
      }
      const already = processed.has(el);
      // Стиль применяем ВСЕГДА (идемпотентно), даже если уже обрабатывали
      // этот элемент раньше — приложение может переписать атрибут style
      // при ротации баннера и случайно стереть наш display:none.
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.setAttribute('data-vkads-blocked', '1');
      if (already) return;
      processed.add(el);
      stats.blocked++;
      logEvent('hidden', { reason, tag: el.tagName, cls: el.className || null });
    }

    function skipScriptStyle(node) {
      const p = node.parentElement;
      return p && (p.closest('script,style')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }

    // ВАЖНО: на страницах с текстом, для которого climbToContainer НИКОГДА
    // не находит контейнер (например, собственная антиблокировочная плашка
    // e.mail.ru — там таких текстовых узлов бывает сразу несколько), мы
    // раньше повторяли ПОЛНЫЙ дорогой подъём по предкам (14-20 уровней,
    // каждый уровень — getBoundingClientRect, форсирующий синхронный
    // пересчёт раскладки) заново КАЖДУЮ секунду, бесконечно. На реальной
    // странице это давало заметный "long task", конкурирующий за поток с
    // загрузкой самой страницы — похоже, именно это и рушило e.mail.ru
    // (проверено: с заглушкой вместо сканирования всё грузится нормально).
    // Запоминаем неудачные попытки, но НЕ отказываемся навсегда после
    // первого же промаха — свежевставленный узел ещё может быть не
    // размечен/не размер (класс "-adv" вешается чуть позже, картинка ещё
    // не загрузилась), и полный отказ после 1 попытки ломал мгновенную
    // поимку рекламы (реклама успевала мелькнуть, пока не ловилась другим
    // путём). Даём несколько попыток подряд, и только потом перестаём
    // тратить время на явно безнадёжный текст (вроде чужой антиблок-плашки
    // e.mail.ru, которая никогда не найдёт себе контейнер).
    const failedLabelNodes = new WeakMap();
    const MAX_LABEL_RETRIES = 5;

    function scanForLabels(root) {
      if (!root || root.nodeType === Node.TEXT_NODE) return;
      // Пропускаем текст внутри <script>/<style> — там слово "реклам"
      // может встретиться просто как часть кода/комментария/конфига,
      // а не как настоящая видимая метка.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: skipScriptStyle });
      let node;
      while ((node = walker.nextNode())) {
        const failCount = failedLabelNodes.get(node) || 0;
        if (failCount >= MAX_LABEL_RETRIES) continue;
        const t = node.nodeValue;
        if (t && LABEL_RE.test(t) && !MENU_TEXT_EXCLUDE_RE.test(t.trim())) {
          const container = findAdContainer(node);
          if (!container) {
            logEvent('label-no-container', { text: t.trim(), reason: lastClimbFailReason });
            failedLabelNodes.set(node, failCount + 1);
          } else if (!processed.has(container)) {
            const safe = inSafeZone(container);
            if (safe) {
              logEvent('skip-safe-zone', { kind: 'text', text: t.trim(), matchedClass: safe.matched, depth: safe.depth });
            } else {
              hide(container, 'текст "Реклама" (' + JSON.stringify(t.trim()) + ')');
            }
          }
        }
      }
    }

    // filin.mail.ru отдаёт и аватарки отправителей (?from=ph&width=45&
    // height=45...), и рекламные картинки (?d=...) — с одного домена.
    // Аватарки нельзя трогать, иначе прячем настоящие письма в списке.
    const AVATAR_URL_RE = /[?&]from=ph\b/i;
    // ad.mail.ru отдаёт не только рекламу, но и легитимный iframe
    // авторизации VK ID (.../dist/vkAuth.html) — реальный случай, из-за
    // которого climbToContainer однажды поднялся до <body> и спрятал всю
    // страницу (см. isForbiddenRoot). Явно не считаем такие пути рекламой.
    const AUTH_PATH_EXCLUDE_RE = /\/(vkauth|oauth|auth)[a-z0-9_-]*\.html\b/i;
    // Дополнительная защита: если совпадение по домену случилось внутри
    // строки ПИСЬМА в списке — пропускаем, даже если домен формально
    // рекламный (это реальный кейс: аватар отправителя в letter-list-item
    // чуть не попал под раздачу). Специально НЕ включаем сюда общие
    // "avatar"/"correspondent" — из-за них перестала прятаться и настоящая
    // реклама (её собственная иконка/аватар-компонент совпадал по классу).
    //
    // ВАЖНО: сама почта помечает рекламные строки в списке классом
    // "letter-list-item-adv" (adv = advertisement) — это ПОДСТРОКА
    // "letter-list-item", поэтому без исключения (?!-adv) эта защита сама
    // прятала рекламу от удаления, приняв её за настоящее письмо. Именно
    // это и была та самая неуловимая "строчная" реклама.
    const SAFE_ZONE_CLASS_RE = /letter[-_]?list[-_]?item(?!-adv)\b/i;

    // LETTER_VIEW_SELECTOR объявлен выше, рядом с containsLetterView() —
    // тот же реальный случай (открытое письмо, которое само по себе
    // содержит обязательную по ФЗ-38 плашку "Реклама", и текст внутри него
    // не должен восприниматься как реклама сайта). closest() здесь идёт
    // вверх без ограничения по глубине (в отличие от ручного цикла ниже) —
    // тело письма в вёрстке почтовых HTML-писем может быть вложено глубже
    // 12 уровней.
    function inSafeZone(el) {
      if (el && el.closest) {
        const letterEl = el.closest(LETTER_VIEW_SELECTOR);
        if (letterEl) return { matched: 'letter__*', cls: letterEl.className, depth: -1 };
      }
      let node = el;
      let depth = 0;
      while (node && depth < 12) {
        if (typeof node.className === 'string') {
          const m = SAFE_ZONE_CLASS_RE.exec(node.className);
          if (m) return { matched: m[0], cls: node.className, depth };
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    }

    // Та же экономия, что и для failedLabelNodes: если по этому конкретному
    // элементу (тег ad.mail.ru и т.п.) с ЭТИМ ЖЕ src уже выяснили "слишком
    // маленький, прятать нечего" — не гоняем climbToContainer заново каждую
    // секунду. Кэш по паре (элемент, url) — если src потом поменяется
    // (баннер догрузился/сменился), проверим заново.
    const skipHostCheck = new WeakMap();

    function checkHost(url, kind, el) {
      if (el && skipHostCheck.get(el) === url) return;
      let host = '';
      try {
        host = new URL(url, location.href).hostname;
      } catch (e) {
        return;
      }
      if (!seenHosts.has(host)) {
        seenHosts.add(host);
        logEvent('seen-host', { kind, host, src: url });
      }
      if (AVATAR_URL_RE.test(url)) return;
      if (AUTH_PATH_EXCLUDE_RE.test(url)) return;
      if (BAD_HOST_RE.test(host)) {
        const safe = inSafeZone(el);
        if (safe) {
          logEvent('skip-safe-zone', { host, kind, src: url, matchedClass: safe.matched, elClass: safe.cls, depth: safe.depth });
          return;
        }
        let container = climbToContainer(el);
        if (!container) {
          // Нет подходящего контейнера-обёртки — прячем сам элемент, но
          // только если он не крошечный (иначе рискуем задеть, например,
          // маленькую аватарку с того же CDN, что и реклама).
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (r && r.width >= 60 && r.height >= 40) container = el;
        }
        if (container) {
          hide(container, 'домен ' + host + ' (' + kind + ')');
        } else {
          logEvent('host-match-too-small', { host, kind });
          if (el) skipHostCheck.set(el, url);
        }
      }
    }

    function scanElements(root, selector, kind) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll(selector).forEach((f) => checkHost(f.src, kind, f));
    }

    const BG_URL_RE = /url\((['"]?)(.*?)\1\)/i;
    function scanBackgrounds(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('[style*="url("]').forEach((el) => {
        const m = BG_URL_RE.exec(el.getAttribute('style') || '');
        if (m && m[2]) checkHost(m[2], 'background-image', el);
      });
    }

    function scanLazyAttrs(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('img[data-src], img[data-original], img[data-lazy-src], source[srcset]').forEach((el) => {
        const val = el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || (el.getAttribute('srcset') || '').split(/\s+/)[0];
        if (val) checkHost(val, 'lazy-img', el);
      });
    }

    // Некоторые баннеры задают картинку не через <img>/inline-style, а
    // через CSS-правило в <style> (селектор → background-image). Обычный
    // обход DOM это не видит вообще — приходится читать сами правила
    // через CSSOM. Найденный элемент часто маленький (например, кнопка
    // закрытия 24×24 поверх карточки) — тогда поднимаемся к ближайшему
    // предку размера рекламной карточки и прячем его.
    const STYLE_URL_RE = /url\(["']?(https?:\/\/[^"')]+)["']?\)/i;

    function findCardAncestor(el) {
      // Мин. высота была 100px — верхний широкий баннер всего 48-60px
      // высотой и никогда не проходил эту проверку. Используем тот же
      // порог, что и climbToContainer (40), чтобы не пропускать короткие
      // широкие баннеры.
      const advHit = findAdvMarkerAncestor(el);
      if (advHit) return advHit;

      let node = el;
      let depth = 0;
      while (node && depth < 10) {
        if (isForbiddenRoot(node)) return null;
        const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        if (r && r.width >= 60 && r.width <= MAX_W && r.height >= 40 && r.height <= MAX_H) {
          return containsMultipleLetterItems(node) || containsLetterView(node) ? null : node;
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    }

    // Тот же принцип экономии, что у failedLabelNodes/skipHostCheck: если
    // для этого элемента уже не нашли подходящую карточку-обёртку — не
    // повторяем дорогой findCardAncestor() каждую секунду для того же узла.
    // Ограниченное число попыток, а не отказ навсегда — см. комментарий у
    // failedLabelNodes (элемент мог быть ещё не размечен/не размера).
    const skipCssCheck = new WeakMap();
    const MAX_CSS_RETRIES = 5;

    function scanStyleRules() {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (e) {
          continue; // кросс-доменный стиль, недоступен — пропускаем
        }
        if (!rules) continue;
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          if (!rule.style) continue;
          const bg = rule.style.backgroundImage;
          if (!bg || bg === 'none') continue;
          const m = STYLE_URL_RE.exec(bg);
          if (!m) continue;
          if (AVATAR_URL_RE.test(m[1])) continue;
          let host;
          try {
            host = new URL(m[1]).hostname;
          } catch (e) {
            continue;
          }
          if (!seenHosts.has(host)) {
            seenHosts.add(host);
            logEvent('seen-host', { kind: 'css-bg', host, src: m[1] });
          }
          if (!BAD_HOST_RE.test(host)) continue;
          let els;
          try {
            els = document.querySelectorAll(rule.selectorText);
          } catch (e) {
            continue;
          }
          els.forEach((el) => {
            if (processed.has(el)) return;
            const failCount = skipCssCheck.get(el) || 0;
            if (failCount >= MAX_CSS_RETRIES) return;
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            const selfFits = r && r.width >= 60 && r.width <= MAX_W && r.height >= 40 && r.height <= MAX_H;
            let target = selfFits && !containsMultipleLetterItems(el) ? el : findCardAncestor(el);
            if (!target) {
              logEvent('css-rule-no-card', { host, selector: rule.selectorText });
              skipCssCheck.set(el, failCount + 1);
              return;
            }
            if (inSafeZone(target)) {
              logEvent('skip-safe-zone', { host, kind: 'css-bg', selector: rule.selectorText });
              return;
            }
            hide(target, 'CSS-фон домен ' + host);
          });
        }
      }
    }

    function scan() {
      scanForLabels(document.body);
      scanElements(document, 'iframe[src]', 'iframe');
      scanElements(document, 'img[src]', 'img');
      scanBackgrounds(document);
      scanLazyAttrs(document);
      scanStyleRules();
      healthCheck();
    }

    function scanOne(el) {
      if (!el || el.nodeType !== 1) return;
      scanForLabels(el);
      if (el.matches && el.matches('iframe[src]')) checkHost(el.src, 'iframe', el);
      if (el.matches && el.matches('img[src]')) checkHost(el.src, 'img', el);
      scanElements(el, 'iframe[src]', 'iframe');
      scanElements(el, 'img[src]', 'img');
      scanBackgrounds(el);
      if (el.matches && el.matches('[style*="url("]')) {
        const m = BG_URL_RE.exec(el.getAttribute('style') || '');
        if (m && m[2]) checkHost(m[2], 'background-image', el);
      }
      scanLazyAttrs(el);
    }

    // ВАЖНО: раньше scanOne() вызывался СИНХРОННО прямо внутри колбэка
    // MutationObserver для каждого узла каждой пачки мутаций. На страницах,
    // которые при первой загрузке вставляют DOM большими сериями (похоже,
    // так делает классическая вёрстка e.mail.ru — расширение включено =
    // страница виснет/не грузится, выключено = грузится нормально), это
    // блокировало основной поток надолго: расширение выполняется в ТОМ ЖЕ
    // потоке, что и сама страница, изоляция только по переменным/объектам.
    // Теперь копим узлы в очередь и разбираем её пачками через setTimeout —
    // это отдаёт управление браузеру между всплесками мутаций вместо одного
    // гигантского синхронного прохода.
    let pendingNodes = new Set();
    let pendingAttrTargets = new Set();
    let processScheduled = false;
    const MAX_BATCH = 200;

    function processPending() {
      processScheduled = false;
      const nodes = Array.from(pendingNodes);
      const attrs = Array.from(pendingAttrTargets);
      pendingNodes = new Set();
      pendingAttrTargets = new Set();
      const batch = nodes.concat(attrs).slice(0, MAX_BATCH);
      batch.forEach((n) => scanOne(n));
      if (nodes.length + attrs.length > MAX_BATCH) {
        // Остаток не влез в эту пачку — обычный периодический scan() раз в
        // секунду всё равно досмотрит весь документ целиком.
      }
    }

    function schedulePending() {
      if (processScheduled) return;
      processScheduled = true;
      setTimeout(processPending, 30);
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => pendingNodes.add(n));
        } else if (m.type === 'attributes') {
          pendingAttrTargets.add(m.target);
        }
      }
      schedulePending();
    });

    // ВАЖНО: полный scan() — это TreeWalker по всему документу плюс много
    // getBoundingClientRect() (climbToContainer), а каждый такой вызов
    // форсирует синхронный пересчёт раскладки браузера. Раньше первый
    // scan() запускался СРАЗУ, синхронно, в самый критический момент
    // первой отрисовки страницы — и, похоже, именно это конкурировало за
    // поток с загрузкой рекламы на e.mail.ru и не давало ей загрузиться
    // вовремя (сайт решал, что сработал блокировщик, и показывал стену
    // "отключите блокировщик рекламы", хотя мы физически ничего не прятали
    // — проверено диагностической заглушкой: без сканирования всё грузится
    // нормально). Переносим scan() на "свободное время" браузера через
    // requestIdleCallback, чтобы не соревноваться за поток с критической
    // начальной отрисовкой/загрузкой самой страницы.
    function idleRun(fn, timeout) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fn, { timeout: timeout || 500 });
      } else {
        setTimeout(fn, 0);
      }
    }

    function start() {
      logEvent('scan-start', bodySnapshot());
      // Наблюдатель включаем сразу — чтобы не пропустить новые узлы, пока
      // первый scan() ждёт своей очереди. Найденное будет обработано
      // пачками через processPending() (см. выше), тоже не блокируя поток.
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'],
      });
      idleRun(scan, 500);
      setInterval(() => idleRun(scan, 800), 1000);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }

    window.__vkAdsBlocker = {
      stats: () => ({ blocked: stats.blocked, seenHosts: Array.from(seenHosts) }),
      dumpLog: () => logBuffer.slice(),
      printLog: () => console.table(logBuffer.map((e) => ({ t: e.t, tag: e.tag, data: JSON.stringify(e.data) }))),
    };
  }
})();
