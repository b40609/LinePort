// Message template interpolation and advanced keyword matching (AND logic & Regex)

export function formatTaipeiTime(timestamp) {
  const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}:${seconds}`,
    timeShort: `${hours}:${minutes}`,
  };
}

export function resolveSenderName(message, rule, sourceKey) {
  const from = String(message?.from || '');
  if (rule?.senderAliases && sourceKey && rule.senderAliases[sourceKey]?.[from]) {
    return rule.senderAliases[sourceKey][from];
  }
  if (message?.senderName && typeof message.senderName === 'string') {
    return message.senderName;
  }
  return from;
}

export function renderMessageText({ template, prefix = '', message, source, rule }) {
  const originalText = String(message?.text || '');
  const timestamp = Number(message?.createdTime || message?.deliveredTime) || Date.now();
  const sourceKey = source ? (source.platform ? `${source.platform}:${source.id}` : source.id) : '';
  const sourceName = source?.name || sourceKey || '未知來源';
  const senderName = resolveSenderName(message, rule, sourceKey);
  const { date, time, timeShort } = formatTaipeiTime(timestamp);

  const variables = {
    source: sourceName,
    sender: senderName,
    date,
    time,
    timeShort,
    text: originalText,
  };

  const interpolate = tmpl => {
    return tmpl.replace(/\{(\w+)\}/g, (match, key) => {
      return key in variables ? variables[key] : match;
    });
  };

  if (typeof template === 'string' && template.trim()) {
    return interpolate(template);
  }

  if (typeof prefix === 'string' && /\{(\w+)\}/.test(prefix)) {
    return interpolate(prefix) + originalText;
  }

  return prefix + originalText;
}

export function matchKeywordRule(text, keywordPattern) {
  if (typeof text !== 'string' || typeof keywordPattern !== 'string') return false;
  const trimmed = keywordPattern.trim();
  if (!trimmed) return false;

  // Regex support: /pattern/flags with length and flag sanitization
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/');
    const pattern = trimmed.slice(1, lastSlash);
    // Limit pattern length to mitigate complex backtracking constructs
    if (pattern.length > 0 && pattern.length <= 256) {
      const rawFlags = trimmed.slice(lastSlash + 1);
      const safeFlags = rawFlags.replace(/[^gimsuy]/gi, '');
      try {
        const regex = new RegExp(pattern, safeFlags.includes('i') ? safeFlags : safeFlags + 'i');
        const sample = text.length > 20000 ? text.slice(0, 20000) : text;
        return regex.test(sample);
      } catch {
        // Fallback to literal if invalid regex
      }
    }
  }

  // AND logic support: term1 + term2 or term1 AND term2
  if (trimmed.includes(' + ') || trimmed.includes(' AND ')) {
    const parts = trimmed.split(/\s+\+\s+|\s+AND\s+/).map(p => p.trim()).filter(Boolean);
    const lower = text.toLocaleLowerCase();
    return parts.every(part => lower.includes(part.toLocaleLowerCase()));
  }

  // Literal match (case-insensitive)
  return text.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
}
