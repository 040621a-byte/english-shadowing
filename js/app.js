// 界面与交互：hash 路由 + 模板渲染 + 事件委托。
// 无框架、无构建步骤，纯 ES 模块。

import { BUILTIN_COURSES, MY_COURSE } from './data.js';
import { scorePronunciation, verdictFor } from './score.js';
import { createStore, dateKey } from './store.js';
import {
  ShadowSession,
  getCapabilities,
  primeVoices,
  speak,
  stopSpeaking,
} from './speech.js';

const store = createStore();
const caps = getCapabilities();

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

const drill = {
  session: null,
  starting: false,
  recording: false,
  result: null,
  liveText: '',
};

let editingCustomId = null;
let deferredInstallPrompt = null;
let recordRange = 7;
// 设备英语语音探测结果（部分安卓机没装英语语音，听原声会没声音）
const voiceState = { checked: false, englishCount: 0 };

/* --------------------------------- 工具 --------------------------------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('is-visible'), 2800);
}

function navigate(path) {
  if (location.hash === `#/${path}`) render();
  else location.hash = `#/${path}`;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, a, b] = raw.split('/');
  if (name === 'course' && a) return { name: 'course', courseId: a };
  if (name === 'drill' && a) return { name: 'drill', courseId: a, index: Math.max(0, Number(b) || 0) };
  if (name === 'records') return { name: 'records' };
  if (name === 'me') return { name: 'me' };
  return { name: 'practice' };
}

/** 内置场景 + 用户自建句子，每次渲染时重建（数据量小） */
function allCourses() {
  const custom = store.custom();
  const list = BUILTIN_COURSES.map((course) => ({
    ...course,
    // 内置句子本身不写 courseId，这里统一补上，记录页才能按句跳回练习
    sentences: course.sentences
      .map((sentence) => ({ ...sentence, courseId: course.id }))
      .concat(custom.filter((s) => s.courseId === course.id)),
  }));
  list.push({
    ...MY_COURSE,
    sentences: custom.filter((s) => !s.courseId || s.courseId === MY_COURSE.id),
  });
  return list;
}

function sentenceIndex() {
  const map = new Map();
  for (const course of allCourses()) {
    for (const sentence of course.sentences) {
      map.set(sentence.id, { ...sentence, courseTitle: course.title });
    }
  }
  return map;
}

function findCourse(courseId) {
  return allCourses().find((c) => c.id === courseId) ?? null;
}

function scoreTone(score) {
  if (score >= 90) return 'great';
  if (score >= 75) return 'good';
  if (score >= 60) return 'ok';
  return 'low';
}

/* --------------------------------- 视图 --------------------------------- */

function render() {
  const route = parseRoute();
  const courses = allCourses();
  const best = store.bestScores();

  let html = '';
  if (route.name === 'course') html = viewCourse(route, courses, best);
  else if (route.name === 'drill') html = viewDrill(route, courses, best);
  else if (route.name === 'records') html = viewRecords();
  else if (route.name === 'me') html = viewMe();
  else html = viewPractice(courses, best);

  const showNav = route.name !== 'drill';
  appEl.innerHTML = showNav ? `${html}${viewNav(route)}` : html;
  document.body.classList.toggle('is-drill', !showNav);
}

