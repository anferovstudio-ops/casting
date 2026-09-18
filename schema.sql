-- Отбор диджеев: база для отдельного сервиса на Supabase.
-- Выполнять целиком в SQL Editor проекта Supabase. Повторный запуск безопасен.
--
-- Как устроена защита. Сайт статический, значит ключ anon лежит в открытом
-- виде в браузере у каждого. Поэтому прямой доступ к таблицам закрыт полностью,
-- а всё, что можно сделать, делается через функции ниже: они проверяют код
-- судьи и решают, что ему показать. Без кода из таблиц не достать ничего.

-- ---------------------------------------------------------------- таблицы

create table if not exists judges (
  id          bigint generated always as identity primary key,
  name        text not null,
  -- management решает судьбу заявки, judge только голосует
  role        text not null check (role in ('management', 'judge')),
  code        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists applications (
  id                  bigint generated always as identity primary key,
  full_name           text not null,
  isu_number          text,
  email               text not null,
  phone               text not null,
  vk_url              text,
  telegram_url        text,
  motivation          text not null default '',
  background          text not null default '',
  expectations        text not null default '',
  source              text not null default '',
  goal                text not null default '',

  -- согласие на обработку персональных данных: галочки на экране мало,
  -- нужен след - когда и с какой редакцией политики согласились
  consent_at          timestamptz,
  consent_policy_url  text,

  -- почта подтверждена кодом из письма
  email_verified      boolean not null default false,

  status              text not null default 'new' check (status in ('new', 'accepted', 'rejected')),
  decision_comment    text,
  group_note          text,
  decided_by          text,
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);

-- Одна заявка на почту: повторная отправка переписывает прежнюю,
-- пока по ней не приняли решение
create unique index if not exists applications_email_key on applications (lower(email));

-- Настройки набора. Строка ровно одна: id это булев первичный ключ со
-- check (id), поэтому вторая строка в таблицу физически не влезет.
create table if not exists settings (
  id              boolean primary key default true check (id),
  intake_open     boolean not null default true,
  closed_message  text not null default 'Приём заявок на этот поток закрыт.',
  updated_at      timestamptz not null default now(),
  updated_by      text
);

insert into settings (id) values (true) on conflict (id) do nothing;

create table if not exists votes (
  id              bigint generated always as identity primary key,
  application_id  bigint not null references applications (id) on delete cascade,
  judge_id        bigint not null references judges (id) on delete cascade,
  -- up - палец вверх, down - палец вниз
  vote            text not null check (vote in ('up', 'down')),
  updated_at      timestamptz not null default now(),
  unique (application_id, judge_id)
);

-- ------------------------------------------------------- закрываем доступ

alter table judges       enable row level security;
alter table applications enable row level security;
alter table votes        enable row level security;
alter table settings     enable row level security;

-- Политик нет вовсе: значит из браузера напрямую не читается и не пишется
-- ничего. Всё идёт через функции ниже.
revoke all on judges, applications, votes, settings from anon, authenticated;

-- --------------------------------------------------------------- функции

-- Судья по коду. Возвращает null, если кода нет: наружу не сообщаем,
-- существует ли такой код.
create or replace function judge_by_code(p_code text)
returns judges
language sql
security definer
set search_path = public
as $$
  select * from judges where code = upper(trim(p_code));
$$;

-- Открыт ли приём. Единственная функция без кода судьи: её зовёт форма,
-- чтобы не показывать поля, когда набор закрыт. Ничего, кроме флага и
-- текста для кандидата, она не отдаёт.
create or replace function intake_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'open', s.intake_open,
    'message', s.closed_message,
    'updated_at', s.updated_at,
    'updated_by', s.updated_by
  )
  from settings s where s.id;
$$;

