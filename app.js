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
    saveTimer: null,
    calendarMonth: null,  // { year, month } for calendar view
    weekOffset: 0,        // 0 = current week, -1 = last week, 1 = next week
    dayOffset: 0          // 0 = today, -1 = yesterday, 1 = tomorrow
  };

  // Class colors for calendar
  const CLASS_COLORS = {
    '初二甲': '#3b82f6', '初二乙': '#8b5cf6',
    '初三甲': '#10b981', '初三乙': '#14b8a6',
    '高一乙': '#f59e0b', '高二甲': '#ef4444'
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
        let end;
        if (endParts.length === 3) {
          end = parseDate(endPart.trim());
        } else if (endParts.length === 2) {
          end = parseDate(`${start.getFullYear()}-${endPart.trim()}`);
        } else {
          end = parseDate(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${endPart.trim().padStart(2, '0')}`);
        }
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
        const start = parseDate(s.trim());
        const endParts = e.trim().split('-');
        let end;
        if (endParts.length === 3) {
          end = parseDate(e.trim());
        } else if (endParts.length === 2) {
          end = parseDate(`${start.getFullYear()}-${e.trim()}`);
        } else {
          end = parseDate(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${e.trim().padStart(2, '0')}`);
        }
        ranges.push({ start, end, event: t.event });
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

    const periodsPerWeek = state.plan.schedule[className]?.periods_per_week || 2;
    const hasWeeks = semData.chapters.some(ch => ch.weeks);
    const base = [];

    for (const ch of semData.chapters) {
      if (ch.extra) {
        base.push({ label: ch.extra, chapter: '', section: '' });
        continue;
      }

      let lessonCount = 1;
      if (ch.weeks) {
        const [wStart, wEnd] = ch.weeks.split('-').map(Number);
        lessonCount = (wEnd - wStart) * periodsPerWeek;
      }

      if (ch.sections && ch.sections.length > 0) {
        const lessonsPerSection = Math.max(1, Math.floor(lessonCount / ch.sections.length));
        for (let i = 0; i < ch.sections.length; i++) {
          const sec = ch.sections[i];
          const count = i === ch.sections.length - 1
            ? lessonCount - lessonsPerSection * (ch.sections.length - 1)
            : lessonsPerSection;
          for (let j = 0; j < count; j++) {
            base.push({ label: `${ch.topic} — ${sec}`, chapter: ch.topic, section: sec });
          }
        }
      } else {
        for (let j = 0; j < lessonCount; j++) {
          base.push({ label: `第${ch.ch}章 ${ch.topic}`, chapter: ch.topic, section: '' });
        }
      }
    }
    if (semData.extra) {
      for (const e of semData.extra) {
        base.push({ label: e, chapter: '', section: '' });
      }
    }

    if (base.length === 0) return [{ label: '(待補)', chapter: '', section: '' }];

    if (!hasWeeks) {
      const totalLessons = semester === 'semester1'
        ? (state.plan.schedule[className]?.semester1_lessons || 30)
        : (state.plan.schedule[className]?.semester2_lessons || 33);
      const result = [];
      while (result.length < totalLessons) {
        for (const item of base) {
          if (result.length >= totalLessons) break;
          result.push(item);
        }
      }
      return result;
    }

    return base;
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



  // ============ UI: NAVIGATION ============
  function switchView(view) {
    state.currentView = view;
    lsSet(LS_KEYS.currentView, view);
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('hidden', p.id !== `view-${view}`));
    renderCurrentView();
  }

  function selectClass(className) {
    if (state.selectedClass === className) {
      state.selectedClass = null;
    } else {
      state.selectedClass = className;
    }
    lsSet(LS_KEYS.selectedClass, state.selectedClass);
    document.querySelectorAll('.class-item').forEach(el =>
      el.classList.toggle('active', el.dataset.class === state.selectedClass)
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
    if (state.selectedClass) {
      html += `<div class="class-item" onclick="window.TP.selectClass('${state.selectedClass}')" style="color:var(--primary);font-size:13px;justify-content:center;border-bottom:1px solid var(--gray-200);margin-bottom:4px;padding-bottom:12px">
        ✕ 顯示全部班級
      </div>`;
    }
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
    const label = $('today-label');
    if (!container) return;

    const td = today();
    const viewDate = addDays(td, state.dayOffset);
    const viewDateStr = fmtDate(viewDate);

    if (label) label.textContent = fmtFull(viewDate);

    // Stats (always based on real today)
    const allLessons = Object.entries(state.lessons);
    let totalDone = 0, totalOverdue = 0;
    for (const [_, lessons] of allLessons) {
      for (const l of lessons) {
        if (l.done) totalDone++;
        if (!l.done && parseDate(l.date) < td) totalOverdue++;
      }
    }

    // Lessons for the viewed date
    const dayLessons = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClass && cls !== state.selectedClass) continue;
      for (const l of lessons) {
        if (l.date === viewDateStr) dayLessons.push(l);
      }
    }
    dayLessons.sort((a, b) => a.time.localeCompare(b.time));
    const dayDone = dayLessons.filter(l => l.done).length;

    $('stat-total-done').textContent = totalDone;
    $('stat-overdue').textContent = totalOverdue;
    $('stat-today').textContent = `${dayDone}/${dayLessons.length}`;

    if (dayLessons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📅</div>
          <h3>${state.dayOffset === 0 ? '今天沒有課堂' : '當天沒有課堂'}</h3>
          <p>切換到「本週課表」查看本週安排</p>
        </div>`;
      return;
    }

    container.innerHTML = dayLessons.map(l => renderLessonCard(l, true)).join('');
    bindLessonCardEvents(container);
  }

  // ============ UI: WEEK VIEW ============
  function renderWeek() {
    const container = $('week-content');
    const label = $('week-label');
    if (!container) return;

    const td = today();
    const offsetDays = state.weekOffset * 7;
    const viewDate = addDays(td, offsetDays);
    const dow = viewDate.getDay();
    const weekStart = addDays(viewDate, -((dow + 6) % 7));
    const weekEnd = addDays(weekStart, 6);

    if (label) label.textContent = `${fmtDisplay(weekStart)} — ${fmtDisplay(weekEnd)}`;

    const weekLessons = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClass && cls !== state.selectedClass) continue;
      for (const l of lessons) {
        const ld = parseDate(l.date);
        if (ld >= weekStart && ld <= weekEnd) weekLessons.push(l);
      }
    }
    weekLessons.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : a.time.localeCompare(b.time);
    });

    const todayStr = fmtDate(td);

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
      const isToday = date === todayStr;
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

    const shiftCount = state.progress?.classes?.[l.class]?.[l.semester]?.shift_count || 0;

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
            <button class="btn btn-sm btn-outline post-btn" data-id="${l.id}" ${l.done ? 'disabled' : ''}> ${l.postponed ? '▶ 取消延期' : '⏸ 延期'}</button>
            <button class="btn btn-sm btn-outline shift-btn" data-id="${l.id}">${shiftCount > 0 ? `↩ 取消順延(${shiftCount})` : '⏩ 順延'}</button>
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
  function initCalendarMonth() {
    const td = today();
    state.calendarMonth = { year: td.getFullYear(), month: td.getMonth() };
  }

  function calPrevMonth() {
    if (!state.calendarMonth) initCalendarMonth();
    state.calendarMonth.month--;
    if (state.calendarMonth.month < 0) { state.calendarMonth.month = 11; state.calendarMonth.year--; }
    renderCalendar();
  }

  function calNextMonth() {
    if (!state.calendarMonth) initCalendarMonth();
    state.calendarMonth.month++;
    if (state.calendarMonth.month > 11) { state.calendarMonth.month = 0; state.calendarMonth.year++; }
    renderCalendar();
  }

  function navDay(offset) {
    state.dayOffset = offset === 0 ? 0 : state.dayOffset + offset;
    renderToday();
  }

  function navWeek(offset) {
    state.weekOffset = offset === 0 ? 0 : state.weekOffset + offset;
    renderWeek();
  }

  function renderCalendar() {
    const container = $('calendar-content');
    const label = $('cal-month-label');
    const legend = $('cal-legend');
    if (!container) return;

    if (!state.calendarMonth) initCalendarMonth();
    const { year, month } = state.calendarMonth;
    const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    if (label) label.textContent = `${year}年 ${MONTH_NAMES[month]}`;

    // Legend
    if (legend) {
      const classes = Object.keys(state.lessons);
      legend.innerHTML = classes.map(cls => {
        const color = CLASS_COLORS[cls] || '#64748b';
        const isActive = !state.selectedClass || state.selectedClass === cls;
        const opacity = isActive ? '1' : '0.3';
        return `<span class="cal-legend-item" style="opacity:${opacity};cursor:pointer" onclick="window.TP.selectClass('${cls}')"><span class="cal-legend-dot" style="background:${color}"></span>${cls}</span>`;
      }).join('');
    }

    // Build holiday set
    const holidaySet = buildHolidaySet();

    // Get first day of month and calculate grid
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    const daysInMonth = lastDay.getDate();

    // Collect all lessons for this month
    const allLessons = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClass && cls !== state.selectedClass) continue;
      for (const l of lessons) {
        const d = parseDate(l.date);
        if (d.getFullYear() === year && d.getMonth() === month) {
          allLessons.push(l);
        }
      }
    }

    // Group lessons by date
    const lessonsByDate = {};
    for (const l of allLessons) {
      if (!lessonsByDate[l.date]) lessonsByDate[l.date] = [];
      lessonsByDate[l.date].push(l);
    }

    const td = fmtDate(today());
    let html = '<div class="cal-month-grid">';

    // Day headers
    const DAY_HEADERS = ['週一', '週二', '週三', '週四', '週五'];
    for (const dh of DAY_HEADERS) {
      html += `<div style="font-size:12px;font-weight:600;color:var(--gray-400);text-align:center;padding:8px 0">${dh}</div>`;
    }

    // Fill previous month days
    const prevMonthLast = new Date(year, month, 0);
    for (let i = startDow - 1; i >= 0; i--) {
      const d = prevMonthLast.getDate() - i;
      html += `<div class="cal-day other-month"><div class="cal-day-header"><span class="cal-day-num">${d}</span></div></div>`;
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(year, month, d);
      const dow = dateObj.getDay();
      if (dow === 0 || dow === 6) continue; // Skip weekends

      const dateStr = fmtDate(dateObj);
      const isToday = dateStr === td;
      const isHol = holidaySet.has(dateStr);
      const dayLessons = lessonsByDate[dateStr] || [];

      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (isHol) cls += ' holiday';

      html += `<div class="${cls}">`;
      html += `<div class="cal-day-header">`;
      html += `<span class="cal-day-num">${d}</span>`;
      if (isHol) {
        const hol = getHolidayName(dateStr);
        html += `<span class="cal-holiday-tag">${hol || '假期'}</span>`;
      }
      html += `</div>`;

      for (const l of dayLessons) {
        const statusCls = l.done ? 'done' : (parseDate(l.date) < today() && !l.done ? 'overdue' : 'pending');
        const color = CLASS_COLORS[l.class] || '#64748b';
        html += `<div class="cal-lesson ${statusCls}" style="border-left-color:${color}" data-id="${l.id}" onclick="window.TP.openLessonModal(this.dataset.id)">`;
        html += `<span class="cal-lesson-class">${l.class}</span>`;
        html += `${l.done ? '✅' : '⬜'} ${escHtml(l.topic.substring(0, 12))}${l.topic.length > 12 ? '...' : ''}`;
        html += `</div>`;
      }

      html += `</div>`;
    }

    // Fill next month days
    const totalCells = startDow + daysInMonth;
    const remaining = (5 - (totalCells % 5)) % 5;
    for (let d = 1; d <= remaining; d++) {
      html += `<div class="cal-day other-month"><div class="cal-day-header"><span class="cal-day-num">${d}</span></div></div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  }

  function getHolidayName(dateStr) {
    if (!state.plan?.school_calendar) return '';
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
        let end;
        if (endParts.length === 3) {
          end = parseDate(endPart.trim());
        } else if (endParts.length === 2) {
          end = parseDate(`${start.getFullYear()}-${endPart.trim()}`);
        } else {
          end = parseDate(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${endPart.trim().padStart(2, '0')}`);
        }
        const d = parseDate(dateStr);
        if (d >= start && d <= end) return h.event;
      } else {
        if (fmtDate(parseDate(raw)) === dateStr) return h.event;
      }
    }
    return '';
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
    l.postponed = !l.postponed;
    markDirty();
    renderAll();
    toast(l.postponed ? `⏸ ${l.class} 第${l.lessonNum}節已延期` : `▶ ${l.class} 第${l.lessonNum}節已取消延期`, l.postponed ? 'warning' : 'success');
  }

  function autoShift(id) {
    const l = findLesson(id);
    if (!l) return;
    const cls = l.class;
    const sem = l.semester;

    if (!state.progress.classes[cls]) state.progress.classes[cls] = {};
    if (!state.progress.classes[cls][sem]) state.progress.classes[cls][sem] = {};
    const currentShift = state.progress.classes[cls][sem].shift_count || 0;

    if (currentShift > 0) {
      // Undo: decrement shift count
      state.progress.classes[cls][sem].shift_count = currentShift - 1;
      regenerateClassLessons(cls);
      markDirty();
      renderAll();
      toast(`↩ ${cls} 已取消一節順延（剩餘 ${currentShift - 1} 節）`, 'success');
    } else {
      // Shift: increment shift count
      state.progress.classes[cls][sem].shift_count = currentShift + 1;
      regenerateClassLessons(cls);
      markDirty();
      renderAll();
      toast(`⏩ ${cls} 已順延一節`, 'info');
    }
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

  function openLessonModal(id) {
    const l = findLesson(id);
    if (!l) return;
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    const title = $('modal-title');
    const hwData = l.hw && typeof l.hw === 'object' ? l.hw : (l.hw ? { topic: l.hw } : {});

    title.textContent = `${l.class} 第${l.lessonNum}節`;
    body.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span class="badge ${l.done ? 'badge-ok' : 'badge-behind'}">${l.done ? '已完成' : '未完成'}</span>
        ${l.postponed ? '<span class="badge" style="background:#fef3c7;color:#92400e">已延期</span>' : ''}
      </div>
      <div style="font-size:14px;color:var(--gray-600);margin-bottom:12px">
        <div>📅 ${fmtDisplay(l.date)} ${l.dayOfWeek} ${l.time}</div>
        <div style="margin-top:4px">📖 ${escHtml(l.topic)}</div>
      </div>
      <div class="form-group">
        <label>教學主題（可修改）</label>
        <input type="text" id="modal-topic" value="${escHtml(l.topic)}" placeholder="輸入教學主題">
      </div>
      <div class="form-group">
        <label>課後備註</label>
        <textarea id="modal-note" rows="3" placeholder="課後備註...">${escHtml(l.note || '')}</textarea>
      </div>
      <div class="form-group">
        <label>作業主題</label>
        <input type="text" id="modal-hw-topic" value="${escHtml(hwData.topic || '')}" placeholder="例: 課本 P.32 練習">
      </div>
      <div class="form-group">
        <label>作業繳交日期</label>
        <input type="date" id="modal-hw-due" value="${hwData.due || ''}">
      </div>`;

    $('modal-footer').innerHTML = `
      <button class="btn ${l.done ? 'btn-outline' : 'btn-success'}" id="modal-toggle-done">${l.done ? '取消完成' : '✓ 標記完成'}</button>
      <button class="btn btn-outline" id="modal-cancel">取消</button>
      <button class="btn btn-primary" id="modal-save">儲存</button>`;
    overlay.classList.add('open');

    $('modal-toggle-done').onclick = () => {
      l.done = !l.done;
      markDirty();
      overlay.classList.remove('open');
      renderAll();
      toast(l.done ? '✅ 已完成' : '已取消完成', l.done ? 'success' : 'info');
    };

    $('modal-save').onclick = () => {
      l.topic = $('modal-topic').value.trim() || l.topic;
      l.note = $('modal-note').value.trim();
      const hwTopic = $('modal-hw-topic').value.trim();
      const hwDue = $('modal-hw-due').value;
      l.hw = hwTopic ? { topic: hwTopic, due: hwDue } : null;
      markDirty();
      overlay.classList.remove('open');
      renderAll();
      toast('已儲存', 'success');
    };

    $('modal-cancel').onclick = () => overlay.classList.remove('open');
  }

  function openHwModal(id) {
    const l = findLesson(id);
    if (!l) return;
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    const title = $('modal-title');
    title.textContent = `${l.class} 第${l.lessonNum}節 — 作業`;
    const hwData = l.hw && typeof l.hw === 'object' ? l.hw : (l.hw ? { topic: l.hw } : {});
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

    // Bind calendar navigation
    $('cal-prev')?.addEventListener('click', calPrevMonth);
    $('cal-next')?.addEventListener('click', calNextMonth);

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
  window.TP = { selectClass, switchView, openLessonModal, navDay, navWeek };

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();