// ============================================================
// 教學進度追蹤 PWA — Main Application
// ============================================================

(function () {
  'use strict';

  // ============ CONSTANTS ============
  const DAYS = { '週一': 1, '週二': 2, '週三': 3, '週四': 4, '週五': 5 };
  const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  const GIST_API = 'https://api.github.com/gists';
  const LS_KEYS = {
    token: 'tp_token',
    planGistId: 'tp_plan_gist_id',
    progressGistId: 'tp_progress_gist_id',
    plan: 'tp_plan',
    progress: 'tp_progress',
    lastSync: 'tp_last_sync',
    selectedClass: 'tp_selected_class',
    currentView: 'tp_current_view',
    expandedLessons: 'tp_expanded'
  };

  // ============ STATE ============
  let state = {
    token: '',
    planGistId: '',
    progressGistId: '',
    plan: null,
    progress: null,
    lessons: {},        // { className: [lesson, ...] }
    currentView: 'today',
    selectedClass: null,
    expandedLessons: new Set(),
    isLoading: false,
    isDirty: false,
    saveTimer: null
  };

  // ============ DOM REFS ============
  const $ = id => document.getElementById(id);

  // ============ UTILITIES ============
  function lsGet(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }


  function today() {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }
  function fmtDate(d) {
    if (typeof d === 'string') d = new Date(d + 'T00:00:00');
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDisplay(d) {
    if (typeof d === 'string') d = new Date(d + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
  }
  function fmtFull(d) {
    if (typeof d === 'string') d = new Date(d + 'T00:00:00');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 週${DAY_NAMES[d.getDay()]}`;
  }
  function dayOfWeek(d) {
    if (typeof d === 'string') d = new Date(d + 'T00:00:00');
    return d.getDay();
  }
  function addDays(d, n) {
    const r = new Date(d); r.setDate(r.getDate() + n); return r;
  }
  function parseDate(s) {
    if (s instanceof Date) return s;
    return new Date(s + 'T00:00:00');
  }
  function isSameDay(a, b) {
    return fmtDate(a) === fmtDate(b);
  }
  function weekNum(d) {
    const start = new Date(d.getFullYear(), 0, 1);
    const diff = (d - start + ((start.getTimezoneOffset() - d.getTimezoneOffset()) * 60000)) / 86400000;
    return Math.ceil((diff + start.getDay() + 1) / 7);
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function toast(msg, type = 'info') {
    const c = $('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ============ DATA: HOLIDAY & EXAM SETS ============
  function buildHolidaySet() {
    const set = new Set();
    if (!state.plan?.school_calendar) return set;
    const allHolidays = [
      ...(state.plan.school_calendar.semester1_holidays || []),
      ...(state.plan.school_calendar.semester2_holidays || [])
    ];
    for (const h of allHolidays) {
      const raw = h.date;
      if (raw.includes('~')) {
        const [startStr, endPart] = raw.split('~');
        const start = parseDate(startStr.trim());
        const endParts = endPart.trim().split('-');
        const end = endParts.length === 3
          ? parseDate(endPart.trim())
          : parseDate(`${start.getFullYear()}-${endPart.trim()}`);
        for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
          set.add(fmtDate(d));
        }
      } else {
        set.add(fmtDate(parseDate(raw)));
      }
    }
    return set;
  }

  function buildExamRanges() {
    const ranges = [];
    if (!state.plan?.school_calendar) return ranges;
    const allTests = [
      ...(state.plan.school_calendar.semester1_tests || []),
      ...(state.plan.school_calendar.semester2_tests || [])
    ];
    for (const t of allTests) {
      if (t.period && t.period.includes('~')) {
        const [s, e] = t.period.split('~');
        ranges.push({ start: parseDate(s.trim()), end: parseDate(e.trim()), event: t.event });
      }
    }
    return ranges;
  }

  function isHoliday(dateStr, holidaySet) {
    return holidaySet.has(dateStr);
  }

  function isExamDay(dateStr, examRanges) {
    const d = parseDate(dateStr);
    return examRanges.some(r => d >= r.start && d <= r.end);
  }

  // ============ DATA: TEACHING CONTENT FLATTENING ============
  function flattenContent(className, semester) {
    const tc = state.plan?.teaching_content;
    if (!tc) return [];
    const level = className.startsWith('高一') ? '高一乙'
      : className.startsWith('高二') ? '高二甲'
        : className.startsWith('初二') ? '初二'
          : '初三';
    const semData = tc[level]?.[semester];
    if (!semData?.chapters) {
      return [{ label: '(待補)', chapter: '', section: '' }];
    }
    const result = [];
    for (const ch of semData.chapters) {
      if (ch.extra) {
        result.push({ label: ch.extra, chapter: '', section: '' });
        continue;
      }
      if (ch.sections && ch.sections.length > 0) {
        for (const sec of ch.sections) {
          result.push({ label: `${ch.topic} — ${sec}`, chapter: ch.topic, section: sec });
        }
      } else {
        result.push({ label: `第${ch.ch}章 ${ch.topic}`, chapter: ch.topic, section: '' });
      }
    }
    if (semData.extra) {
      for (const e of semData.extra) {
        result.push({ label: e, chapter: '', section: '' });
      }
    }
    return result.length > 0 ? result : [{ label: '(待補)', chapter: '', section: '' }];
  }

  // ============ DATA: LESSON SLOT GENERATION ============
  function generateLessonSlots() {
    if (!state.plan) return;
    const holidaySet = buildHolidaySet();
    const examRanges = buildExamRanges();
    const sem1Start = parseDate('2026-09-01');
    const sem1End = parseDate('2027-01-23');
    const sem2Start = parseDate('2027-02-03');
    const sem2End = parseDate('2027-07-07');

    const allLessons = {};

    for (const [className, info] of Object.entries(state.plan.schedule)) {
      const slots = info.weekly_slots || [];
      if (slots.length === 0) continue;

      const slotDayNums = slots.map(s => DAYS[s.day]).sort((a, b) => a - b);
      const slotsByDay = {};
      for (const s of slots) {
        const dn = DAYS[s.day];
        if (!slotsByDay[dn]) slotsByDay[dn] = [];
        slotsByDay[dn].push(s);
      }

      const content1 = flattenContent(className, 'semester1');
      const content2 = flattenContent(className, 'semester2');
      const lessons = [];
      let idx1 = 0, idx2 = 0;
      let shift1 = 0, shift2 = 0;

      // Get existing shift counts from progress
      const prog = state.progress?.classes?.[className];
      if (prog?.semester1?.shift_count) shift1 = prog.semester1.shift_count;
      if (prog?.semester2?.shift_count) shift2 = prog.semester2.shift_count;

      // Generate semester 1
      for (let d = new Date(sem1Start); d <= sem1End; d = addDays(d, 1)) {
        const dow = dayOfWeek(d);
        if (!slotDayNums.includes(dow)) continue;
        const dateStr = fmtDate(d);
        if (isHoliday(dateStr, holidaySet)) continue;
        if (isExamDay(dateStr, examRanges)) continue;

        const daySlots = slotsByDay[dow];
        for (const slot of daySlots) {
          const contentIdx = idx1 + shift1;
          const content = content1[contentIdx % content1.length] || { label: '(待補)' };
          lessons.push({
            id: `${className}_s1_${idx1}`,
            class: className,
            semester: 'semester1',
            lessonNum: idx1 + 1,
            date: dateStr,
            dayOfWeek: DAY_NAMES[dow],
            time: slot.time,
            period: slot.period,
            topic: content.label,
            chapter: content.chapter,
            done: false,
            note: '',
            hw: null,
            postponed: false
          });
          idx1++;
        }
      }

      // Generate semester 2
      for (let d = new Date(sem2Start); d <= sem2End; d = addDays(d, 1)) {
        const dow = dayOfWeek(d);
        if (!slotDayNums.includes(dow)) continue;
        const dateStr = fmtDate(d);
        if (isHoliday(dateStr, holidaySet)) continue;
        if (isExamDay(dateStr, examRanges)) continue;

        const daySlots = slotsByDay[dow];
        for (const slot of daySlots) {
          const contentIdx = idx2 + shift2;
          const content = content2[contentIdx % content2.length] || { label: '(待補)' };
          lessons.push({
            id: `${className}_s2_${idx2}`,
            class: className,
            semester: 'semester2',
            lessonNum: idx2 + 1,
            date: dateStr,
            dayOfWeek: DAY_NAMES[dow],
            time: slot.time,
            period: slot.period,
            topic: content.label,
            chapter: content.chapter,
            done: false,
            note: '',
            hw: null,
            postponed: false
          });
          idx2++;
        }
      }

      allLessons[className] = lessons;
    }

    state.lessons = allLessons;
    mergeProgress();
  }

  // ============ DATA: MERGE PROGRESS INTO LESSONS ============
  function mergeProgress() {
    if (!state.progress?.classes) return;
    for (const [className, classData] of Object.entries(state.progress.classes)) {
      if (!state.lessons[className]) continue;
      for (const semKey of ['semester1', 'semester2']) {
        const semData = classData[semKey];
        if (!semData?.lessons) continue;
        for (const rec of semData.lessons) {
          const lesson = state.lessons[className].find(
            l => l.semester === semKey && l.lessonNum === rec.lesson
          );
          if (lesson) {
            lesson.done = rec.done || false;
            lesson.note = rec.note || '';
            lesson.hw = rec.hw || null;
            lesson.postponed = rec.postponed || false;
            if (rec.topic_override) lesson.topic = rec.topic_override;
          }
        }
      }
    }
  }

  // ============ DATA: SAVE PROGRESS ============
  function markDirty() {
    state.isDirty = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveProgress(), 2000);
  }

  function buildProgressData() {
    const progress = { _meta: state.progress?._meta || {}, classes: {} };
    progress._meta.version = '1.0';
    progress._meta.last_modified = new Date().toISOString();

    for (const [className, lessons] of Object.entries(state.lessons)) {
      const classData = {};
      for (const semKey of ['semester1', 'semester2']) {
        const semLessons = lessons.filter(l => l.semester === semKey);
        const shiftCount = state.progress?.classes?.[className]?.[semKey]?.shift_count || 0;
        classData[semKey] = {
          shift_count: shiftCount,
          lessons: semLessons
            .filter(l => l.done || l.note || l.hw || l.postponed || l.topic !== getOriginalTopic(l))
            .map(l => ({
              lesson: l.lessonNum,
              date: l.date,
              done: l.done,
              note: l.note || undefined,
              hw: l.hw || undefined,
              postponed: l.postponed || undefined,
              topic_override: l.topic !== getOriginalTopic(l) ? l.topic : undefined
            }))
        };
      }
      progress.classes[className] = classData;
    }
    return progress;
  }

  function getOriginalTopic(lesson) {
    const content1 = flattenContent(lesson.class, 'semester1');
    const content2 = flattenContent(lesson.class, 'semester2');
    const content = lesson.semester === 'semester1' ? content1 : content2;
    const idx = lesson.lessonNum - 1;
    return content[idx]?.label || '(待補)';
  }

  // ============ API: GIST ============
  function headers() {
    return {
      'Authorization': `token ${state.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  async function apiLoadPlan() {
    if (!state.planGistId) throw new Error('缺少 plan Gist ID');
    const res = await fetch(`${GIST_API}/${state.planGistId}`, { headers: headers() });
    if (!res.ok) throw new Error(`載入 plan 失敗: ${res.status}`);
    const gist = await res.json();
    const file = Object.values(gist.files)[0];
    state.plan = JSON.parse(file.content);
    lsSet(LS_KEYS.plan, state.plan);
    return state.plan;
  }

  async function apiLoadProgress() {
    if (!state.progressGistId) return initEmptyProgress();
    try {
      const res = await fetch(`${GIST_API}/${state.progressGistId}`, { headers: headers() });
      if (!res.ok) throw new Error(`${res.status}`);
      const gist = await res.json();
      const file = Object.values(gist.files)[0];
      state.progress = JSON.parse(file.content);
    } catch {
      state.progress = initEmptyProgress();
    }
    lsSet(LS_KEYS.progress, state.progress);
    return state.progress;
  }

  function initEmptyProgress() {
    state.progress = { _meta: { version: '1.0', created: new Date().toISOString() }, classes: {} };
    return state.progress;
  }

  async function apiSaveProgress() {
    const data = buildProgressData();
    state.progress = data;
    lsSet(LS_KEYS.progress, data);

    if (!state.progressGistId) {
      const res = await fetch(GIST_API, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({
          description: 'Teaching Progress Data (Private)',
          public: false,
          files: { 'progress.json': { content: JSON.stringify(data, null, 2) } }
        })
      });
      if (!res.ok) throw new Error(`建立 Gist 失敗: ${res.status}`);
      const gist = await res.json();
      state.progressGistId = gist.id;
      lsSet(LS_KEYS.progressGistId, gist.id);
    } else {
      const res = await fetch(`${GIST_API}/${state.progressGistId}`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({
          files: { 'progress.json': { content: JSON.stringify(data, null, 2) } }
        })
      });
      if (!res.ok) throw new Error(`儲存失敗: ${res.status}`);
    }
    state.isDirty = false;
    lsSet(LS_KEYS.lastSync, new Date().toISOString());
  }

  const saveProgress = debounce(async () => {
    try { await apiSaveProgress(); toast('已同步', 'success'); }
    catch (e) { toast('同步失敗: ' + e.message, 'error'); }
  }, 2000);

  async function apiVerifyToken(token) {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    return res.ok;
  }

  async function apiCreatePlanGist(planData) {
    const res = await fetch(GIST_API, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        description: 'Teaching Plan Data (Private)',
        public: false,
        files: { 'plan.json': { content: JSON.stringify(planData, null, 2) } }
      })
    });
    if (!res.ok) throw new Error(`建立 Gist 失敗: ${res.status}`);
    const gist = await res.json();
    state.planGistId = gist.id;
    lsSet(LS_KEYS.planGistId, gist.id);
    return gist.id;
  }

  async function apiLoadPlanFromFile() {
    const res = await fetch('./raw_data/plan.json');
    if (!res.ok) throw new Error('無法載入本地 plan.json');
    return await res.json();
  }

  // ============ DATA: CLASS STATS ============
  function getClassStats(className) {
    const lessons = state.lessons[className] || [];
    const td = today();
    const total = lessons.length;
    const done = lessons.filter(l => l.done).length;
    const current = lessons.find(l => !l.done);
    const overdue = lessons.filter(l => !l.done && parseDate(l.date) < td).length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    const expectedDone = lessons.filter(l => parseDate(l.date) <= td).length;
    const diff = done - expectedDone;
    let status = 'ok';
    if (diff < -1) status = 'behind';
    else if (diff > 1) status = 'ahead';
    return { total, done, overdue, pct, current, expectedDone, diff, status };
  }

  function getTodayLessons() {
    const td = fmtDate(today());
    const result = [];
    for (const lessons of Object.values(state.lessons)) {
      for (const l of lessons) {
        if (l.date === td) result.push(l);
      }
    }
    return result.sort((a, b) => a.time.localeCompare(b.time));
  }

  function getWeekLessons() {
    const td = today();
    const dow = td.getDay();
    const weekStart = addDays(td, -((dow + 6) % 7));
    const weekEnd = addDays(weekStart, 6);
    const result = [];
    for (const lessons of Object.values(state.lessons)) {
      for (const l of lessons) {
        const ld = parseDate(l.date);
        if (ld >= weekStart && ld <= weekEnd) result.push(l);
      }
    }
    return result.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : a.time.localeCompare(b.time);
    });
  }

  function getCurrentSemester() {
    const m = today().getMonth();
    return m >= 7 || m === 0 ? 'semester1' : 'semester2';
  }

  // ============ UI: NAVIGATION ============
  function switchView(view) {
    state.currentView = view;
    lsSet(LS_KEYS.currentView, view);
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('hidden', p.id !== `view-${view}`));
    renderCurrentView();
  }

  function selectClass(className) {
    state.selectedClass = className;
    lsSet(LS_KEYS.selectedClass, className);
    document.querySelectorAll('.class-item').forEach(el =>
      el.classList.toggle('active', el.dataset.class === className)
    );
    renderCurrentView();
  }

  // ============ UI: RENDER ALL ============
  function renderCurrentView() {
    switch (state.currentView) {
      case 'today': renderToday(); break;
      case 'week': renderWeek(); break;
      case 'compare': renderCompare(); break;
      case 'calendar': renderCalendar(); break;
      case 'settings': renderSettings(); break;
    }
  }

  function renderAll() {
    renderSidebar();
    renderCurrentView();
    updateHeaderDate();
  }

  // ============ UI: HEADER ============
  function updateHeaderDate() {
    const el = $('header-date');
    if (el) el.textContent = fmtFull(today());
  }

  // ============ UI: SIDEBAR ============
  function renderSidebar() {
    const el = $('sidebar-classes');
    if (!el || !state.plan) return;
    const classes = Object.keys(state.plan.schedule);
    let html = '';
    let currentLevel = '';
    for (const cls of classes) {
      const info = state.plan.schedule[cls];
      if (info.level !== currentLevel) {
        currentLevel = info.level;
        html += `<h3>${currentLevel}</h3>`;
      }
      const stats = getClassStats(cls);
      const badgeClass = stats.status === 'ok' ? 'badge-ok' : stats.status === 'behind' ? 'badge-behind' : 'badge-ahead';
      const badgeText = stats.status === 'ok' ? '正常' : stats.status === 'behind' ? `落後${Math.abs(stats.diff)}` : `領先${stats.diff}`;
      html += `
        <div class="class-item ${state.selectedClass === cls ? 'active' : ''}" data-class="${cls}">
          <span>${cls}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.class-item').forEach(item => {
      item.addEventListener('click', () => selectClass(item.dataset.class));
    });
  }

  // ============ UI: TODAY VIEW ============
  function renderToday() {
    const container = $('today-content');
    if (!container) return;
    const todayLessons = getTodayLessons();
    const td = today();

    // Stats
    const allLessons = Object.entries(state.lessons);
    let totalDone = 0, totalOverdue = 0, todayDone = 0;
    for (const [_, lessons] of allLessons) {
      for (const l of lessons) {
        if (l.done) totalDone++;
        if (!l.done && parseDate(l.date) < td) totalOverdue++;
      }
    }
    todayDone = todayLessons.filter(l => l.done).length;

    $('stat-total-done').textContent = totalDone;
    $('stat-overdue').textContent = totalOverdue;
    $('stat-today').textContent = `${todayDone}/${todayLessons.length}`;

    if (todayLessons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📅</div>
          <h3>今天沒有課堂</h3>
          <p>切換到「本週課表」查看本週安排</p>
        </div>`;
      return;
    }

    container.innerHTML = todayLessons.map(l => renderLessonCard(l, true)).join('');
    bindLessonCardEvents(container);
  }

  // ============ UI: WEEK VIEW ============
  function renderWeek() {
    const container = $('week-content');
    if (!container) return;
    const weekLessons = getWeekLessons();
    const td = fmtDate(today());

    if (weekLessons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📅</div>
          <h3>本週沒有課堂</h3>
        </div>`;
      return;
    }

    const grouped = {};
    for (const l of weekLessons) {
      if (!grouped[l.date]) grouped[l.date] = [];
      grouped[l.date].push(l);
    }

    let html = '';
    for (const [date, lessons] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
      const isToday = date === td;
      html += `<div style="margin-bottom:24px">`;
      html += `<div style="font-size:14px;font-weight:600;color:${isToday ? 'var(--primary)' : 'var(--gray-600)'};margin-bottom:8px;padding-left:4px">
        ${fmtDisplay(date)}${isToday ? ' (今天)' : ''}
      </div>`;
      html += lessons.map(l => renderLessonCard(l, false)).join('');
      html += `</div>`;
    }
    container.innerHTML = html;
    bindLessonCardEvents(container);
  }

  // ============ UI: LESSON CARD ============
  function renderLessonCard(l) {
    const td = today();
    const ld = parseDate(l.date);
    let statusClass = '';
    if (l.done) statusClass = 'completed';
    else if (isSameDay(ld, td)) statusClass = 'today';
    else if (ld < td) statusClass = 'overdue';
    if (l.postponed) statusClass += ' shifted';

    const isExpanded = state.expandedLessons.has(l.id);
    const stats = getClassStats(l.class);
    const statusBadge = stats.status === 'ok' ? '' : `<span class="badge ${stats.status === 'behind' ? 'badge-behind' : 'badge-ahead'}" style="font-size:11px;margin-left:8px">${stats.status === 'behind' ? '落後' : '領先'}</span>`;

    return `
      <div class="lesson-card ${statusClass}" data-id="${l.id}" data-class="${l.class}">
        <div class="lesson-header">
          <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
            <button class="check-btn ${l.done ? 'checked' : ''}" data-id="${l.id}" title="打卡">✓</button>
            <div style="min-width:0">
              <div class="lesson-class">${l.class}${statusBadge}</div>
              <div class="lesson-meta">
                <span>第${l.lessonNum}節</span>
                <span>${l.dayOfWeek} ${l.time}</span>
                ${l.postponed ? '<span style="color:var(--warning)">⏸ 已延期</span>' : ''}
              </div>
            </div>
          </div>
          <button class="btn btn-sm btn-outline expand-btn" data-id="${l.id}">
            ${isExpanded ? '收合' : '展開'}
          </button>
        </div>
        <div class="lesson-topic" data-id="${l.id}">
          ${isExpanded
            ? `<input type="text" value="${escHtml(l.topic)}" data-field="topic" data-id="${l.id}" placeholder="輸入教學主題">`
            : `<span>${escHtml(l.topic)}</span>`
          }
        </div>
        ${l.note || isExpanded ? `
          <div class="lesson-note" data-id="${l.id}">
            ${isExpanded
              ? `<textarea data-field="note" data-id="${l.id}" placeholder="課後備註...">${escHtml(l.note)}</textarea>`
              : `<span>${l.note ? '📝 ' + escHtml(l.note) : '點擊新增備註...'}</span>`
            }
          </div>` : ''}
        ${l.hw ? `<div class="lesson-hw">📋 ${escHtml(typeof l.hw === 'string' ? l.hw : l.hw.topic || '')}</div>` : ''}
        ${isExpanded ? `
          <div class="lesson-actions">
            <button class="btn btn-sm btn-outline post-btn" data-id="${l.id}" ${l.done ? 'disabled' : ''}>⏸ 延期</button>
            <button class="btn btn-sm btn-outline shift-btn" data-id="${l.id}">⏩ 順延</button>
            <button class="btn btn-sm btn-outline hw-btn" data-id="${l.id}">📋 作業</button>
          </div>` : ''}
      </div>`;
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function bindLessonCardEvents(container) {
    container.querySelectorAll('.check-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleDone(btn.dataset.id);
      });
    });
    container.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleExpand(btn.dataset.id));
    });
    container.querySelectorAll('.post-btn').forEach(btn => {
      btn.addEventListener('click', () => postponeLesson(btn.dataset.id));
    });
    container.querySelectorAll('.shift-btn').forEach(btn => {
      btn.addEventListener('click', () => autoShift(btn.dataset.id));
    });
    container.querySelectorAll('.hw-btn').forEach(btn => {
      btn.addEventListener('click', () => openHwModal(btn.dataset.id));
    });
    container.querySelectorAll('input[data-field="topic"]').forEach(inp => {
      inp.addEventListener('change', () => updateTopic(inp.dataset.id, inp.value));
    });
    container.querySelectorAll('textarea[data-field="note"]').forEach(ta => {
      ta.addEventListener('change', () => updateNote(ta.dataset.id, ta.value));
    });
    container.querySelectorAll('.lesson-note').forEach(el => {
      if (!el.querySelector('textarea')) {
        el.addEventListener('click', () => {
          toggleExpand(el.dataset.id, true);
        });
      }
    });
  }

  // ============ UI: COMPARE VIEW ============
  function renderCompare() {
    const container = $('compare-content');
    if (!container) return;
    const classes = Object.keys(state.lessons);

    let html = '<div class="comparison-grid">';
    for (const cls of classes) {
      const stats = getClassStats(cls);
      const barColor = stats.pct >= 70 ? 'var(--success)' : stats.pct >= 40 ? 'var(--warning)' : 'var(--danger)';
      const currentTopic = stats.current ? escHtml(stats.current.topic) : '—';
      html += `
        <div class="compare-card" data-class="${cls}">
          <div class="class-name">${cls}</div>
          <div class="class-level">${state.plan.schedule[cls].level} · ${state.plan.schedule[cls].periods_per_week}堂/週</div>
          <div class="progress-bar">
            <div class="progress-bar-fill" style="width:${stats.pct}%;background:${barColor}"></div>
          </div>
          <div style="font-size:12px;color:var(--gray-500);display:flex;justify-content:space-between;margin-top:4px">
            <span>${stats.done}/${stats.total} 完成</span>
            <span>${stats.pct}%</span>
          </div>
          <div style="font-size:13px;color:var(--gray-600);margin-top:12px;padding:8px;background:var(--gray-50);border-radius:8px">
            <div style="font-size:11px;color:var(--gray-400);margin-bottom:2px">目前進度</div>
            ${currentTopic}
          </div>
          <div class="compare-stats">
            <div class="stat-item">
              <div class="stat-value" style="color:var(--success)">${stats.done}</div>
              <div class="stat-label">已完成</div>
            </div>
            <div class="stat-item">
              <div class="stat-value" style="color:var(--danger)">${stats.overdue}</div>
              <div class="stat-label">逾期</div>
            </div>
            <div class="stat-item">
              <div class="stat-value">${stats.total - stats.done}</div>
              <div class="stat-label">剩餘</div>
            </div>
          </div>
          <button class="btn btn-sm btn-outline btn-block" style="margin-top:12px" onclick="window.TP.selectClass('${cls}');window.TP.switchView('today')">查看詳細</button>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  }

  // ============ UI: CALENDAR VIEW ============
  function renderCalendar() {
    const sel = $('cal-class-select');
    const container = $('calendar-content');
    if (!sel || !container) return;

    // Populate class select
    const classes = Object.keys(state.lessons);
    sel.innerHTML = classes.map(c => `<option value="${c}" ${c === state.selectedClass ? 'selected' : ''}>${c}</option>`).join('');

    const cls = sel.value;
    if (!cls) { container.innerHTML = '<div class="empty-state"><p>選擇班級</p></div>'; return; }

    const lessons = state.lessons[cls] || [];
    const sem = getCurrentSemester();
    const semLessons = lessons.filter(l => l.semester === sem);
    const td = fmtDate(today());

    if (semLessons.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>此學期暫無課程</p></div>';
      return;
    }

    // Group by week
    const weeks = {};
    for (const l of semLessons) {
      const d = parseDate(l.date);
      const wKey = `${d.getFullYear()}-W${String(weekNum(d)).padStart(2, '0')}`;
      if (!weeks[wKey]) weeks[wKey] = [];
      weeks[wKey].push(l);
    }

    let html = '';
    for (const [wKey, wLessons] of Object.entries(weeks)) {
      html += `<div style="margin-bottom:16px">`;
      html += `<div style="font-size:12px;font-weight:600;color:var(--gray-400);margin-bottom:6px">${wKey}</div>`;
      html += `<div class="calendar-grid">`;

      const weekStart = parseDate(wLessons[0].date);
      const startDow = (dayOfWeek(weekStart) + 6) % 7; // Mon=0
      for (let i = 0; i < 5; i++) {
        const d = addDays(weekStart, i - startDow);
        const dateStr = fmtDate(d);
        const isToday = dateStr === td;
        const dayLessons = wLessons.filter(l => l.date === dateStr);
        html += `<div class="cal-day ${isToday ? 'today' : ''}">`;
        html += `<div class="cal-day-header">
          <span>${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})</span>
        </div>`;
        if (dayLessons.length > 0) {
          html += dayLessons.map(l => {
            const cls2 = l.done ? 'done' : (parseDate(l.date) < today() && !l.done ? 'overdue' : 'pending');
            return `<div class="cal-lesson ${cls2}" title="${escHtml(l.topic)}" data-id="${l.id}">
              ${l.done ? '✅' : '⬜'} ${escHtml(l.topic.substring(0, 15))}${l.topic.length > 15 ? '...' : ''}
            </div>`;
          }).join('');
        }
        html += `</div>`;
      }
      html += `</div></div>`;
    }
    container.innerHTML = html;
  }

  // ============ UI: SETTINGS VIEW ============
  function renderSettings() {
    const container = $('settings-content');
    if (!container) return;
    const hasToken = !!state.token;
    const hasPlanGist = !!state.planGistId;
    const hasProgressGist = !!state.progressGistId;
    const lastSync = lsGet(LS_KEYS.lastSync, '');

    container.innerHTML = `
      <div class="card settings-section">
        <h3>GitHub 連線狀態</h3>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="status-dot ${hasToken ? 'green' : 'red'}"></span>
            <span>Personal Access Token: ${hasToken ? '已設定' : '未設定'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="status-dot ${hasPlanGist ? 'green' : 'red'}"></span>
            <span>課程設定 Gist: ${hasPlanGist ? state.planGistId.substring(0, 8) + '...' : '未設定'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="status-dot ${hasProgressGist ? 'green' : 'yellow'}"></span>
            <span>進度紀錄 Gist: ${hasProgressGist ? state.progressGistId.substring(0, 8) + '...' : '首次儲存時自動建立'}</span>
          </div>
          ${lastSync ? `<div style="font-size:12px;color:var(--gray-400)">上次同步: ${new Date(lastSync).toLocaleString('zh-TW')}</div>` : ''}
        </div>
      </div>

      <div class="card settings-section">
        <h3>Token 設定</h3>
        <div class="form-group">
          <label>GitHub Personal Access Token</label>
          <input type="password" id="settings-token" value="${state.token}" placeholder="ghp_xxxxxxxxxxxx">
          <div class="hint">需要 <code>gist</code> 權限。<a href="https://github.com/settings/tokens/new?scopes=gist&description=Teaching+Progress+Tracker" target="_blank">點此建立 Token</a></div>
        </div>
        <div class="form-group">
          <label>課程設定 Gist ID</label>
          <input type="text" id="settings-plan-gist" value="${state.planGistId}" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
          <div class="hint">包含 plan.json 的 Secret Gist ID</div>
        </div>
        <button class="btn btn-primary" id="btn-save-settings">儲存設定</button>
        <button class="btn btn-outline" id="btn-test-connection" style="margin-left:8px">測試連線</button>
      </div>

      <div class="card settings-section">
        <h3>資料操作</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
          <button class="btn btn-outline" id="btn-force-sync">🔄 強制同步</button>
          <button class="btn btn-outline" id="btn-export-data">📤 匯出 JSON</button>
          <button class="btn btn-outline" id="btn-import-data">📥 匯入 JSON</button>
          <button class="btn btn-danger" id="btn-reset-progress">🗑 重設進度</button>
        </div>
        <input type="file" id="import-file" accept=".json" style="display:none">
      </div>

      <div class="card settings-section">
        <h3>多裝置同步教學</h3>
        <div style="font-size:14px;color:var(--gray-600);line-height:1.8">
          <p>1. 在每台裝置的瀏覽器開啟此 App</p>
          <p>2. 進入「設定」頁面，輸入同一組 Token 與 Gist ID</p>
          <p>3. 點擊「儲存設定」後即可自動同步</p>
          <p style="margin-top:8px;color:var(--gray-400);font-size:12px">💡 建議使用同一組 Token，資料透過 GitHub Gist 即時同步</p>
        </div>
      </div>`;

    // Bind events
    $('btn-save-settings')?.addEventListener('click', saveSettings);
    $('btn-test-connection')?.addEventListener('click', testConnection);
    $('btn-force-sync')?.addEventListener('click', forceSync);
    $('btn-export-data')?.addEventListener('click', exportData);
    $('btn-import-data')?.addEventListener('click', () => $('import-file')?.click());
    $('import-file')?.addEventListener('change', importData);
    $('btn-reset-progress')?.addEventListener('click', resetProgress);
  }

  // ============ ACTIONS ============
  function findLesson(id) {
    for (const lessons of Object.values(state.lessons)) {
      const l = lessons.find(x => x.id === id);
      if (l) return l;
    }
    return null;
  }

  function toggleDone(id) {
    const l = findLesson(id);
    if (!l) return;
    l.done = !l.done;
    markDirty();
    renderAll();
    toast(l.done ? `✅ ${l.class} 第${l.lessonNum}節已完成` : `已取消完成`, l.done ? 'success' : 'info');
  }

  function toggleExpand(id, forceOpen) {
    if (forceOpen || !state.expandedLessons.has(id)) {
      state.expandedLessons.add(id);
    } else {
      state.expandedLessons.delete(id);
    }
    renderCurrentView();
  }

  function updateTopic(id, value) {
    const l = findLesson(id);
    if (!l) return;
    l.topic = value;
    markDirty();
  }

  function updateNote(id, value) {
    const l = findLesson(id);
    if (!l) return;
    l.note = value;
    markDirty();
  }

  function postponeLesson(id) {
    const l = findLesson(id);
    if (!l || l.done) return;
    l.postponed = true;
    markDirty();
    renderAll();
    toast(`⏸ ${l.class} 第${l.lessonNum}節已延期`, 'warning');
  }

  function autoShift(id) {
    const l = findLesson(id);
    if (!l) return;
    const cls = l.class;
    const sem = l.semester;
    const lessons = state.lessons[cls].filter(x => x.semester === sem);
    const idx = lessons.indexOf(l);
    if (idx < 0) return;

    // Shift: mark this and all subsequent as needing re-schedule
    // Increment shift count
    if (!state.progress.classes[cls]) state.progress.classes[cls] = {};
    if (!state.progress.classes[cls][sem]) state.progress.classes[cls][sem] = {};
    const currentShift = state.progress.classes[cls][sem].shift_count || 0;
    state.progress.classes[cls][sem].shift_count = currentShift + 1;

    // Regenerate lessons for this class
    regenerateClassLessons(cls);
    markDirty();
    renderAll();
    toast(`⏩ ${cls} 已順延一節`, 'info');
  }

  function regenerateClassLessons(cls) {
    const info = state.plan.schedule[cls];
    if (!info) return;
    const holidaySet = buildHolidaySet();
    const examRanges = buildExamRanges();
    const sem1Start = parseDate('2026-09-01');
    const sem1End = parseDate('2027-01-23');
    const sem2Start = parseDate('2027-02-03');
    const sem2End = parseDate('2027-07-07');
    const slots = info.weekly_slots || [];
    const slotDayNums = slots.map(s => DAYS[s.day]).sort((a, b) => a - b);
    const slotsByDay = {};
    for (const s of slots) {
      const dn = DAYS[s.day];
      if (!slotsByDay[dn]) slotsByDay[dn] = [];
      slotsByDay[dn].push(s);
    }

    const content1 = flattenContent(cls, 'semester1');
    const content2 = flattenContent(cls, 'semester2');
    const lessons = [];
    const oldLessons = state.lessons[cls] || [];
    let idx1 = 0, idx2 = 0;
    const shift1 = state.progress.classes[cls]?.semester1?.shift_count || 0;
    const shift2 = state.progress.classes[cls]?.semester2?.shift_count || 0;

    for (let d = new Date(sem1Start); d <= sem1End; d = addDays(d, 1)) {
      const dow = dayOfWeek(d);
      if (!slotDayNums.includes(dow)) continue;
      const dateStr = fmtDate(d);
      if (isHoliday(dateStr, holidaySet)) continue;
      if (isExamDay(dateStr, examRanges)) continue;
      const daySlots = slotsByDay[dow];
      for (const slot of daySlots) {
        const contentIdx = idx1 + shift1;
        const content = content1[contentIdx % content1.length] || { label: '(待補)' };
        const id = `${cls}_s1_${idx1}`;
        const old = oldLessons.find(x => x.id === id);
        lessons.push({
          id, class: cls, semester: 'semester1', lessonNum: idx1 + 1,
          date: dateStr, dayOfWeek: DAY_NAMES[dow], time: slot.time, period: slot.period,
          topic: content.label, chapter: content.chapter,
          done: old?.done || false, note: old?.note || '', hw: old?.hw || null,
          postponed: old?.postponed || false
        });
        idx1++;
      }
    }

    for (let d = new Date(sem2Start); d <= sem2End; d = addDays(d, 1)) {
      const dow = dayOfWeek(d);
      if (!slotDayNums.includes(dow)) continue;
      const dateStr = fmtDate(d);
      if (isHoliday(dateStr, holidaySet)) continue;
      if (isExamDay(dateStr, examRanges)) continue;
      const daySlots = slotsByDay[dow];
      for (const slot of daySlots) {
        const contentIdx = idx2 + shift2;
        const content = content2[contentIdx % content2.length] || { label: '(待補)' };
        const id = `${cls}_s2_${idx2}`;
        const old = oldLessons.find(x => x.id === id);
        lessons.push({
          id, class: cls, semester: 'semester2', lessonNum: idx2 + 1,
          date: dateStr, dayOfWeek: DAY_NAMES[dow], time: slot.time, period: slot.period,
          topic: content.label, chapter: content.chapter,
          done: old?.done || false, note: old?.note || '', hw: old?.hw || null,
          postponed: old?.postponed || false
        });
        idx2++;
      }
    }

    state.lessons[cls] = lessons;
  }

  function openHwModal(id) {
    const l = findLesson(id);
    if (!l) return;
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    const title = $('modal-title');
    title.textContent = `${l.class} 第${l.lessonNum}節 — 作業`;
    const hwData = typeof l.hw === 'object' ? l.hw : (l.hw ? { topic: l.hw } : {});
    body.innerHTML = `
      <div class="form-group">
        <label>作業主題</label>
        <input type="text" id="hw-topic" value="${escHtml(hwData.topic || '')}" placeholder="例: 課本 P.32 練習">
      </div>
      <div class="form-group">
        <label>繳交日期</label>
        <input type="date" id="hw-due" value="${hwData.due || ''}">
      </div>
      <div class="form-group">
        <label>備註</label>
        <textarea id="hw-note" rows="2" placeholder="作業要求...">${escHtml(hwData.note || '')}</textarea>
      </div>`;
    $('modal-footer').innerHTML = `
      <button class="btn btn-outline" id="modal-cancel">取消</button>
      <button class="btn btn-primary" id="modal-save-hw">儲存</button>`;
    overlay.classList.add('open');

    $('modal-save-hw').onclick = () => {
      const topic = $('hw-topic').value.trim();
      const due = $('hw-due').value;
      const note = $('hw-note').value.trim();
      l.hw = topic ? { topic, due, note } : null;
      markDirty();
      overlay.classList.remove('open');
      renderCurrentView();
      toast('作業已更新', 'success');
    };
    $('modal-cancel').onclick = () => overlay.classList.remove('open');
  }

  // ============ SETTINGS ACTIONS ============
  async function saveSettings() {
    const token = $('settings-token')?.value.trim();
    const gistId = $('settings-plan-gist')?.value.trim();
    if (token) {
      state.token = token;
      lsSet(LS_KEYS.token, token);
    }
    if (gistId) {
      state.planGistId = gistId;
      lsSet(LS_KEYS.planGistId, gistId);
    }
    toast('設定已儲存', 'success');
  }

  async function testConnection() {
    if (!state.token) { toast('請先輸入 Token', 'error'); return; }
    try {
      const valid = await apiVerifyToken(state.token);
      if (!valid) { toast('Token 無效', 'error'); return; }
      toast('Token 驗證成功 ✓', 'success');
      if (state.planGistId) {
        await apiLoadPlan();
        generateLessonSlots();
        renderAll();
        toast('Plan 載入成功 ✓', 'success');
      }
    } catch (e) {
      toast('連線失敗: ' + e.message, 'error');
    }
  }

  async function forceSync() {
    try {
      if (state.planGistId) await apiLoadPlan();
      if (state.progressGistId) await apiLoadProgress();
      generateLessonSlots();
      renderAll();
      toast('同步完成', 'success');
    } catch (e) {
      toast('同步失敗: ' + e.message, 'error');
    }
  }

  function exportData() {
    const data = {
      plan: state.plan,
      progress: buildProgressData(),
      exported: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teaching-progress-${fmtDate(today())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已匯出', 'success');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.plan) { state.plan = data.plan; lsSet(LS_KEYS.plan, data.plan); }
        if (data.progress) { state.progress = data.progress; lsSet(LS_KEYS.progress, data.progress); }
        generateLessonSlots();
        renderAll();
        toast('匯入成功', 'success');
      } catch (err) {
        toast('匯入失敗: 檔案格式錯誤', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function resetProgress() {
    if (!confirm('確定要重設所有進度？此操作不可復原。')) return;
    initEmptyProgress();
    generateLessonSlots();
    markDirty();
    renderAll();
    toast('進度已重設', 'warning');
  }

  // ============ SETUP FLOW ============
  async function handleSetup() {
    const token = $('setup-token')?.value.trim();
    const gistId = $('setup-gist-id')?.value.trim();

    if (!token) { toast('請輸入 GitHub Token', 'error'); return; }

    state.token = token;
    lsSet(LS_KEYS.token, token);

    try {
      const valid = await apiVerifyToken(token);
      if (!valid) { toast('Token 無效，請重新檢查', 'error'); return; }
      toast('Token 驗證成功 ✓', 'success');
    } catch (e) {
      toast('無法連線到 GitHub: ' + e.message, 'error');
      return;
    }

    if (gistId) {
      state.planGistId = gistId;
      lsSet(LS_KEYS.planGistId, gistId);
    }

    try {
      await apiLoadPlan();
      toast('課程設定載入成功', 'success');
    } catch {
      // Try loading from local file
      try {
        const localPlan = await apiLoadPlanFromFile();
        state.plan = localPlan;
        lsSet(LS_KEYS.plan, localPlan);
        // Create Gist
        const newGistId = await apiCreatePlanGist(localPlan);
        toast(`已建立課程設定 Gist: ${newGistId.substring(0, 8)}...`, 'success');
      } catch (e2) {
        toast('無法載入課程設定: ' + e2.message, 'error');
        return;
      }
    }

    try {
      await apiLoadProgress();
    } catch {
      initEmptyProgress();
    }

    generateLessonSlots();
    showApp();
  }

  // ============ INIT ============
  function showApp() {
    $('setup-screen').style.display = 'none';
    $('app-screen').style.display = 'block';
    renderAll();
  }

  function showSetup() {
    $('setup-screen').style.display = 'flex';
    $('app-screen').style.display = 'none';
    if (state.token) $('setup-token').value = state.token;
    if (state.planGistId) $('setup-gist-id').value = state.planGistId;
  }

  async function init() {
    // Load from localStorage
    state.token = lsGet(LS_KEYS.token, '');
    state.planGistId = lsGet(LS_KEYS.planGistId, '');
    state.progressGistId = lsGet(LS_KEYS.progressGistId, '');
    state.currentView = lsGet(LS_KEYS.currentView, 'today');
    state.selectedClass = lsGet(LS_KEYS.selectedClass, null);
    const expanded = lsGet(LS_KEYS.expandedLessons, []);
    state.expandedLessons = new Set(expanded);

    // Try cached data first
    const cachedPlan = lsGet(LS_KEYS.plan);
    const cachedProgress = lsGet(LS_KEYS.progress);
    if (cachedPlan) state.plan = cachedPlan;
    if (cachedProgress) state.progress = cachedProgress;

    // If we have token and plan, try to load
    if (state.token && state.plan) {
      try {
        generateLessonSlots();
        showApp();
        // Background sync
        try {
          await apiLoadPlan();
          if (state.progressGistId) await apiLoadProgress();
          generateLessonSlots();
          renderAll();
        } catch { }
      } catch {
        showSetup();
      }
    } else if (state.token) {
      // Have token but no plan — try loading
      try {
        if (state.planGistId) {
          await apiLoadPlan();
          await apiLoadProgress();
          generateLessonSlots();
          showApp();
        } else {
          showSetup();
        }
      } catch {
        showSetup();
      }
    } else {
      showSetup();
    }

    // Bind setup button
    $('btn-setup')?.addEventListener('click', handleSetup);

    // Bind nav tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Bind calendar class select
    $('cal-class-select')?.addEventListener('change', renderCalendar);

    // Bind modal close
    $('modal-close')?.addEventListener('click', () => $('modal-overlay')?.classList.remove('open'));
    $('modal-overlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
    });

    // Bind auto-sync on visibility change
    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden && state.token && state.plan) {
        try {
          if (state.progressGistId) await apiLoadProgress();
          generateLessonSlots();
          renderAll();
        } catch { }
      }
    });

    // Register SW
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('./sw.js'); } catch { }
    }

    // Set active nav tab
    document.querySelectorAll('.nav-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.view === state.currentView)
    );
  }

  // Expose for inline onclick handlers
  window.TP = { selectClass, switchView };

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();