"use strict";
function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname ? url.href : '';
  } catch { return ''; }
}
module.exports = { safeHttpsUrl };