-- Подача заявки. Почту берём из токена, если человек подтвердил её кодом
-- из письма - тогда подделать её нельзя. Если подтверждения не было,
-- заявка всё равно сохранится, но с отметкой "почта не подтверждена":
-- потерять кандидата из-за неотправленного письма хуже.
create or replace function submit_application(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_email text := nullif(auth.jwt() ->> 'email', '');
  v_form_email  text := lower(trim(payload ->> 'email'));
  v_email       text := coalesce(lower(v_token_email), v_form_email);
  v_verified    boolean := lower(coalesce(v_token_email, '')) = v_form_email and v_form_email <> '';
  v_digits      text := regexp_replace(coalesce(payload ->> 'phone', ''), '\D', '', 'g');
  v_existing    applications;
  v_id          bigint;
  v_settings    settings;
begin
  -- Закрытый приём проверяем здесь, а не только на странице: страницу
  -- можно обойти, функцию нет.
  select * into v_settings from settings where id;
  if not v_settings.intake_open then
    raise exception '%', v_settings.closed_message;
  end if;

  if coalesce(payload ->> 'consent', 'false') <> 'true' then
    raise exception 'Без согласия на обработку персональных данных заявку принять нельзя';
  end if;

  if length(coalesce(payload ->> 'full_name', '')) < 3 then
    raise exception 'Укажите фамилию и имя';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise exception 'Проверьте адрес почты';
  end if;

  if length(v_digits) < 10 or length(v_digits) > 15 then
    raise exception 'Укажите телефон полностью, с кодом страны';
  end if;

  if length(coalesce(payload ->> 'motivation', '')) < 10 then
    raise exception 'Расскажите о мотивации подробнее';
  end if;

  select * into v_existing from applications where lower(email) = v_email;

  if v_existing.id is not null and v_existing.status <> 'new' then
    raise exception 'По заявке с этой почтой решение уже принято';
  end if;

  insert into applications (
    full_name, isu_number, email, phone, vk_url, telegram_url,
    motivation, background, expectations, source, goal,
    consent_at, consent_policy_url, email_verified
  ) values (
    trim(payload ->> 'full_name'),
    nullif(trim(coalesce(payload ->> 'isu_number', '')), ''),
    v_email,
    '+' || case when length(v_digits) = 11 and left(v_digits, 1) = '8'
                then '7' || right(v_digits, 10) else v_digits end,
    nullif(trim(coalesce(payload ->> 'vk_url', '')), ''),
    nullif(trim(coalesce(payload ->> 'telegram_url', '')), ''),
    trim(coalesce(payload ->> 'motivation', '')),
    trim(coalesce(payload ->> 'background', '')),
    trim(coalesce(payload ->> 'expectations', '')),
    trim(coalesce(payload ->> 'source', '')),
    trim(coalesce(payload ->> 'goal', '')),
    now(),
    payload ->> 'consent_policy_url',
    v_verified
  )
  on conflict (lower(email)) do update set
    full_name      = excluded.full_name,
    isu_number     = excluded.isu_number,
    phone          = excluded.phone,
    vk_url         = excluded.vk_url,
    telegram_url   = excluded.telegram_url,
    motivation     = excluded.motivation,
    background     = excluded.background,
    expectations   = excluded.expectations,
    source         = excluded.source,
    goal           = excluded.goal,
    consent_at     = excluded.consent_at,
    email_verified = applications.email_verified or excluded.email_verified
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'email_verified', v_verified);
end;
$$;

-- Всё, что видит судья: список кандидатов с голосами. Контакты отдаём
-- только руководству - остальным они для оценки не нужны.
create or replace function judge_board(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_judge judges;
begin
  select * into v_judge from judge_by_code(p_code);
  if v_judge.id is null then
    raise exception 'Код не подходит';
  end if;

  return jsonb_build_object(
    'me', jsonb_build_object('id', v_judge.id, 'name', v_judge.name, 'role', v_judge.role),
    'intake', intake_status(),
    'judges', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role) order by id), '[]'::jsonb)
      from judges
    ),
    'applications', (
      select coalesce(jsonb_agg(row order by (row ->> 'created_at') desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', a.id,
          'full_name', a.full_name,
          'isu_number', a.isu_number,
          'vk_url', a.vk_url,
          'telegram_url', a.telegram_url,
          'motivation', a.motivation,
          'background', a.background,
          'expectations', a.expectations,
          'source', a.source,
          'goal', a.goal,
          'email_verified', a.email_verified,
          'status', a.status,
          'decision_comment', a.decision_comment,
          'group_note', a.group_note,
          'decided_by', a.decided_by,
          'created_at', a.created_at,
          'consent_at', a.consent_at,
          -- контакты только руководству
          'email', case when v_judge.role = 'management' then a.email end,
          'phone', case when v_judge.role = 'management' then a.phone end,
          'votes', (
            select coalesce(jsonb_object_agg(v.judge_id::text, v.vote), '{}'::jsonb)
            from votes v where v.application_id = a.id
          )
        ) as row
        from applications a
      ) rows
    )
  );
