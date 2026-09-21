// 本地数据层：所有进度只存在这台手机上（localStorage），无账号、无后端。
// 构造函数接受 storage 参数，便于在 Node 中注入假的存储做测试。

export const STORAGE_KEY = 'enshadow.v1';
export const SCHEMA_VERSION = 1;
export const MAX_HISTORY = 500;
export const ALLOWED_RATES = [0.6, 0.8, 1];
export const LOW_SCORE_THRESHOLD = 60;

const pad = (n) => String(n).padStart(2, '0');

/** 本地日期键 YYYY-MM-DD（按设备时区，不用 UTC） */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 在日期键上加减天数 */
export function shiftKey(key, delta) {
  const d = parseKey(key);
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}

export function defaultState() {
  return {
    version: SCHEMA_VERSION,
    settings: { dailyGoal: 10, rate: 1, autoScore: true },
    customSentences: [],
    history: [],
    checkin: {},
  };
}

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function sanitizeSentence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const en = String(raw.en ?? '').trim();
  const zh = String(raw.zh ?? '').trim();
  if (!en) return null;
  return {
    id: String(raw.id ?? ''),
    en,
    zh,
    courseId: String(raw.courseId ?? 'mine'),
  };
}

function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sentenceId = String(raw.sentenceId ?? '').trim();
  if (!sentenceId) return null;
  const score = clampInt(raw.score, 0, 100, 0);
  const ts = Number(raw.ts);
  return {
    sentenceId,
    sourceId: String(raw.sourceId ?? ''),
    score,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
}

/** 把任意来源的对象整理成合法的完整状态 */
export function sanitizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const rate = Number(s.rate);
  base.settings = {
    dailyGoal: clampInt(s.dailyGoal, 1, 999, base.settings.dailyGoal),
    rate: ALLOWED_RATES.includes(rate) ? rate : base.settings.rate,
    autoScore: s.autoScore === undefined ? base.settings.autoScore : Boolean(s.autoScore),
  };

  if (Array.isArray(raw.customSentences)) {
    const seen = new Set();
    base.customSentences = raw.customSentences
      .map(sanitizeSentence)
      .filter((item) => item && !seen.has(item.id) && seen.add(item.id));
  }

  if (Array.isArray(raw.history)) {
    base.history = raw.history
      .map(sanitizeHistoryEntry)
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts)
      .slice(-MAX_HISTORY);
  }

  if (raw.checkin && typeof raw.checkin === 'object') {
    for (const [key, val] of Object.entries(raw.checkin)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !val || typeof val !== 'object') continue;
      base.checkin[key] = {
        count: clampInt(val.count, 0, 9999, 0),
        best: clampInt(val.best, 0, 100, 0),
      };
    }
  }

  return base;
}