function viewNav(route) {
  const tabs = [
    { path: 'practice', label: '练习', icon: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>' },
    { path: 'records', label: '记录', icon: '<path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/>' },
    { path: 'me', label: '我的', icon: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c1.2-3.6 3.6-5.4 6.5-5.4S17.3 16.4 18.5 20"/>' },
  ];
  const items = tabs
    .map((tab) => {
      const active = route.name === tab.path ? ' is-active' : '';
      return `<button class="nav__item${active}" data-action="nav" data-path="${tab.path}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${tab.icon}</svg>
        <span>${tab.label}</span>
      </button>`;
    })
    .join('');
  return `<nav class="nav">${items}</nav>`;
}

function viewPractice(courses, best) {
  const today = store.dayInfo();
  const goal = store.getSettings().dailyGoal;
  const streak = store.streak();
  const percent = Math.min(100, Math.round((today.count / goal) * 100));
  const totalSentences = courses.reduce((acc, c) => acc + c.sentences.length, 0);
  const doneSentences = courses.reduce(
    (acc, c) => acc + c.sentences.filter((s) => best.has(s.id)).length,
    0,
  );

  const cards = courses
    .map((course) => {
      const done = course.sentences.filter((s) => best.has(s.id)).length;
      const coursePercent = course.sentences.length
        ? Math.round((done / course.sentences.length) * 100)
        : 0;
      const hint = course.id === MY_COURSE.id && !course.sentences.length
        ? '在「我的」里添加自己的句子'
        : `${done}/${course.sentences.length} 句已练`;
      return `<button class="course-card" data-action="open-course" data-course="${esc(course.id)}">
        <span class="course-card__emoji">${course.emoji}</span>
        <span class="course-card__body">
          <span class="course-card__title">${esc(course.title)}</span>
          <span class="course-card__hint">${esc(hint)}</span>
          <span class="bar"><span class="bar__fill" style="width:${coursePercent}%"></span></span>
        </span>
      </button>`;
    })
    .join('');

  const remain = Math.max(0, goal - today.count);

  return `
  <header class="page-head">
    <h1 class="page-title">跟读练习</h1>
    <p class="page-sub">听原声 → 跟读 → 看分 → 回听</p>
  </header>
  <section class="card checkin">
    <div class="checkin__top">
      <div>
        <p class="checkin__label">今日已练</p>
        <p class="checkin__value"><strong>${today.count}</strong><span>/ ${goal} 句</span></p>
      </div>
      <div class="checkin__streak">
        <span class="checkin__flame">🔥</span>
        <span><strong>${streak}</strong> 天连续</span>
      </div>
    </div>
    <span class="bar bar--lg"><span class="bar__fill" style="width:${percent}%"></span></span>
    <p class="checkin__foot">${percent >= 100 ? '今天的目标完成啦，继续保持！' : `再练 ${remain} 句就达成今天的目标`}　·　已练过 ${doneSentences}/${totalSentences} 句</p>
  </section>
  <h2 class="section-title">选择场景</h2>
  <section class="course-grid">${cards}</section>
  ${deferredInstallPrompt ? '<button class="install-banner" data-action="install">📲 添加到手机主屏幕，用起来像 App</button>' : ''}
  `;
}

function viewCourse(route, courses, best) {
  const course = courses.find((c) => c.id === route.courseId);
  if (!course) {
    return `${pageHead('场景不存在', '')}
      <p class="empty">这个场景找不到，可能已被删除。</p>
      <button class="btn btn--ghost" data-action="nav" data-path="practice">返回场景列表</button>`;
  }
  const done = course.sentences.filter((s) => best.has(s.id)).length;
  const rows = course.sentences
    .map((sentence, idx) => {
      const score = best.get(sentence.id);
      const badge = score === undefined
        ? '<span class="pill pill--none">未练</span>'
        : `<span class="pill pill--${scoreTone(score)}">${score}</span>`;
      return `<button class="sentence-row" data-action="open-drill" data-course="${esc(course.id)}" data-index="${idx}">
        <span class="sentence-row__no">${idx + 1}</span>
        <span class="sentence-row__body">
          <span class="sentence-row__en">${esc(sentence.en)}</span>
          <span class="sentence-row__zh">${esc(sentence.zh)}</span>
        </span>
        ${badge}
      </button>`;
    })
    .join('');

  const empty = course.sentences.length
    ? ''
    : '<p class="empty">这里还没有句子，去「我的 → 我的句子」添加吧。</p>';

  return `
  <header class="page-head page-head--row">
    <button class="icon-btn" data-action="nav" data-path="practice" aria-label="返回">‹</button>
    <div>
      <h1 class="page-title">${course.emoji} ${esc(course.title)}</h1>
      <p class="page-sub">已练 ${done}/${course.sentences.length} 句</p>
    </div>
  </header>
  ${empty}
  <section class="list">${rows}</section>
  `;
}

function viewDrill(route, courses, best) {
  const course = courses.find((c) => c.id === route.courseId);
  if (!course || !course.sentences.length) {
    return `${pageHead('没有可练的句子', '')}
      <button class="btn btn--ghost" data-action="nav" data-path="practice">返回场景列表</button>`;
  }
  const safeIndex = Math.min(route.index, course.sentences.length - 1);
  const sentence = course.sentences[safeIndex];
  const bestScore = best.get(sentence.id);
  const settings = store.getSettings();

  const rateButtons = [0.6, 0.8, 1]
    .map((rate) => `<button class="seg__item${settings.rate === rate ? ' is-active' : ''}"
        data-action="set-rate" data-rate="${rate}">${rate === 1 ? '原速' : `${rate}x`}</button>`)
    .join('');

  // 语音识别不需要 HTTPS（只有录音回听需要），所以两种情况的提示分开写
  const recognitionProblem = !caps.recognition
    ? '此浏览器不支持语音识别打分（需要 Chrome），可以录音回听对比。'
    : (!caps.secure ? '当前不是 HTTPS 环境，浏览器不允许录音回听；跟读打分仍然可用，但需要联网。' : '');
  const ttsProblem = !caps.tts
    ? '此设备不支持语音朗读，请用其他浏览器打开。'
    : (voiceState.checked && voiceState.englishCount === 0
      ? '设备里没有英语语音，听原声可能没有声音。安卓可在「设置 → 语言和输入 → 文字转语音」里安装英语语音包。'
      : '');

  let resultHtml = '';
  if (drill.result) {
    const r = drill.result;
    if (r.hasScore) {
      const words = r.words
        .map((w) => {
          const title = w.status === 'wrong' && w.heard ? `识别为 “${esc(w.heard)}”` : '';
          return `<span class="word word--${w.status}" title="${title}">${esc(w.text)}</span>`;
        })
        .join(' ');
      resultHtml = `
      <div class="result">
        <div class="result__score result__score--${scoreTone(r.score)}">
          <strong>${r.score}</strong><span>分</span>
        </div>
        <p class="result__verdict">${esc(verdictFor(r.score))}</p>
        <p class="result__words">${words}</p>
        ${r.extra.length ? `<p class="result__note">多读的词：${esc(r.extra.join('、'))}</p>` : ''}
        <p class="result__heard">识别到：${esc(r.transcript || '（没有识别到内容）')}</p>
      </div>`;
    } else {
      resultHtml = `<div class="result result--plain">
        <p class="result__verdict">${esc(r.reasonText)}</p>
        ${r.transcript ? `<p class="result__heard">识别到：${esc(r.transcript)}</p>` : ''}
      </div>`;
    }
  }

  const playback = drill.result?.audioUrl
    ? `<div class="playback">
        <p class="playback__label">回听我的录音</p>
        <audio controls preload="metadata" src="${esc(drill.result.audioUrl)}"></audio>
      </div>`
    : '';

  const emptyRecordingNote = drill.result?.recordingEmpty
    ? '<p class="result__note">这次录音几乎没有声音，可能被识别服务占用了麦克风，重试一次通常就好了。</p>'
    : '';

  const isLast = safeIndex === course.sentences.length - 1;

  return `
  <header class="drill-head">
    <button class="icon-btn" data-action="back-to-course" data-course="${esc(course.id)}" aria-label="返回">‹</button>
    <div class="drill-head__mid">
      <span class="drill-head__title">${esc(course.title)}</span>
      <span class="drill-head__count">${safeIndex + 1} / ${course.sentences.length}</span>
    </div>
    <span class="pill pill--${bestScore === undefined ? 'none' : scoreTone(bestScore)}">${bestScore === undefined ? '未练' : `最佳 ${bestScore}`}</span>
  </header>

  <section class="card sentence-card">
    <p class="sentence-card__en">${esc(sentence.en)}</p>
    <p class="sentence-card__zh">${esc(sentence.zh)}</p>
    ${sentence.tip ? `<p class="sentence-card__tip">💡 ${esc(sentence.tip)}</p>` : ''}
  </section>

  <div class="controls">
    <button class="btn btn--primary" data-action="play">🔊 听原声</button>
    <div class="seg" role="group" aria-label="语速">${rateButtons}</div>
  </div>

  ${recognitionProblem ? `<p class="hint hint--warn">${esc(recognitionProblem)}</p>` : ''}
  ${ttsProblem ? `<p class="hint hint--warn">${esc(ttsProblem)}</p>` : ''}

  <section class="record-area">
    <button class="record-btn${drill.recording ? ' is-recording' : ''}" data-action="record-toggle"
      aria-label="${drill.recording ? '停止' : '开始跟读'}" ${drill.starting ? 'disabled' : ''}>
      <span class="record-btn__icon">${drill.recording ? '■' : '🎙️'}</span>
      <span class="record-btn__label">${
        drill.starting ? '正在启动麦克风…' : drill.recording ? '点击结束' : '开始跟读'
      }</span>
    </button>
    <p class="record-area__live">${esc(drill.liveText)}</p>
  </section>

  ${resultHtml}
  ${playback}
  ${emptyRecordingNote}

  <div class="drill-actions">
    <button class="btn btn--ghost" data-action="retry">再读一次</button>
    <button class="btn btn--primary" data-action="next" ${isLast ? 'disabled' : ''}>
      ${isLast ? '已是最后一句' : '下一句 ›'}
    </button>
  </div>
  `;
}

function viewRecords() {
  const days = recordRange;
  const stats = store.dailyStats(days);
  const max = Math.max(store.getSettings().dailyGoal, ...stats.map((s) => s.count), 1);
  const avg = store.averageScore(days);
  const total = stats.reduce((acc, s) => acc + s.count, 0);
  const activeDays = stats.filter((s) => s.count > 0).length;
  const todayCount = stats[stats.length - 1]?.count ?? 0;

  const bars = stats
    .map((s) => {
      const height = Math.round((s.count / max) * 100);
      const label = s.date.slice(5).replace('-', '/');
      return `<div class="chart__col" title="${s.date}：${s.count} 句">
        <span class="chart__bar" style="height:${Math.max(s.count ? 8 : 2, height)}%"></span>
        <span class="chart__label">${days <= 7 ? label : ''}</span>
      </div>`;
    })
    .join('');

  const index = sentenceIndex();
  const low = store.lowSentences(60, 20);
  const lowRows = low.length
    ? low.map((h) => {
        const sentence = index.get(h.sentenceId);
        const title = sentence ? sentence.en : '（已删除的句子）';
        const sub = sentence ? sentence.zh : '';
        const jump = sentence
          ? `data-action="jump-drill" data-course="${esc(sentence.courseId)}" data-id="${esc(h.sentenceId)}"`
          : 'disabled';
        return `<button class="sentence-row" ${jump}>
          <span class="pill pill--${scoreTone(h.score)}">${h.score}</span>
          <span class="sentence-row__body">
            <span class="sentence-row__en">${esc(title)}</span>
            <span class="sentence-row__zh">${esc(sub)}</span>
          </span>
        </button>`;
      }).join('')
    : '<p class="empty">还没有低于 60 分的句子，保持得不错。</p>';

  return `
  <header class="page-head">
    <h1 class="page-title">练习记录</h1>
    <p class="page-sub">数据只保存在这台手机上</p>
  </header>
  <section class="stat-grid">
    <div class="stat"><strong>${store.streak()}</strong><span>连续打卡（天）</span></div>
    <div class="stat"><strong>${todayCount}</strong><span>今日练习（句）</span></div>
    <div class="stat"><strong>${avg === null ? '—' : avg}</strong><span>近${days}天平均分</span></div>
    <div class="stat"><strong>${activeDays}</strong><span>近${days}天有练</span></div>
  </section>

  <section class="card">
    <div class="card__head">
      <h2 class="section-title">每日练习量</h2>
      <div class="seg seg--sm">
        <button class="seg__item${days === 7 ? ' is-active' : ''}" data-action="range" data-days="7">7 天</button>
        <button class="seg__item${days === 30 ? ' is-active' : ''}" data-action="range" data-days="30">30 天</button>
      </div>
    </div>
    <div class="chart">${bars}</div>
    <p class="checkin__foot">近${days}天共练习 ${total} 句</p>
  </section>

  <h2 class="section-title">待复习（低于 60 分）</h2>
  <section class="list">${lowRows}</section>
  `;
}

function viewMe() {
  const settings = store.getSettings();
  const custom = store.custom();
  const editing = editingCustomId ? custom.find((s) => s.id === editingCustomId) : null;
  const courseChoices = [{ id: MY_COURSE.id, title: MY_COURSE.title }].concat(
    BUILTIN_COURSES.map((c) => ({ id: c.id, title: c.title })),
  );

  const courseOptions = courseChoices
    .map((c) => {
      const selected = (editing?.courseId ?? MY_COURSE.id) === c.id ? ' selected' : '';
      return `<option value="${esc(c.id)}"${selected}>${esc(c.title)}</option>`;
    })
    .join('');

  const customRows = custom.length
    ? custom.map((s) => {
        const courseTitle = courseChoices.find((c) => c.id === s.courseId)?.title ?? MY_COURSE.title;
        return `<div class="sentence-row sentence-row--static">
          <span class="sentence-row__body">
            <span class="sentence-row__en">${esc(s.en)}</span>
            <span class="sentence-row__zh">${esc(s.zh)}　·　${esc(courseTitle)}</span>
          </span>
          <button class="mini-btn" data-action="edit-custom" data-id="${esc(s.id)}">编辑</button>
          <button class="mini-btn mini-btn--danger" data-action="delete-custom" data-id="${esc(s.id)}">删除</button>
        </div>`;
      }).join('')
    : '<p class="empty">还没有自己的句子，用下面的表单添加。</p>';

  const capabilityRows = [
    ['语音朗读（听原声）', caps.tts],
    ['英语语音包', voiceState.checked ? voiceState.englishCount > 0 : caps.tts],
    ['录音回听', caps.recording],
    ['语音识别打分', caps.recognition],
  ]
    .map(([label, ok]) => `<li><span>${esc(label)}</span><span class="${ok ? 'tag-ok' : 'tag-no'}">${ok ? '可用' : '不可用'}</span></li>`)
    .join('');

  return `
  <header class="page-head">
    <h1 class="page-title">我的</h1>
    <p class="page-sub">设置、自己的句子与数据备份</p>
  </header>

  <section class="card">
    <h2 class="section-title">练习设置</h2>
    <div class="field">
      <label for="goalInput">每日目标（句）</label>
      <input id="goalInput" type="number" min="1" max="999" value="${settings.dailyGoal}" />
    </div>
    <div class="field">
      <span>默认语速</span>
      <div class="seg">
        ${[0.6, 0.8, 1]
          .map((rate) => `<button class="seg__item${settings.rate === rate ? ' is-active' : ''}"
            data-action="set-rate" data-rate="${rate}">${rate === 1 ? '原速' : `${rate}x`}</button>`)
          .join('')}
      </div>
    </div>
    <div class="field field--row">
      <div>
        <span>跟读后自动打分</span>
        <p class="field__hint">关闭后只录音回听，不做语音识别</p>
      </div>
      <button class="switch${settings.autoScore ? ' is-on' : ''}" data-action="toggle-autoscore"
        aria-pressed="${settings.autoScore}"><span></span></button>
    </div>
  </section>

  <section class="card">
    <h2 class="section-title">我的句子</h2>
    ${customRows}
    <form class="custom-form" data-action="custom-submit">
      <p class="field__hint">${editing ? '正在编辑已有句子' : '添加一句想练的话'}</p>
      <input id="customEn" type="text" placeholder="英文句子" value="${editing ? esc(editing.en) : ''}" required />
      <input id="customZh" type="text" placeholder="中文意思（可选）" value="${editing ? esc(editing.zh) : ''}" />
      <select id="customCourse">${courseOptions}</select>
      <div class="custom-form__actions">
        <button class="btn btn--primary" type="submit">${editing ? '保存修改' : '添加句子'}</button>
        ${editing ? '<button class="btn btn--ghost" type="button" data-action="cancel-edit">取消</button>' : ''}
      </div>
    </form>
  </section>

  <section class="card">
    <h2 class="section-title">数据</h2>
    <p class="field__hint">共 ${store.totalAttempts()} 条练习记录、${custom.length} 句自建句子，全部存在本机浏览器里。</p>
    <div class="btn-row">
      <button class="btn btn--primary" data-action="export">导出备份</button>
      <button class="btn btn--ghost" data-action="import">导入备份</button>
    </div>
    <button class="btn btn--danger btn--block" data-action="reset">清空全部数据</button>
    <input id="importFile" type="file" accept="application/json,.json" hidden />
  </section>

  <section class="card">
    <h2 class="section-title">设备能力检测</h2>
    <ul class="cap-list">${capabilityRows}</ul>
    <p class="field__hint">${
      caps.secure
        ? '当前是安全（HTTPS）环境，麦克风可以正常使用。'
        : '当前不是 HTTPS 环境，手机浏览器会阻止麦克风，请部署到 HTTPS 后再用跟读功能。'
    }</p>
  </section>

  ${deferredInstallPrompt ? '<button class="install-banner" data-action="install">📲 添加到手机主屏幕</button>' : ''}
  `;
}

function pageHead(title, sub) {
  return `<header class="page-head"><h1 class="page-title">${esc(title)}</h1>
    ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}</header>`;
}

/* ------------------------------- 练习页交互 ------------------------------- */

function currentSentence() {
  const route = parseRoute();
  const course = findCourse(route.courseId);
  if (!course || !course.sentences.length) return null;
  const index = Math.min(route.index, course.sentences.length - 1);
  return { course, sentence: course.sentences[index], index };
}

function setLiveText(text) {
  drill.liveText = text;
  const box = document.querySelector('.record-area__live');
  if (box) box.textContent = text;
}

function releaseAudio() {
  if (drill.result?.audioUrl) {
    try {
      URL.revokeObjectURL(drill.result.audioUrl);
    } catch {
      /* 忽略 */
    }
  }
}

async function handlePlay() {
  const current = currentSentence();
  if (!current) return;
  const { ok, message } = await speak(current.sentence.en, { rate: store.getSettings().rate });
  if (!ok) toast(message ?? '朗读失败');
}

async function toggleRecording() {
  if (drill.starting) return;
  if (drill.recording && drill.session) {
    const session = drill.session;
    drill.recording = false;
    render();
    finishRecording(await session.stop());
    return;
  }
  if (drill.recording) return;
  const current = currentSentence();
  if (!current) return;

  stopSpeaking();
  releaseAudio();
  drill.result = null;
  drill.liveText = '';
  drill.starting = true;
  render();

  const settings = store.getSettings();
  const words = current.sentence.en.trim().split(/\s+/).filter(Boolean).length;
  const session = new ShadowSession({
    useRecognition: settings.autoScore && caps.recognition,
    fallbackMs: Math.min(10000, Math.max(3000, 1500 + words * 450)),
  });
  drill.session = session;
  session.onPartial = (text) => setLiveText(text ? `听到：${text}` : '');
  session.onAutoStop = async () => {
    if (!drill.recording || drill.session !== session) return;
    drill.recording = false;
    render();
    finishRecording(await session.stop());
  };

  await session.start();
  drill.starting = false;
  drill.recording = session.active;
  if (drill.recording && !session.recognitionStarted) {
    drill.liveText = '正在录音…说完会自动结束，也可以点按钮提前结束';
  }
  render();
}

function finishRecording(raw) {
  const current = currentSentence();
  if (!current) return;
  const { sentence } = current;
  const settings = store.getSettings();

  const result = {
    audioUrl: raw.audioUrl,
    recordingEmpty: raw.recordingEmpty,
    transcript: raw.transcript,
    hasScore: false,
    reasonText: '',
  };

  if (settings.autoScore && raw.usedRecognition) {
    if (raw.transcript) {
      const scored = scorePronunciation(sentence.en, raw.transcript);
      Object.assign(result, {
        hasScore: true,
        score: scored.score,
        words: scored.words,
        extra: scored.extra,
        missed: scored.missed,
      });
      store.recordAttempt({
        sentenceId: sentence.id,
        sourceId: sentence.courseId,
        score: scored.score,
      });
      toast(`本次得分 ${scored.score} 分`);
    } else {
      result.reasonText = raw.errorMessage
        ?? '没有识别到内容，请靠近麦克风、在安静环境里再读一遍。';
      toast(result.reasonText);
    }
  } else if (raw.errorCode) {
    result.reasonText = raw.errorMessage;
    toast(raw.errorMessage);
  } else {
    result.reasonText = '已录音，可以回听自己的发音并和原声对比。';
  }

  drill.result = result;
  drill.liveText = '';
  drill.session = null;
  drill.recording = false;
  render();
}

function goRelative(step) {
  const current = currentSentence();
  if (!current) return;
  const nextIndex = Math.min(
    Math.max(0, current.index + step),
    current.course.sentences.length - 1,
  );
  navigate(`drill/${current.course.id}/${nextIndex}`);
}

/* ------------------------------- 设置与数据 ------------------------------- */

function handleExport() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `enshadow-${dateKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已导出备份文件');
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = store.importJSON(String(reader.result ?? ''));
    if (!result.ok) {
      toast(`导入失败：${result.error}`);
      return;
    }
    toast(`导入完成：新增 ${result.addedCustom} 句、${result.addedHistory} 条记录`);
    render();
  };
  reader.onerror = () => toast('读取文件失败');
  reader.readAsText(file);
}

function submitCustomForm() {
  const en = document.getElementById('customEn')?.value.trim() ?? '';
  const zh = document.getElementById('customZh')?.value.trim() ?? '';
  const courseId = document.getElementById('customCourse')?.value ?? MY_COURSE.id;
  if (!en) {
    toast('请先填写英文句子');
    return;
  }
  if (editingCustomId) {
    store.updateCustom(editingCustomId, { en, zh, courseId });
    toast('已保存修改');
  } else {
    store.addCustom({ en, zh, courseId });
    toast('已添加句子');
  }
  editingCustomId = null;
  render();
}

/* ------------------------------- 事件处理 ------------------------------- */

function handleAction(action, el) {
  switch (action) {
    case 'nav':
      navigate(el.dataset.path ?? 'practice');
      break;
    case 'open-course':
      navigate(`course/${el.dataset.course}`);
      break;
    case 'open-drill':
      navigate(`drill/${el.dataset.course}/${el.dataset.index}`);
      break;
    case 'back-to-course':
      navigate(`course/${el.dataset.course}`);
      break;
    case 'jump-drill': {
      const course = findCourse(el.dataset.course);
      if (!course) return;
      const index = course.sentences.findIndex((s) => s.id === el.dataset.id);
      if (index < 0) return;
      navigate(`drill/${course.id}/${index}`);
      break;
    }
    case 'play':
      handlePlay();
      break;
    case 'record-toggle':
      toggleRecording();
      break;
    case 'retry':
      releaseAudio();
      drill.result = null;
      drill.liveText = '';
      render();
      break;
    case 'next':
      goRelative(1);
      break;
    case 'set-rate':
      store.updateSettings({ rate: Number(el.dataset.rate) });
      render();
      break;
    case 'range':
      recordRange = Number(el.dataset.days) === 30 ? 30 : 7;
      render();
      break;
    case 'toggle-autoscore':
      store.updateSettings({ autoScore: !store.getSettings().autoScore });
      render();
      break;
    case 'export':
      handleExport();
      break;
    case 'import':
      document.getElementById('importFile')?.click();
      break;
    case 'reset':
      if (window.confirm('确定清空全部练习记录和自建句子吗？此操作不可恢复，建议先导出备份。')) {
        store.reset();
        toast('已清空');
        render();
      }
      break;
    case 'edit-custom':
      editingCustomId = el.dataset.id ?? null;
      render();
      break;
    case 'cancel-edit':
      editingCustomId = null;
      render();
      break;
    case 'delete-custom':
      if (window.confirm('删除这句自建句子？')) {
        store.removeCustom(el.dataset.id);
        if (editingCustomId === el.dataset.id) editingCustomId = null;
        toast('已删除');
        render();
      }
      break;
    case 'install':
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt = null;
      } else {
        toast('请用浏览器菜单里的「添加到主屏幕」');
      }
      break;
    default:
      break;
  }
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  handleAction(el.dataset.action, el);
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'importFile') {
    handleImportFile(el.files?.[0]);
    el.value = '';
    return;
  }
  if (el.id === 'goalInput') {
    store.updateSettings({ dailyGoal: Number(el.value) });
    toast('已更新每日目标');
    render();
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.closest('[data-action="custom-submit"]')) {
    event.preventDefault();
    submitCustomForm();
  }
});

window.addEventListener('hashchange', () => {
  const route = parseRoute();
  if (route.name !== 'drill') {
    if (drill.session) drill.session.cancel();
    drill.session = null;
    drill.recording = false;
    drill.starting = false;
    drill.liveText = '';
    releaseAudio();
    drill.result = null;
  }
  if (route.name !== 'me') editingCustomId = null;
  stopSpeaking();
  render();
  window.scrollTo({ top: 0 });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  render();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  toast('已添加到主屏幕');
  render();
});

/* --------------------------------- 启动 --------------------------------- */

if (!location.hash) location.hash = '#/practice';
primeVoices().then((voices) => {
  voiceState.checked = true;
  voiceState.englishCount = voices.length;
  if (caps.tts && !voices.length) toast('设备里没有英语语音，建议先在系统设置中安装英语语音');
  render();
});
render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 离线缓存不可用不影响主流程 */
    });
  });
}
