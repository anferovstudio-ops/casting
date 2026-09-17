// Единственный файл, который нужно заполнить своими значениями.
// Оба значения берутся в Supabase: Project Settings -> API.
//
// Ключ anon публичный, его видно всем - так и должно быть. Доступ к данным
// он не даёт: таблицы закрыты, всё идёт через проверяющие функции.
// А вот ключ service_role сюда вставлять нельзя ни при каких условиях.

window.CASTING_CONFIG = {
  // Project URL, вид: https://abcdefghijklm.supabase.co
  supabaseUrl: 'https://xyhkkqmkqsbcorydknsc.supabase.co',

  // anon public key, длинная строка, начинается на eyJ
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5aGtrcW1rcXNiY29yeWRrbnNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NzY5NDMsImV4cCI6MjEwNTI1Mjk0M30.tVubDCqngJbRX5g2jkBf40LvuUS5pjdy1z1HqkJzEUU',

  // Политика обработки персональных данных
  policyUrl: 'https://itmo.ru/file/pages/79/personal_data_policy.pdf',

  // Название набора - показывается в заголовке формы
  title: 'Школа диджеинга Мегабайт Медиа',
  subtitle: 'Отбор на осенний поток'
};