export function createStore(storage = globalThis.localStorage) {
  let state = defaultState();

  function load() {
    try {
      const rawText = storage?.getItem(STORAGE_KEY);
      if (!rawText) return defaultState();
      return sanitizeState(JSON.parse(rawText));
    } catch {
      // 数据损坏时不让应用崩掉，直接回到初始状态
      return defaultState();
    }
  }

  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 隐私模式或配额满：忽略写入失败，内存状态继续可用
    }
  }

  state = load();

  const hasCount = (key) => (state.checkin[key]?.count ?? 0) > 0;

  return {
    get state() {
      return state;
    },

    getSettings() {
      return { ...state.settings };
    },

    updateSettings(patch) {
      state = sanitizeState({ ...state, settings: { ...state.settings, ...patch } });
      save();
      return this.getSettings();
    },

    /** 记录一次练习：写历史 + 当天打卡 */
    recordAttempt({ sentenceId, sourceId = '', score = null, ts = Date.now() }) {
      const entry = sanitizeHistoryEntry({ sentenceId, sourceId, score, ts });
      if (!entry) return null;
      state.history.push(entry);
      if (state.history.length > MAX_HISTORY) {
        state.history.splice(0, state.history.length - MAX_HISTORY);
      }
      const key = dateKey(new Date(entry.ts));
      const day = state.checkin[key] ?? { count: 0, best: 0 };
      day.count += 1;
      day.best = Math.max(day.best, entry.score);
      state.checkin[key] = day;
      save();
      return entry;
    },

    history() {
      return state.history.slice();
    },

    todayKey() {
      return dateKey();
    },

    dayInfo(key = dateKey()) {
      const day = state.checkin[key];
      return { count: day?.count ?? 0, best: day?.best ?? 0 };
    },

    /** 连续打卡天数：今天没练则从昨天往前算，练了就从今天算 */
    streak() {
      let cursor = dateKey();
      if (!hasCount(cursor)) cursor = shiftKey(cursor, -1);
      let count = 0;
      while (hasCount(cursor)) {
        count += 1;
        cursor = shiftKey(cursor, -1);
      }
      return count;
    },

    /** 最近 days 天的每日练习量，按时间升序 */
    dailyStats(days = 7) {
      const today = dateKey();
      const out = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const key = shiftKey(today, -i);
        const info = this.dayInfo(key);
        out.push({ date: key, count: info.count, best: info.best });
      }
      return out;
    },

    /** 最近 days 天出现过的平均分（无记录返回 null） */
    averageScore(days = 7) {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - (days - 1));
      const rows = state.history.filter((h) => h.ts >= from.getTime());
      if (!rows.length) return null;
      const sum = rows.reduce((acc, h) => acc + h.score, 0);
      return Math.round(sum / rows.length);
    },

    totalAttempts() {
      return state.history.length;
    },

    /** sentenceId → 最佳分 */
    bestScores() {
      const map = new Map();
      for (const h of state.history) {
        const prev = map.get(h.sentenceId);
        if (prev === undefined || h.score > prev) map.set(h.sentenceId, h.score);
      }
      return map;
    },

    /** 每句取最近一次成绩，低于阈值则进入待复习列表 */
    lowSentences(threshold = LOW_SCORE_THRESHOLD, limit = 20) {
      const latest = new Map();
      for (const h of state.history) latest.set(h.sentenceId, h);
      return [...latest.values()]
        .filter((h) => h.score < threshold)
        .sort((a, b) => a.score - b.score || b.ts - a.ts)
        .slice(0, limit);
    },

    custom() {
      return state.customSentences.slice();
    },

    addCustom({ en, zh = '', courseId = 'mine' }) {
      const sentence = sanitizeSentence({
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        en,
        zh,
        courseId,
      });
      if (!sentence) return null;
      state.customSentences.push(sentence);
      save();
      return sentence;
    },

    updateCustom(id, patch) {
      const idx = state.customSentences.findIndex((s) => s.id === id);
      if (idx < 0) return null;
      const merged = sanitizeSentence({ ...state.customSentences[idx], ...patch, id });
      if (!merged) return null;
      state.customSentences[idx] = merged;
      save();
      return merged;
    },

    removeCustom(id) {
      const before = state.customSentences.length;
      state.customSentences = state.customSentences.filter((s) => s.id !== id);
      const removed = state.customSentences.length !== before;
      if (removed) save();
      return removed;
    },

    exportObject() {
      return { ...state, version: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
    },

    exportJSON() {
      return JSON.stringify(this.exportObject(), null, 2);
    },

    /**
     * 合并导入：同 id 的自建句子以导入内容为准，历史按 (sentenceId, ts) 去重，
     * 打卡取较大的次数与最佳分。
     */
    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: '文件不是合法的 JSON' };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '文件内容不是本应用导出的数据' };
      }
      const known = ['settings', 'customSentences', 'history', 'checkin'];
      if (!known.some((k) => k in parsed)) {
        return { ok: false, error: '文件缺少可识别的字段（settings / customSentences / history / checkin）' };
      }

      const incoming = sanitizeState(parsed);
      const incomingSettings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
      const before = { custom: state.customSentences.length, history: state.history.length };

      // 备份恢复场景：文件里明确写了的设置项才覆盖，未写的保持本机当前值
      const settingsPatch = {};
      for (const key of ['dailyGoal', 'rate', 'autoScore']) {
        if (key in incomingSettings) settingsPatch[key] = incoming.settings[key];
      }
      if (Object.keys(settingsPatch).length) {
        state.settings = { ...state.settings, ...settingsPatch };
      }

      const customMap = new Map(state.customSentences.map((s) => [s.id, s]));
      for (const s of incoming.customSentences) customMap.set(s.id, s);
      state.customSentences = [...customMap.values()];

      const seen = new Set(state.history.map((h) => `${h.sentenceId}@${h.ts}`));
      for (const h of incoming.history) {
        const sig = `${h.sentenceId}@${h.ts}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          state.history.push(h);
        }
      }
      state.history.sort((a, b) => a.ts - b.ts);
      if (state.history.length > MAX_HISTORY) {
        state.history.splice(0, state.history.length - MAX_HISTORY);
      }

      for (const [key, val] of Object.entries(incoming.checkin)) {
        const cur = state.checkin[key] ?? { count: 0, best: 0 };
        state.checkin[key] = {
          count: Math.max(cur.count, val.count),
          best: Math.max(cur.best, val.best),
        };
      }

      save();
      return {
        ok: true,
        addedCustom: state.customSentences.length - before.custom,
        addedHistory: state.history.length - before.history,
      };
    },

    reset() {
      state = defaultState();
      save();
    },
  };
}