end;
$$;

-- Голос судьи. Второй голос того же человека заменяет первый,
-- пустой - снимает: ошиблись кандидатом и передумали.
create or replace function cast_vote(p_code text, p_application_id bigint, p_vote text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_judge judges;
begin
  select * into v_judge from judge_by_code(p_code);
  if v_judge.id is null then
    raise exception 'Код не подходит';
  end if;

  if p_vote is null then
    delete from votes where application_id = p_application_id and judge_id = v_judge.id;
  elsif p_vote in ('up', 'down') then
    insert into votes (application_id, judge_id, vote)
    values (p_application_id, v_judge.id, p_vote)
    on conflict (application_id, judge_id)
      do update set vote = excluded.vote, updated_at = now();
  else
    raise exception 'Голос может быть только up или down';
  end if;

  return judge_board(p_code);
end;
$$;

-- Финальное решение - только руководство. Голоса остальных это совет,
-- а не автоматический вердикт.
create or replace function set_decision(
  p_code text,
  p_application_id bigint,
  p_status text,
  p_comment text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_judge judges;
begin
  select * into v_judge from judge_by_code(p_code);
  if v_judge.id is null or v_judge.role <> 'management' then
    raise exception 'Решение принимает руководство';
  end if;

  if p_status not in ('new', 'accepted', 'rejected') then
    raise exception 'Неизвестный статус';
  end if;

  update applications set
    status = p_status,
    decision_comment = nullif(trim(coalesce(p_comment, '')), ''),
    decided_by = case when p_status = 'new' then null else v_judge.name end,
    decided_at = case when p_status = 'new' then null else now() end
  where id = p_application_id;

  return judge_board(p_code);
end;
$$;

-- Одна заметка сразу нескольким кандидатам: отметили группу, написали раз.
create or replace function set_group_note(p_code text, p_ids bigint[], p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_judge judges;
begin
  select * into v_judge from judge_by_code(p_code);
  if v_judge.id is null or v_judge.role <> 'management' then
    raise exception 'Заметки ставит руководство';
  end if;

  update applications
     set group_note = nullif(trim(coalesce(p_note, '')), '')
   where id = any (p_ids);

  return judge_board(p_code);
end;
$$;

-- Открыть и закрыть приём заявок. Кнопка видна только руководству, и
-- проверка роли здесь же: без неё любой обладатель кода судьи мог бы
-- закрыть набор.
create or replace function set_intake(p_code text, p_open boolean, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_judge judges;
begin
  select * into v_judge from judge_by_code(p_code);
  if v_judge.id is null or v_judge.role <> 'management' then
    raise exception 'Приём заявок открывает и закрывает руководство';
  end if;

  update settings set
    -- пустой текст не стирает прежний: кнопка «закрыть» не должна
    -- случайно обнулить объяснение для кандидатов
    intake_open    = coalesce(p_open, intake_open),
    closed_message = coalesce(nullif(trim(coalesce(p_message, '')), ''), closed_message),
    updated_at     = now(),
    updated_by     = v_judge.name
  where id;

  return judge_board(p_code);
end;
$$;

-- --------------------------------------------------------- права на вызов

revoke all on function submit_application(jsonb) from public;
revoke all on function judge_board(text)        from public;
revoke all on function cast_vote(text, bigint, text) from public;
revoke all on function set_decision(text, bigint, text, text) from public;
revoke all on function set_group_note(text, bigint[], text) from public;
revoke all on function intake_status()          from public;
revoke all on function set_intake(text, boolean, text) from public;
revoke all on function judge_by_code(text)      from public, anon, authenticated;

grant execute on function submit_application(jsonb) to anon, authenticated;
grant execute on function judge_board(text)        to anon, authenticated;
grant execute on function cast_vote(text, bigint, text) to anon, authenticated;
grant execute on function set_decision(text, bigint, text, text) to anon, authenticated;
grant execute on function set_group_note(text, bigint[], text) to anon, authenticated;
grant execute on function intake_status()          to anon, authenticated;
grant execute on function set_intake(text, boolean, text) to anon, authenticated;

-- Судьи заводятся отдельным файлом setup/judges_seed.sql:
-- коды это пароли, и в публичном репозитории им не место.
