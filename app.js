/* Отбор диджеев: форма кандидата и оценка преподавателями.
 *
 * Всё общение с базой идёт через функции Supabase, а не через таблицы:
 * страница статическая, ключ anon виден любому, и прямой доступ к данным
 * по нему закрыт. Проверку кода судьи делает база, а не браузер - иначе
 * её можно было бы обойти, открыв инструменты разработчика.
 */
(function () {
  'use strict';

  var cfg = window.CASTING_CONFIG || {};
  var API = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  var KEY = cfg.supabaseAnonKey || '';
  var CODE_STORAGE = 'casting.judge.code';

  var state = {
    form: null,        // данные заявки, пока подтверждаем почту
    token: null,       // токен после подтверждения почты
    code: '',          // код судьи
    board: null,       // что показываем на доске
    selected: {},      // отмеченные кандидаты для общей заметки
    open: {}           // раскрытые карточки
  };

  // ------------------------------------------------------------ утилиты

  function el(id) { return document.getElementById(id); }

  function show(view) {
    ['view-form', 'view-closed', 'view-code', 'view-done', 'view-login', 'view-board'].forEach(function (id) {
      el(id).hidden = id !== view;
    });
    window.scrollTo(0, 0);
  }

  function say(node, text, kind) {
    node.textContent = text || '';
    node.hidden = !text;
    node.className = 'message ' + (kind || 'error');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Заполнен ли config.js. Проверяем незаполненную заготовку, а не адрес
   *  supabase.co: адрес проекта может быть и на своём домене. */
  function configured() {
    return /^https?:\/\/.+/.test(API) &&
      API.indexOf('ВСТАВЬТЕ') === -1 &&
      KEY.length > 20 &&
      KEY.indexOf('ВСТАВЬТЕ') === -1;
  }

  /** Понятный текст вместо технической ошибки. */
  function readError(payload, status) {
    var text = payload && (payload.message || payload.error_description || payload.error || payload.msg);
    if (typeof text === 'string' && text.trim()) {
      return text;
    }
    if (status === 429) {
      return 'Слишком много попыток. Подождите минуту и попробуйте снова.';
    }
    if (status >= 500) {
      return 'Сервис временно недоступен. Попробуйте позже.';
    }
    return 'Не получилось выполнить запрос (' + status + ')';
  }

  function request(path, body, token) {
    return fetch(API + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: 'Bearer ' + (token || KEY)
      },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.text().then(function (raw) {
        var payload = null;
        try { payload = raw ? JSON.parse(raw) : null; } catch (e) { payload = null; }
        if (!response.ok) {
          throw new Error(readError(payload, response.status));
        }
        return payload;
      });
    }, function () {
      throw new Error('Нет связи с сервисом. Проверьте интернет.');
    });
  }

  function rpc(name, args, token) {
    return request('/rest/v1/rpc/' + name, args || {}, token);
  }

  // -------------------------------------------------------- форма заявки

  function collectForm() {
    var form = el('application-form');
    var data = {};
    ['full_name', 'isu_number', 'email', 'phone', 'vk_url', 'telegram_url',
     'motivation', 'background', 'expectations', 'source', 'goal'].forEach(function (name) {
      data[name] = (form.elements[name].value || '').trim();
    });
    data.consent = form.elements.consent.checked ? 'true' : 'false';
    data.consent_policy_url = cfg.policyUrl || '';
    return data;
  }

  function validateForm(data) {
    if (data.consent !== 'true') {
      return 'Без согласия на обработку персональных данных заявку принять нельзя';
    }
    if (data.full_name.length < 3) {
      return 'Укажите фамилию и имя';
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(data.email)) {
      return 'Проверьте адрес почты';
    }
    var digits = data.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return 'Укажите телефон полностью, с кодом страны';
    }
    if (data.motivation.length < 10) {
      return 'Расскажите о мотивации чуть подробнее';
    }
    if (data.isu_number && !/^\d{4,20}$/.test(data.isu_number)) {
      return 'Номер ИСУ состоит только из цифр';
    }
    return '';
  }

  function sendCode(email) {
    return request('/auth/v1/otp', { email: email, create_user: true });
  }

  function saveApplication(token) {
    return rpc('submit_application', { payload: state.form }, token);
  }

  function finish(verified) {
    el('done-text').textContent = verified
      ? 'Почта подтверждена, заявка ушла преподавателям.'
      : 'Заявка сохранена. Почта осталась неподтверждённой - мы свяжемся с вами, чтобы её проверить.';
    show('view-done');
  }

  el('application-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = el('form-error');
    say(error, '');

    if (!configured()) {
      say(error, 'Сервис ещё не настроен: не заполнен файл config.js');
      return;
    }

    var data = collectForm();
    var problem = validateForm(data);
    if (problem) {
      say(error, problem);
      return;
    }

    state.form = data;
    var button = el('submit-btn');
    button.disabled = true;
    button.textContent = 'Отправляем код...';

    sendCode(data.email).then(function () {
      el('code-email').textContent = data.email;
      show('view-code');
      // Кнопку "код не пришёл" показываем не сразу: иначе ей пользуются
      // вместо ожидания письма, и почта остаётся непроверенной
      window.setTimeout(function () { el('skip-btn').hidden = false; }, 45000);
    }, function (err) {
      // Письмо не ушло - не теряем кандидата, даём отправить заявку как есть
      say(error, err.message + ' Можно отправить заявку без подтверждения почты.');
      el('code-email').textContent = data.email;
      show('view-code');
      say(el('code-error'), err.message);
      el('skip-btn').hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Отправить заявку';
    });
  });

  el('code-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = el('code-error');
    say(error, '');

    var token = (el('code-form').elements.token.value || '').replace(/\s/g, '');
    if (!token) {
      say(error, 'Введите код из письма');
      return;
    }

    var button = el('code-btn');
    button.disabled = true;
    button.textContent = 'Проверяем...';

    request('/auth/v1/verify', {
      email: state.form.email,
      token: token,
      type: 'email'
    }).then(function (result) {
      state.token = result && result.access_token;
      return saveApplication(state.token);
    }).then(function () {
      finish(true);
    }, function (err) {
      say(error, err.message);
      el('skip-btn').hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Подтвердить и отправить заявку';
    });
  });

  el('resend-btn').addEventListener('click', function () {
    say(el('code-error'), '');
    sendCode(state.form.email).then(function () {
      say(el('code-error'), 'Код отправлен снова. Посмотрите и в папке со спамом.', 'ok');
    }, function (err) {
      say(el('code-error'), err.message);
      el('skip-btn').hidden = false;
    });
  });

  el('skip-btn').addEventListener('click', function () {
    var button = el('skip-btn');
    button.disabled = true;
    saveApplication(null).then(function () {
      finish(false);
    }, function (err) {
      say(el('code-error'), err.message);
      button.disabled = false;
    });
  });

  // --------------------------------------------------------- доска судьи

  function voteCounts(app) {
    var up = 0;
    var down = 0;
    Object.keys(app.votes || {}).forEach(function (key) {
      if (app.votes[key] === 'up') { up += 1; } else if (app.votes[key] === 'down') { down += 1; }
    });
    return { up: up, down: down };
  }

  function statusLabel(app) {
    if (app.status === 'accepted') { return 'Принят'; }
    if (app.status === 'rejected') { return 'Отказ'; }
    return 'На рассмотрении';
  }

  /** Цветная полоска слева у карточки.
   *
   *  У руководства - по перевесу голосов, у преподавателя - по его
   *  собственному голосу: чужих он не видит, и подсказывать ими нельзя.
   */
  function leaning(app, board) {
    if (app.status === 'accepted') { return 'accepted'; }
    if (app.status === 'rejected') { return 'rejected'; }
    if (board.me.role !== 'management') {
      return (app.votes || {})[String(board.me.id)] || 'tie';
    }
    var counts = voteCounts(app);
    if (counts.up > counts.down) { return 'up'; }
    if (counts.down > counts.up) { return 'down'; }
    return 'tie';
  }

  function judgeName(id) {
    var found = (state.board.judges || []).filter(function (judge) { return String(judge.id) === String(id); })[0];
    return found ? found.name : 'Судья ' + id;
  }

  /** Ссылка на профиль из того, что человек ввёл в поле.
   *
   *  Пишут по-разному: полным адресом, без протокола, просто ником, через @.
   *  Без протокола браузер считает адрес путём внутри сайта и уводит на
   *  casting.mb-dj.ru/vk.com/... - поэтому достраиваем сами.
   *
   *  Заодно это отсекает javascript: и прочие схемы: наружу уходит только
   *  то, что мы сами собрали или что начинается с http(s).
   */
  function profileUrl(value, base) {
    var raw = String(value == null ? '' : value).trim().replace(/^@+/, '@');
    if (!raw) { return ''; }
    if (/^https?:\/\//i.test(raw)) { return raw; }
    if (raw.charAt(0) === '@') { return base + raw.slice(1); }

    var bare = raw.replace(/^\/+/, '').replace(/^www\./i, '');
    if (/^(vk\.com|m\.vk\.com|t\.me|telegram\.me)\//i.test(bare)) {
      return 'https://' + bare;
    }
    if (/^[\w-]+(\.[\w-]+)+\//.test(bare)) {      // любой другой домен с путём
      return 'https://' + bare;
    }
    if (/^[A-Za-z0-9_.]{2,64}$/.test(bare)) {     // просто ник
      return base + bare;
    }
    return '';
  }

  function answerBlock(title, text) {
    if (!text) { return ''; }
    return '<div class="answer"><h4>' + escapeHtml(title) + '</h4><p>' + escapeHtml(text) + '</p></div>';
  }

  function renderBoard() {
    var board = state.board;
    var isManagement = board.me.role === 'management';
    el('board-me').textContent = board.me.name + (isManagement ? ' · руководство' : ' · преподаватель');

    var intake = board.intake || { open: true, message: '' };
    var pill = el('intake-pill');
    pill.textContent = intake.open ? 'Приём открыт' : 'Приём закрыт';
    pill.className = 'intake-pill ' + (intake.open ? 'on' : 'off');

    var intakeBtn = el('intake-btn');
    intakeBtn.hidden = !isManagement;
    intakeBtn.textContent = intake.open ? 'Закрыть приём' : 'Открыть приём';
    el('intake-row').hidden = !isManagement;

    // Доска сама обновляется каждые 25 секунд: если в этот момент в поле
    // что-то печатают, подставлять туда значение из базы нельзя
    if (document.activeElement !== el('intake-message')) {
      el('intake-message').value = intake.message || '';
    }

    var total = board.applications.length;
    var decided = board.applications.filter(function (a) { return a.status !== 'new'; }).length;
    var mine = board.applications.filter(function (a) { return (a.votes || {})[String(board.me.id)]; }).length;
    var unverified = board.applications.filter(function (a) { return !a.email_verified; }).length;

    el('board-summary').innerHTML = [
      '<div class="tile"><span>Заявок</span><strong>' + total + '</strong></div>',
      '<div class="tile"><span>Вы оценили</span><strong>' + mine + ' из ' + total + '</strong></div>',
      '<div class="tile"><span>Решено</span><strong>' + decided + '</strong></div>',
      unverified
        ? '<div class="tile warn"><span>Почта не подтверждена</span><strong>' + unverified + '</strong></div>'
        : ''
    ].join('');

    if (!total) {
      el('board-list').innerHTML = '<p class="empty">Заявок пока нет. Страница обновляется сама.</p>';
      return;
    }

    el('board-list').innerHTML = board.applications.map(function (app) {
      var counts = voteCounts(app);
      var myVote = (app.votes || {})[String(board.me.id)] || '';
      var isOpen = Boolean(state.open[app.id]);

      // Кто как проголосовал - только руководству
      var chips = isManagement
        ? (board.judges || []).map(function (judge) {
            var vote = (app.votes || {})[String(judge.id)];
            if (!vote) { return ''; }
            return '<span class="chip ' + vote + '">' + (vote === 'up' ? '👍' : '👎') + ' ' +
              escapeHtml(judge.name) + '</span>';
          }).join('')
        : '';

      // Счёт голосов тоже: преподаватель видит только свой выбор
      var scoreBox = isManagement
        ? '<div class="score"><b>' + counts.up + '</b> : <b>' + counts.down + '</b></div>'
        : '<div class="score mine">' +
            (myVote === 'up' ? '👍 ваш голос' : myVote === 'down' ? '👎 ваш голос' : 'вы не голосовали') +
          '</div>';

      var contacts = isManagement && app.email
        ? '<p class="contacts">' + escapeHtml(app.email) + ' · ' + escapeHtml(app.phone || '') + '</p>'
        : '';

      var vk = profileUrl(app.vk_url, 'https://vk.com/');
      var tg = profileUrl(app.telegram_url, 'https://t.me/');

      var links = [
        vk ? '<a href="' + escapeHtml(vk) + '" target="_blank" rel="noreferrer">VK</a>' : '',
        tg ? '<a href="' + escapeHtml(tg) + '" target="_blank" rel="noreferrer">Telegram</a>' : '',
        // ввели что-то нечитаемое - показываем как текст, чтобы не потерять
        !vk && app.vk_url ? '<span>VK: ' + escapeHtml(app.vk_url) + '</span>' : '',
        !tg && app.telegram_url ? '<span>TG: ' + escapeHtml(app.telegram_url) + '</span>' : '',
        app.isu_number ? '<span>ИСУ ' + escapeHtml(app.isu_number) + '</span>' : ''
      ].filter(Boolean).join(' · ');

      var decision = isManagement
        ? '<div class="decision">' +
            '<input class="decision-comment" data-id="' + app.id + '" placeholder="Вывод по кандидату" value="' +
              escapeHtml(app.decision_comment || '') + '">' +
            '<div class="decision-buttons">' +
              '<button type="button" class="accept" data-decide="accepted" data-id="' + app.id + '">Принять</button>' +
              '<button type="button" class="reject" data-decide="rejected" data-id="' + app.id + '">Отказать</button>' +
              (app.status !== 'new'
                ? '<button type="button" class="ghost" data-decide="new" data-id="' + app.id + '">Вернуть в рассмотрение</button>'
                : '') +
            '</div>' +
          '</div>'
        : (app.decision_comment
            ? '<p class="verdict">Вывод: ' + escapeHtml(app.decision_comment) + '</p>'
            : '');

      return '' +
        '<article class="app ' + leaning(app, board) + '">' +
          '<div class="app-head">' +
            (isManagement
              ? '<input type="checkbox" class="pick" data-id="' + app.id + '"' +
                (state.selected[app.id] ? ' checked' : '') + ' aria-label="Выбрать кандидата">'
              : '') +
            '<div class="app-title">' +
              '<h3>' + escapeHtml(app.full_name) + '</h3>' +
              '<p class="meta">' +
                '<span class="status ' + app.status + '">' + statusLabel(app) + '</span>' +
                (app.email_verified ? '' : '<span class="status unverified">почта не подтверждена</span>') +
                (links ? '<span class="links">' + links + '</span>' : '') +
              '</p>' +
            '</div>' +
            scoreBox +
          '</div>' +

          contacts +

          '<div class="vote-row">' +
            '<button type="button" class="vote up' + (myVote === 'up' ? ' on' : '') + '" data-vote="up" data-id="' + app.id + '">👍 За</button>' +
            '<button type="button" class="vote down' + (myVote === 'down' ? ' on' : '') + '" data-vote="down" data-id="' + app.id + '">👎 Против</button>' +
            (myVote ? '<button type="button" class="link-btn" data-vote="" data-id="' + app.id + '">снять голос</button>' : '') +
          '</div>' +

          (chips ? '<div class="chips">' + chips + '</div>' : '') +

          (app.group_note ? '<p class="note-line">Заметка: ' + escapeHtml(app.group_note) + '</p>' : '') +

          '<button type="button" class="link-btn toggle" data-toggle="' + app.id + '">' +
            (isOpen ? 'Свернуть анкету' : 'Показать анкету') +
          '</button>' +

          (isOpen
            ? '<div class="answers">' +
                answerBlock('Почему хочет научиться', app.motivation) +
                answerBlock('Музыкальный бэкграунд', app.background) +
                answerBlock('Ожидания от школы', app.expectations) +
                answerBlock('Финальная цель', app.goal) +
                answerBlock('Откуда узнал', app.source) +
              '</div>'
            : '') +

          decision +
        '</article>';
    }).join('');

    renderBulk();
  }

  function renderBulk() {
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    var panel = el('bulk-panel');
    panel.hidden = ids.length === 0;
    el('bulk-count').textContent = 'Выбрано: ' + ids.length;
  }

  function load(silent) {
    return rpc('judge_board', { p_code: state.code }).then(function (board) {
      state.board = board;
      renderBoard();
      if (!silent) { say(el('board-error'), ''); }
    }, function (err) {
      if (!silent) { say(el('board-error'), err.message); }
      throw err;
    });
  }

  function act(name, args, successText) {
    say(el('board-error'), '');
    say(el('board-notice'), '');
    args.p_code = state.code;
    return rpc(name, args).then(function (board) {
      state.board = board;
      renderBoard();
      if (successText) { say(el('board-notice'), successText, 'ok'); }
    }, function (err) {
      say(el('board-error'), err.message);
    });
  }

  el('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var error = el('login-error');
    say(error, '');

    if (!configured()) {
      say(error, 'Сервис ещё не настроен: не заполнен файл config.js');
      return;
    }

    var code = (el('login-form').elements.code.value || '').trim().toUpperCase();
    if (!code) {
      say(error, 'Введите код');
      return;
    }

    var button = el('login-btn');
    button.disabled = true;
    button.textContent = 'Входим...';
    state.code = code;

    load().then(function () {
      try { localStorage.setItem(CODE_STORAGE, code); } catch (e) { /* приватный режим */ }
      show('view-board');
    }, function (err) {
      say(error, err.message);
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Войти';
    });
  });

  el('board-list').addEventListener('click', function (event) {
    var target = event.target.closest('[data-vote], [data-toggle], [data-decide]');
    if (!target) { return; }

    if (target.hasAttribute('data-toggle')) {
      var key = target.getAttribute('data-toggle');
      state.open[key] = !state.open[key];
      renderBoard();
      return;
    }

    if (target.hasAttribute('data-vote')) {
      var vote = target.getAttribute('data-vote');
      act('cast_vote', {
        p_application_id: Number(target.getAttribute('data-id')),
        p_vote: vote || null
      });
      return;
    }

    if (target.hasAttribute('data-decide')) {
      var id = Number(target.getAttribute('data-id'));
      var field = el('board-list').querySelector('.decision-comment[data-id="' + id + '"]');
      act('set_decision', {
        p_application_id: id,
        p_status: target.getAttribute('data-decide'),
        p_comment: field ? field.value : null
      }, 'Решение сохранено');
    }
  });

  el('board-list').addEventListener('change', function (event) {
    if (!event.target.classList.contains('pick')) { return; }
    state.selected[event.target.getAttribute('data-id')] = event.target.checked;
    renderBulk();
  });

  el('bulk-save').addEventListener('click', function () {
    var ids = Object.keys(state.selected)
      .filter(function (id) { return state.selected[id]; })
      .map(Number);
    if (!ids.length) { return; }

    act('set_group_note', { p_ids: ids, p_note: el('bulk-note').value }, 'Заметка поставлена')
      .then(function () { el('bulk-note').value = ''; });
  });

  el('bulk-clear').addEventListener('click', function () {
    state.selected = {};
    renderBoard();
  });

  el('intake-btn').addEventListener('click', function () {
    var open = !((state.board && state.board.intake) || {}).open;
    act('set_intake', {
      p_open: open,
      p_message: el('intake-message').value || null
    }, open ? 'Приём заявок открыт' : 'Приём заявок закрыт');
  });

  el('intake-message-save').addEventListener('click', function () {
    act('set_intake', {
      p_open: ((state.board && state.board.intake) || {}).open,
      p_message: el('intake-message').value || null
    }, 'Текст сохранён');
  });

  el('refresh-btn').addEventListener('click', function () { load(); });

  el('logout-btn').addEventListener('click', function () {
    try { localStorage.removeItem(CODE_STORAGE); } catch (e) { /* ничего */ }
    state.code = '';
    state.board = null;
    show('view-login');
  });

  // Пока жюри сидит на странице, голоса коллег подтягиваются сами
  window.setInterval(function () {
    if (!state.code || el('view-board').hidden || document.hidden) { return; }
    load(true).catch(function () { /* молча: при сбое сети покажем в следующий раз */ });
  }, 25000);

  // ------------------------------------------------------------- запуск

  function route() {
    el('policy-link').href = cfg.policyUrl || '#';
    el('form-title').textContent = cfg.title || 'Школа диджеинга';
    el('form-subtitle').textContent = cfg.subtitle || '';

    if (window.location.hash === '#judge') {
      var saved = '';
      try { saved = localStorage.getItem(CODE_STORAGE) || ''; } catch (e) { saved = ''; }
      if (saved) {
        state.code = saved;
        el('login-form').elements.code.value = saved;
        load().then(function () { show('view-board'); }, function () { show('view-login'); });
        return;
      }
      show('view-login');
      return;
    }

    show('view-form');

    // Форму показываем сразу, а не после ответа сервера: ждать пустой экран
    // хуже, чем на долю секунды увидеть поля. Если приём закрыт - уводим на
    // объяснение; заявку всё равно не примет и сама функция в базе.
    if (!configured()) { return; }
    rpc('intake_status', {}).then(function (intake) {
      if (intake && intake.open === false && !el('view-form').hidden) {
        el('closed-text').textContent = intake.message || 'Приём заявок закрыт.';
        show('view-closed');
      }
    }, function () { /* не достучались - оставляем форму, решит база */ });
  }

  window.addEventListener('hashchange', route);
  route();
})();
