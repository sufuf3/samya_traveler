/**
 * 常見拋棄式（免洗）信箱網域。首次免費額度只開放給真實常用信箱。
 * 可用環境變數 DISPOSABLE_EXTRA_DOMAINS（逗號分隔）追加網域。
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.net',
  'tempmailo.com',
  'tempmail.plus',
  'tempr.email',
  'tmpmail.org',
  'tmpmail.net',
  'tmail.ws',
  '10minutemail.com',
  '10minutemail.net',
  '10minutemail.co.uk',
  '10minmail.com',
  '20minutemail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamailblock.com',
  'grr.la',
  'sharklasers.com',
  'pokemail.net',
  'spam4.me',
  'yopmail.com',
  'yopmail.net',
  'yopmail.fr',
  'cool.fr.nf',
  'jetable.org',
  'trashmail.com',
  'trashmail.net',
  'trashmail.de',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'maildrop.cc',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'fakemail.net',
  'emailondeck.com',
  'mailcatch.com',
  'mytemp.email',
  'moakt.com',
  'burnermail.io',
  'spambox.us',
  'spamgourmet.com',
  'mail.tm',
  'mailpoof.com',
  'emailfake.com',
  'tempinbox.com',
  'inboxkitten.com',
  'luxusmail.org',
  'dropmail.me',
  'harakirimail.com',
  '33mail.com',
  'mailsac.com',
  'getairmail.com',
  'tempail.com',
  'linshiyouxiang.net',
  'minuteinbox.com',
  'emltmp.com',
  'byom.de',
  'discard.email',
  'anonbox.net',
  'deadaddress.com'
]);

function extraDomains(): string[] {
  return (process.env.DISPOSABLE_EXTRA_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 網域本身或其子網域（例如 xx.mailinator.com）屬於免洗信箱即回傳 true。 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@').pop()?.trim().toLowerCase() || '';
  if (!domain) return false;
  const extras = extraDomains();
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (DISPOSABLE_DOMAINS.has(candidate) || extras.includes(candidate)) return true;
  }
  return false;
}
