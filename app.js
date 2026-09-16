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
    selectedClasses: 'tp_selected_classes',
    currentView: 'tp_current_view',
    expandedLessons: 'tp_expanded',
    snapshots: 'tp_snapshots',
    // 本機最後一次看到的遠端 _meta.last_modified。用來判斷本機這份是否有
    // 還沒送出去的修改 —— 沒有的話，載入時才可以讓遠端覆蓋。
    lastRemoteStamp: 'tp_last_remote_stamp',
    // '1' = 有一筆「明確覆蓋」（還原／重設／匯入）還沒成功送出去
    pendingForce: 'tp_pending_force'
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
    selectedClasses: new Set(),
    expandedLessons: new Set(),
    isDirty: false,
    saveTimer: null,
    // 老師在這一次工作階段碰過的課堂 id。只用來決定存檔時要蓋哪些 updated_at，
    // 刻意不序列化 —— 文件的時間戳本身就是「這台裝置碰過什麼」的紀錄。
    dirtyLessons: new Set(),
    editSeq: 0,          // 每次編輯遞增，用來判斷存檔過程中間有沒有新編輯
    saveInFlight: false,
    saveQueued: false,
    retryDelay: 0,
    retryTimer: null,
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
  // 這個函式每次都要把整個學期的內容陣列重建一遍。記住上一次的 plan 物件身分，
  // plan 換了就整批失效 —— 比在每個會改 plan 的地方手動清快取可靠，不會漏。
  // 回傳的陣列只被讀取（課堂物件是另外建的），沒有共用參照的問題。
  let _flatCache = new Map();
  let _flatCachePlan;
  function flattenContent(className, semester) {
    if (_flatCachePlan !== state.plan) { _flatCache.clear(); _flatCachePlan = state.plan; }
    const key = `${className}|${semester}`;
    if (_flatCache.has(key)) return _flatCache.get(key);
    const result = flattenContentUncached(className, semester);
    _flatCache.set(key, result);
    return result;
  }

  function flattenContentUncached(className, semester) {
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
      if (ch.lesson_count) {
        lessonCount = ch.lesson_count;
      } else if (ch.weeks) {
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
  // 學期起訖日優先用 plan.json 的 "semesters" 欄位，沒有才用下面的預設值。
  // 換學年時只要在 plan 的 Gist 補上這段，不必改程式：
  //   "semesters": {
  //     "semester1": { "start": "2026-09-01", "end": "2027-01-23" },
  //     "semester2": { "start": "2027-02-03", "end": "2027-07-07" }
  //   }
  const DEFAULT_SEMESTERS = {
    semester1: { start: '2026-09-01', end: '2027-01-23' },
    semester2: { start: '2027-02-03', end: '2027-07-07' }
  };

  function getSemesterRanges() {
    const cfg = state.plan?.semesters || {};
    const valid = d => d instanceof Date && !isNaN(d.getTime());
    const pick = key => {
      const fb = DEFAULT_SEMESTERS[key];
      const s = cfg[key] || {};
      const start = parseDate(s.start || fb.start);
      const end = parseDate(s.end || fb.end);
      // 日期打錯會變成 Invalid Date，產生不出任何課 —— 這種情況退回預設值
      return valid(start) && valid(end) && start <= end
        ? { start, end }
        : { start: parseDate(fb.start), end: parseDate(fb.end) };
    };
    return { s1: pick('semester1'), s2: pick('semester2') };
  }

  function generateLessonSlots() {
    if (!state.plan) return;
    const holidaySet = buildHolidaySet();
    const examRanges = buildExamRanges();
    const { s1, s2 } = getSemesterRanges();
    const sem1Start = s1.start;
    const sem1End = s1.end;
    const sem2Start = s2.start;
    const sem2End = s2.end;

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
            baseTopic: content.label,   // 產生時的主題，用來判斷老師有沒有改過
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
            baseTopic: content.label,   // 產生時的主題，用來判斷老師有沒有改過
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
    pruneStaleUiState();
  }

  // 展開狀態與側邊欄篩選都存在 localStorage。課堂會因為順延、學期日期調整而重新產生，
  // 不修剪的話那些 id 會永遠留在那裡，一年下來累積幾千筆沒有意義的字串。
  function pruneStaleUiState() {
    const live = new Set();
    for (const lessons of Object.values(state.lessons)) {
      for (const l of lessons) live.add(l.id);
    }
    let changed = false;
    for (const id of state.expandedLessons) {
      if (!live.has(id)) { state.expandedLessons.delete(id); changed = true; }
    }
    if (changed) lsSet(LS_KEYS.expandedLessons, [...state.expandedLessons]);

    // 班級也可能因為換了 plan 而不存在了，一起清掉，否則側邊欄會篩選到空集合
    const classes = new Set(Object.keys(state.plan?.schedule || {}));
    const before = state.selectedClasses.size;
    for (const c of state.selectedClasses) if (!classes.has(c)) state.selectedClasses.delete(c);
    if (state.selectedClasses.size !== before) lsSet(LS_KEYS.selectedClasses, [...state.selectedClasses]);
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
  // 主題是否被老師手動改過。比對的是產生當下的 baseTopic，不是重算出來的內容 ——
  // 「順延」會改變每一節對應的內容，重算會把整班的未修改課堂都誤判成覆寫。
  function isOverridden(lesson) {
    return !!lesson && lesson.topic !== lesson.baseTopic;
  }

  function markDirty() {
    state.isDirty = true;
    state.editSeq++;
    clearTimeout(state.saveTimer);
    // 只有這一層 debounce。之前這裡 setTimeout 到 saveProgress()，而 saveProgress
    // 自己又是 debounce(…, 2000)，兩個獨立計時器讓實際延遲變成 4 秒，
    // 而且 visibilitychange 只清得掉其中一個。
    state.saveTimer = setTimeout(saveProgressNow, 2000);
    renderSyncBanner();
  }

  // 課堂層級的變更。記下是哪一節被碰過，存檔時才知道要蓋哪些 updated_at。
  function markLessonDirty(id) {
    state.dirtyLessons.add(id);
    markDirty();
  }

  // 蓋時間戳時做單調夾制：裝置時鐘偏慢的話，新版本的時間戳可能比文件上一版還舊，
  // 那這台裝置的修改會在每一次合併都輸掉。
  function stampNow() {
    const prev = state.progress?._meta?.last_modified;
    const now = new Date().toISOString();
    if (!prev || now > prev) return now;
    return new Date(new Date(prev).getTime() + 1).toISOString();
  }

  function buildProgressData() {
    const progress = { _meta: { ...(state.progress?._meta || {}) }, classes: {} };
    progress._meta.version = '1.0';
    progress._meta.last_modified = stampNow();
    const now = progress._meta.last_modified;

    for (const [className, lessons] of Object.entries(state.lessons)) {
      const classData = {};
      for (const semKey of ['semester1', 'semester2']) {
        const semLessons = lessons.filter(l => l.semester === semKey);
        const prevSem = state.progress?.classes?.[className]?.[semKey];
        const prevRecords = prevSem?.lessons || [];

        classData[semKey] = {
          shift_count: prevSem?.shift_count || 0,
          lessons: semLessons.map(l => {
            const prev = prevRecords.find(r => r.lesson === l.lessonNum);
            // 碰過的蓋新時間戳；沒碰過的沿用載入時帶進來的值。
            // 這裡刻意不給沒有值的紀錄補一個「現在」—— 那會讓每一筆沒碰過的課堂
            // 都被當成有變動而寫進文件（稀疏過濾整段失效），而且會讓它們在合併時
            // 無條件贏過別台裝置真正較新的紀錄。代理值改在 mergeProgressData 裡給。
            const updated_at = state.dirtyLessons.has(l.id) ? now : prev?.updated_at;
            // 最後一項是關鍵：紀錄一旦被碰過就永遠保留。少了它，「取消打卡」會讓
            // 所有欄位變成 falsy 而整筆消失，合併時遠端較舊的 done:true 就會復活。
            if (!(l.done || l.note || l.hw || l.postponed || isOverridden(l) || updated_at)) return null;
            return {
              lesson: l.lessonNum,
              date: l.date,
              done: l.done,
              note: l.note || undefined,
              hw: l.hw || undefined,
              postponed: l.postponed || undefined,
              topic_override: isOverridden(l) ? l.topic : undefined,
              updated_at
            };
          }).filter(Boolean)
        };
        if (prevSem?.shift_count_at) classData[semKey].shift_count_at = prevSem.shift_count_at;
      }
      progress.classes[className] = classData;
    }

    // plan 裡沒有的班級原樣保留。這台裝置的 plan 可能比較舊，
    // 不該因為它認不得就把別台裝置的紀錄刪掉 —— 在 union 合併下那會變成
    // 「合併加回來、下次存檔又刪掉」的無限循環。
    for (const [cls, data] of Object.entries(state.progress?.classes || {})) {
      if (!progress.classes[cls]) progress.classes[cls] = data;
    }

    return progress;
  }

  // 逐節合併。課堂紀錄彼此獨立 —— A 裝置勾了初三甲第 12 節、B 裝置勾了高一乙第 8 節
  // 根本不衝突，沒有理由叫老師二選一。
  //
  // 時間戳取 rec.updated_at || 文件的 _meta.last_modified。後面那個 fallback 是必要的：
  // 舊版 app 的紀錄映射是固定欄位列表，會把 updated_at 整個洗掉，所以舊版每存一次檔，
  // 它的紀錄就全都變成「沒有時間戳」。若把沒時間戳一律當成最舊，新版的本機修改就全輸。
  // localPrevStamp = 本機這份「存檔前」的 _meta.last_modified。沒有逐筆時間戳的紀錄
  // （舊版 app 寫的）就用它當代理值。不能用剛蓋上的新時間戳 —— 那會讓本機每一筆沒碰過
  // 的舊紀錄都贏過別台裝置真正較新的紀錄，離線久一點就會蓋掉別人的進度。
  function mergeProgressData(local, remote, localPrevStamp) {
    const localStamp = local._meta?.last_modified || '';
    const remoteStamp = remote._meta?.last_modified || '';
    const localFallback = localPrevStamp || localStamp;
    const ts = (rec, docStamp) => rec?.updated_at || docStamp;
    // 比對「內容」時要忽略 updated_at：時間戳不同不等於資料不同，
    // 否則每次合併都會誤報一堆「被取代」，通知就失去意義了。
    const recKey = r => { const { updated_at, ...rest } = r; return JSON.stringify(rest); };

    let lostLocal = 0, lostRemote = 0;
    const merged = { _meta: { ...(local._meta || {}) }, classes: {} };
    merged._meta.last_modified = localStamp;   // 已經是剛蓋好的新時間戳

    const classes = new Set([...Object.keys(local.classes || {}), ...Object.keys(remote.classes || {})]);
    for (const cls of classes) {
      const lc = local.classes?.[cls];
      const rc = remote.classes?.[cls];
      if (!lc) { merged.classes[cls] = rc; continue; }
      if (!rc) { merged.classes[cls] = lc; continue; }

      merged.classes[cls] = {};
      for (const sem of ['semester1', 'semester2']) {
        const ls = lc[sem], rs = rc[sem];
        if (!ls) { merged.classes[cls][sem] = rs; continue; }
        if (!rs) { merged.classes[cls][sem] = ls; continue; }

        // shift_count 是純量，一樣比時間戳。舊資料沒有 shift_count_at → 視為最舊。
        const lAt = ls.shift_count_at || '';
        const rAt = rs.shift_count_at || '';
        const out = {};
        if (rAt > lAt) {
          out.shift_count = rs.shift_count || 0;
          if (rs.shift_count_at) out.shift_count_at = rs.shift_count_at;
        } else {
          out.shift_count = ls.shift_count || 0;
          if (ls.shift_count_at) out.shift_count_at = ls.shift_count_at;
        }

        const byLesson = new Map();
        for (const r of (ls.lessons || [])) byLesson.set(r.lesson, r);
        for (const r of (rs.lessons || [])) {
          const cur = byLesson.get(r.lesson);
          if (!cur) { byLesson.set(r.lesson, r); continue; }
          const lt = ts(cur, localFallback);
          const rt = ts(r, remoteStamp);
          const differs = recKey(cur) !== recKey(r);
          if (rt > lt) {
            if (differs) lostLocal++;                    // 遠端較新，本機這筆被取代
            byLesson.set(r.lesson, r);
          } else if (lt > rt) {
            if (differs) lostRemote++;                   // 本機較新，遠端這筆被取代
          } else if (differs) {
            lostRemote++;                                // 平手時本機勝（＝老師手上這台）
          }
        }
        out.lessons = [...byLesson.values()].sort((a, b) => a.lesson - b.lesson);
        merged.classes[cls][sem] = out;
      }
    }
    return { merged, lostLocal, lostRemote };
  }

  // ============ API: GIST ============
  function headers() {
    return {
      'Authorization': `token ${state.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  // gist.files 是物件，鍵的順序沒有保證 —— 直接取 [0] 有可能挑到別的檔案。
  // 優先用指定檔名；只有一個檔案時就用它；多個檔案又對不上就報錯，不要用猜的。
  function pickGistFile(gist, name) {
    const files = gist?.files || {};
    const names = Object.keys(files);
    if (files[name]?.content) return files[name];
    if (names.length === 1 && files[names[0]]?.content) return files[names[0]];
    const jsonNames = names.filter(n => n.endsWith('.json'));
    if (jsonNames.length === 1 && files[jsonNames[0]]?.content) return files[jsonNames[0]];
    const e = new Error(`Gist 裡找不到 ${name}${names.length ? `（現有：${names.join('、')}）` : '（這個 Gist 是空的）'}`);
    e.fatal = true;   // 檔名被改過，重試也不會好
    throw e;
  }

  async function apiLoadPlan() {
    if (!state.planGistId) throw new Error('缺少 plan Gist ID');
    const res = await fetch(`${GIST_API}/${state.planGistId}`, { headers: headers() });
    if (!res.ok) throw new Error(`載入 plan 失敗: ${res.status}`);
    const gist = await res.json();
    const file = pickGistFile(gist, 'plan.json');
    state.plan = JSON.parse(file.content);
    lsSet(LS_KEYS.plan, state.plan);
    return state.plan;
  }

  // 讀不到時直接丟錯，讓呼叫端保留原本的快取 ——
  // 之前是 catch 起來塞一份空的，等於一次網路抖動就把進度清光。
  async function apiLoadProgress() {
    if (!state.progressGistId) return initEmptyProgress();
    const res = await fetch(`${GIST_API}/${state.progressGistId}`, { headers: headers() });
    if (!res.ok) throw new Error(`載入進度失敗: ${res.status}`);
    const gist = await res.json();
    const file = pickGistFile(gist, 'progress.json');
    state.progress = JSON.parse(file.content);
    lsSet(LS_KEYS.progress, state.progress);
    // 剛載入完，本機和遠端必然一致 —— 記下遠端時間戳，下次才知道本機有沒有未送出的東西
    lsSet(LS_KEYS.lastRemoteStamp, state.progress._meta?.last_modified || null);
    return state.progress;
  }

  // 本機這份有沒有還沒送出去的修改？判斷依據是「上次成功同步時看到的遠端時間戳」
  // 是否等於本機目前的時間戳。少了這個判斷，init() 會無條件用遠端覆蓋本機，
  // 離線累積一整週的紀錄就在連上網開啟的瞬間消失，而且不會留下任何快照。
  function localHasUnpushed() {
    if (!state.progress) return false;
    const seen = lsGet(LS_KEYS.lastRemoteStamp, null);
    return seen === null || seen !== (state.progress._meta?.last_modified || null);
  }

  function initEmptyProgress() {
    // 一定要帶 last_modified。衝突檢查比的就是這個欄位，
    // 少了它會變成 undefined !== remoteStamp，之後每一次存檔都會被判定成衝突。
    const now = new Date().toISOString();
    state.progress = { _meta: { version: '1.0', created: now, last_modified: now }, classes: {} };
    return state.progress;
  }

  function httpError(status, prefix) {
    const e = new Error(`${prefix}: ${status}`);
    e.status = status;
    return e;
  }

  // 401/403（token 失效）、404（gist 被刪）、422（格式被拒）重試一百次也不會好
  function isRetryable(err) {
    if (err?.fatal) return false;
    const s = err?.status;
    return !(s === 401 || s === 403 || s === 404 || s === 422);
  }

  // 指數退避。頁面重載時 init() 會直接再試一次，所以不必把退避狀態存起來。
  function scheduleRetry() {
    if (state.retryTimer) return;
    state.retryDelay = Math.min(state.retryDelay ? state.retryDelay * 2 : 5000, 5 * 60 * 1000);
    state.retryTimer = setTimeout(() => { state.retryTimer = null; saveProgressNow(); }, state.retryDelay);
  }

  // force = 使用者明確選擇要覆蓋（還原／重設／匯入），跳過合併
  async function apiSaveProgress(force) {
    if (state.saveInFlight) { state.saveQueued = true; return; }
    state.saveInFlight = true;
    const seq = state.editSeq;
    try {
      // 存檔前本機那份文件的時間戳。buildProgressData() 會蓋掉它，先留下來給合併用。
      const prevStamp = state.progress?._meta?.last_modified;
      const data = buildProgressData();

      // 先讀遠端。讀不到就不寫 —— 但仍完成本機提交（見下），否則離線時
      // 編輯只存在記憶體，重新載入就沒了，比原本還糟。
      let remote = null, readErr = null;
      if (state.progressGistId) {
        try { remote = await fetchRemoteProgressStrict(); }
        catch (e) { readErr = e; }
      }

      let outgoing = data;
      if (!force && !readErr && remote?._meta?.last_modified) {
        // 遠端有別台裝置寫過的東西 → 逐節合併，不再叫老師二選一。
        // 這裡不比對 last_modified 是否相等：buildProgressData() 每次都蓋新時間戳，
        // 兩邊永遠不會相等；沒有東西可合併時合併本來就是 no-op。
        const { merged, lostLocal, lostRemote } = mergeProgressData(data, remote, prevStamp);
        if (lostLocal || lostRemote) {
          // 合併真的丟了東西 —— 這兩份一定要留下來，不受快照的 10 分鐘間隔限制
          takeSnapshot(`合併前・本機（被雲端取代 ${lostLocal} 筆）`, data, true);
          takeSnapshot(`合併前・雲端（被本機取代 ${lostRemote} 筆）`, remote, true);
          toast(`合併：本機被取代 ${lostLocal} 筆、雲端被取代 ${lostRemote} 筆（已備份）`, 'warning');
        }
        outgoing = merged;
      } else {
        // 例行存檔前的備份走一般路徑就好。這裡若強制備份，每次存檔都留一版，
        // 5 格快照環會被最近的幾次編輯填滿，反而救不回上週的版本。
        takeSnapshot('同步前', state.progress);
      }

      // 本機先提交再打網路：就算網路失敗，編輯也已經落在 localStorage。
      // dirtyLessons 可以在這裡清掉 —— 時間戳已經寫進 outgoing，下一次重試
      // 會從 state.progress 把 prev.updated_at 帶回來。
      state.progress = outgoing;
      lsSet(LS_KEYS.progress, outgoing);
      if (force) lsSet(LS_KEYS.pendingForce, '1');
      else localStorage.removeItem(LS_KEYS.pendingForce);
      state.dirtyLessons.clear();

      if (readErr) throw readErr;   // 讀不到遠端 → 不覆蓋，排隊重試

      const content = JSON.stringify(outgoing, null, 2);
      if (!state.progressGistId) {
        const res = await fetch(GIST_API, {
          method: 'POST', headers: headers(),
          body: JSON.stringify({
            description: 'Data (Private)',
            public: false,
            files: { 'progress.json': { content } }
          })
        });
        if (!res.ok) throw httpError(res.status, '建立 Gist 失敗');
        const gist = await res.json();
        state.progressGistId = gist.id;
        lsSet(LS_KEYS.progressGistId, gist.id);
      } else {
        const res = await fetch(`${GIST_API}/${state.progressGistId}`, {
          method: 'PATCH', headers: headers(),
          body: JSON.stringify({ files: { 'progress.json': { content } } })
        });
        if (!res.ok) throw httpError(res.status, '儲存失敗');
      }

      state.retryDelay = 0;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      lsSet(LS_KEYS.lastSync, new Date().toISOString());
      lsSet(LS_KEYS.lastRemoteStamp, outgoing._meta.last_modified);
      localStorage.removeItem(LS_KEYS.pendingForce);

      // 存檔期間老師又改了東西的話，不要清 isDirty、也不要重建課堂 ——
      // 重建會蓋掉他正在編輯的內容。讓排隊的那次存檔收尾。
      if (state.editSeq === seq) {
        state.isDirty = false;
        generateLessonSlots();
        renderAll();
      }
      renderSyncBanner();
      return true;
    } catch (e) {
      if (isRetryable(e)) scheduleRetry();
      throw e;
    } finally {
      state.saveInFlight = false;
      if (state.saveQueued) { state.saveQueued = false; state.saveTimer = setTimeout(saveProgressNow, 0); }
    }
  }

  // 立即儲存。手機切離畫面時計時器會被凍結，所以 markDirty 的計時器等不到 ——
  // visibilitychange 必須能直接呼叫這個函式把待存的內容送出去。
  function saveProgressNow() {
    clearTimeout(state.saveTimer);
    apiSaveProgress()
      .then(ok => { if (ok) toast('已同步', 'success'); })   // 排隊中的那次不報成功
      .catch(e => {
        if (e.status === 401 || e.status === 403) { toast(`${e.message}——請到設定頁更新 Token`, 'error'); return; }
        if (e.status === 404) { toast(`${e.message}——Gist 可能已被刪除`, 'error'); return; }
        toast('同步失敗: ' + e.message, 'error');
      })
      .finally(() => renderSyncBanner());
  }

  // ============ DATA: SNAPSHOTS (自動版本備份) ============
  const SNAPSHOT_LIMIT = 5;
  const SNAPSHOT_MIN_GAP = 10 * 60 * 1000;   // 非強制備份的最小間隔

  function getSnapshots() {
    const list = lsGet(LS_KEYS.snapshots, []);
    return Array.isArray(list) ? list : [];
  }

  // buildProgressData() 每次呼叫都會蓋上新的 _meta.last_modified，逐節紀錄也會蓋
  // updated_at / shift_count_at。去重時必須把這些時間戳全部剔除，否則每次存檔的內容鍵
  // 都不一樣，5 格快照環會被自己洗掉。是「移除欄位」而非歸零 —— JSON.stringify 的鍵序
  // 會影響比對結果。
  function contentKey(data) {
    const meta = { ...(data._meta || {}) };
    delete meta.last_modified;
    const classes = {};
    for (const [cls, c] of Object.entries(data.classes || {})) {
      classes[cls] = {};
      for (const [sem, s] of Object.entries(c || {})) {
        if (!s || typeof s !== 'object') { classes[cls][sem] = s; continue; }
        const { shift_count_at, ...rest } = s;
        rest.lessons = (s.lessons || []).map(r => {
          const { updated_at, ...rec } = r;
          return rec;
        });
        classes[cls][sem] = rest;
      }
    }
    return JSON.stringify({ ...data, _meta: meta, classes });
  }

  // payload 省略時，備份目前記憶體中的版本。force = 不受間隔限制
  function takeSnapshot(reason, payload, force) {
    const data = payload || state.progress;
    if (!data?.classes) return;

    const body = JSON.stringify(data);
    const hasData = Object.values(data.classes).some(c =>
      Object.values(c || {}).some(s => (s?.lessons || []).length > 0)
    );
    if (!hasData) return;                                   // 空進度不值得備份

    const list = getSnapshots();
    const key = contentKey(data);
    if (list.some(s => {                                      // 這份內容已經存過就不重複存
      try { return contentKey(JSON.parse(s.body)) === key; } catch { return false; }
    })) return;
    if (!force && list[0] && Date.now() - new Date(list[0].at).getTime() < SNAPSHOT_MIN_GAP) return;

    const next = [{ at: new Date().toISOString(), reason, body }, ...list].slice(0, SNAPSHOT_LIMIT);
    try {
      lsSet(LS_KEYS.snapshots, next);
    } catch {
      // 空間不足時只留最新一版，不要讓存檔失敗
      try { lsSet(LS_KEYS.snapshots, next.slice(0, 1)); } catch { }
    }
  }

  function snapshotSummary(snap) {
    try {
      const d = JSON.parse(snap.body);
      let done = 0, total = 0;
      for (const c of Object.values(d.classes || {})) {
        for (const sem of ['semester1', 'semester2']) {
          const recs = c?.[sem]?.lessons || [];
          total += recs.length;
          done += recs.filter(r => r.done).length;
        }
      }
      return `${done} 節已完成 · ${total} 筆紀錄`;
    } catch { return '（無法讀取）'; }
  }

  function restoreSnapshot(index) {
    const snap = getSnapshots()[index];
    if (!snap) return;
    const when = new Date(snap.at).toLocaleString('zh-TW');
    if (!confirm(`確定還原到 ${when} 的版本？\n\n目前的進度會被覆蓋，但還原前會自動保留現況。`)) return;

    let restored;
    try { restored = JSON.parse(snap.body); }
    catch { toast('備份資料損毀，無法還原', 'error'); return; }

    takeSnapshot('還原前', state.progress, true);   // 先留退路
    state.progress = restored;
    lsSet(LS_KEYS.progress, restored);
    state.isDirty = true;                           // 還沒送上遠端
    generateLessonSlots();
    renderAll();
    // 還原是使用者的明確選擇 → 直接覆蓋遠端，不再做衝突檢查
    apiSaveProgress(true)
      .then(() => toast('已還原並同步', 'success'))
      .catch(e => toast('還原後同步失敗: ' + e.message, 'error'));
  }

  function clearSnapshots() {
    if (!confirm('確定清除所有版本備份？清除後無法復原。')) return;
    localStorage.removeItem(LS_KEYS.snapshots);
    renderSettings();
    toast('已清除備份', 'info');
  }

  // 只讀取遠端目前內容，不改動任何狀態。
  // 讀不到就丟錯，絕對不要回傳 null —— 呼叫端會把 null 當成「遠端沒有東西」
  // 而直接覆蓋，保險機制就在最需要它的時候剛好失效。
  async function fetchRemoteProgressStrict() {
    const res = await fetch(`${GIST_API}/${state.progressGistId}`, { headers: headers() });
    if (!res.ok) throw httpError(res.status, '讀取遠端進度失敗');
    const gist = await res.json();
    const file = pickGistFile(gist, 'progress.json');
    return JSON.parse(file.content);
  }

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
  // 每一張課堂卡片都會問一次，而每次都要掃過整班的課堂 —— 一次 render 等於
  // O(卡片數 × 課堂數)。同一個 render 週期內結果不會變，所以一週期算一次就好。
  let _statsCache = new Map();
  function getClassStats(className) {
    if (_statsCache.has(className)) return _statsCache.get(className);
    const result = computeClassStats(className);
    _statsCache.set(className, result);
    return result;
  }

  function computeClassStats(className) {
    const lessons = state.lessons[className] || [];
    const td = today();
    const total = lessons.length;
    const done = lessons.filter(l => l.done).length;
    const current = lessons.find(l => !l.done);
    // 已標「延期」的課是老師自己擱下的，不該再當成逾期來提醒。
    // 但它仍然算在 expectedDone 裡 —— 進度確實落後了，那是 shift_count 要處理的事。
    const overdue = lessons.filter(l => !l.done && !l.postponed && parseDate(l.date) < td).length;
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
    if (state.selectedClasses.has(className)) {
      state.selectedClasses.delete(className);
    } else {
      state.selectedClasses.add(className);
    }
    lsSet(LS_KEYS.selectedClasses, [...state.selectedClasses]);
    renderAll();
  }

  function clearClasses() {
    state.selectedClasses.clear();
    lsSet(LS_KEYS.selectedClasses, []);
    renderAll();
  }

  // ============ UI: RENDER ALL ============
  function renderCurrentView() {
    _statsCache.clear();   // 統計在同一個 render 週期內是固定的（見 getClassStats）
    switch (state.currentView) {
      case 'today': renderToday(); break;
      case 'week': renderWeek(); break;
      case 'compare': renderCompare(); break;
      case 'calendar': renderCalendar(); break;
      case 'settings': renderSettings(); break;
    }
  }

  function renderAll() {
    _statsCache.clear();
    renderSidebar();
    renderCurrentView();
    updateHeaderDate();
    renderSyncBanner();
  }

  // ============ UI: HEADER ============
  function updateHeaderDate() {
    const el = $('header-date');
    if (el) el.textContent = fmtFull(today());
  }

  // 未同步指示。toast 只活 3 秒，但「你的東西還沒上去」必須一直看得見 ——
  // 之前存檔失敗只彈一次訊息，老師根本不會發現那節課沒記錄到。
  let lastBannerState = null;
  function renderSyncBanner() {
    const el = $('sync-banner');
    if (!el) return;
    const pendingForce = lsGet(LS_KEYS.pendingForce, '') === '1';
    const unsynced = state.isDirty || localHasUnpushed();
    const key = `${unsynced}|${pendingForce}`;
    if (key === lastBannerState) return;   // 別讓每次 markDirty 都重建 DOM
    lastBannerState = key;

    if (!unsynced) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = pendingForce
      ? `⚠ 還原／重設尚未同步 <button class="btn btn-sm btn-outline" id="btn-resend-force">立即覆蓋雲端</button>`
      : `⚠ 尚未同步`;
    $('btn-resend-force')?.addEventListener('click', async () => {
      // 上次的明確覆蓋沒送出去，讓老師自己決定要不要現在覆蓋 ——
      // 當初要求覆蓋的那份文件可能已經被別的裝置改過了，不能靜默自動重送。
      try { await apiSaveProgress(true); toast('已覆蓋雲端', 'success'); }
      catch (e) { toast('同步失敗: ' + e.message, 'error'); }
      lastBannerState = null;
      renderSyncBanner();
    });
  }

  // ============ UI: SIDEBAR ============
  function renderSidebar() {
    const el = $('sidebar-classes');
    if (!el || !state.plan) return;
    const classes = Object.keys(state.plan.schedule);
    let html = '';
    if (state.selectedClasses.size > 0) {
      html += `<div class="class-item clear-classes-btn" style="color:var(--primary);font-size:13px;justify-content:center;border-bottom:1px solid var(--gray-200);margin-bottom:4px;padding-bottom:12px">
        ✕ 顯示全部班級
      </div>`;
    }
    let currentLevel = '';
    for (const cls of classes) {
      const info = state.plan.schedule[cls];
      if (info.level !== currentLevel) {
        currentLevel = info.level;
        html += `<h3>${escHtml(currentLevel)}</h3>`;
      }
      const stats = getClassStats(cls);
      const badgeClass = stats.status === 'ok' ? 'badge-ok' : stats.status === 'behind' ? 'badge-behind' : 'badge-ahead';
      const badgeText = stats.status === 'ok' ? '正常' : stats.status === 'behind' ? `落後${Math.abs(stats.diff)}` : `領先${stats.diff}`;
      html += `
        <div class="class-item ${state.selectedClasses.has(cls) ? 'active' : ''}" data-class="${escHtml(cls)}">
          <span>${escHtml(cls)}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>`;
    }
    el.innerHTML = html;
    el.querySelector('.clear-classes-btn')?.addEventListener('click', clearClasses);
    el.querySelectorAll('.class-item[data-class]').forEach(item => {
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
        if (!l.done && !l.postponed && parseDate(l.date) < td) totalOverdue++;
      }
    }

    // Lessons for the viewed date
    const dayLessons = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
      for (const l of lessons) {
        if (l.date === viewDateStr) dayLessons.push(l);
      }
    }
    dayLessons.sort((a, b) => a.time.localeCompare(b.time));
    const dayDone = dayLessons.filter(l => l.done).length;

    $('stat-total-done').textContent = totalDone;
    $('stat-overdue').textContent = totalOverdue;
    $('stat-today').textContent = `${dayDone}/${dayLessons.length}`;

    // 已延期清單。「延期」是把課堂挪走，但延期之後就再也沒有地方列出來 ——
    // 老師標記完就忘了補。這裡只列已經過去的（今天的還沒到，不必提醒）。
    const postponed = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
      for (const l of lessons) {
        if (l.postponed && !l.done && parseDate(l.date) <= td) postponed.push(l);
      }
    }
    postponed.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    const postponedHtml = postponed.length === 0 ? '' : `
      <div class="postponed-panel">
        <div class="postponed-head">⏸ 已延期待補（${postponed.length} 節）</div>
        ${postponed.map(l => `
          <div class="lesson-card shifted">
            <div class="lesson-header">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
                <div style="min-width:0">
                  <div class="lesson-class">${escHtml(l.class)}</div>
                  <div class="lesson-meta">
                    <span>第${l.period}節</span>
                    <span>${l.dayOfWeek} ${l.time}</span>
                    <span>原定 ${fmtDisplay(l.date)}</span>
                  </div>
                </div>
              </div>
              <button class="btn btn-sm btn-outline post-btn" data-id="${l.id}">▶ 取消延期</button>
            </div>
            <div class="lesson-topic"><span>${escHtml(l.topic)}</span></div>
          </div>`).join('')}
      </div>`;

    if (dayLessons.length === 0) {
      container.innerHTML = postponedHtml + `
        <div class="empty-state">
          <div class="icon">📅</div>
          <h3>${state.dayOffset === 0 ? '今天沒有課堂' : '當天沒有課堂'}</h3>
          <p>切換到「本週課表」查看本週安排</p>
        </div>`;
      bindLessonCardEvents(container);
      return;
    }

    container.innerHTML = postponedHtml + dayLessons.map(l => renderLessonCard(l)).join('');
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
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
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
      html += lessons.map(l => renderLessonCard(l)).join('');
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
    else if (ld < td && !l.postponed) statusClass = 'overdue';
    if (l.postponed) statusClass += ' shifted';

    const isExpanded = state.expandedLessons.has(l.id);
    const stats = getClassStats(l.class);
    const statusBadge = stats.status === 'ok' ? '' : `<span class="badge ${stats.status === 'behind' ? 'badge-behind' : 'badge-ahead'}" style="margin-left:8px">${stats.status === 'behind' ? '落後' : '領先'}</span>`;

    const shiftCount = state.progress?.classes?.[l.class]?.[l.semester]?.shift_count || 0;

    return `
      <div class="lesson-card ${statusClass}" data-id="${l.id}" data-class="${escHtml(l.class)}">
        <div class="lesson-header">
          <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
            <button class="check-btn ${l.done ? 'checked' : ''}" data-id="${l.id}" title="打卡">✓</button>
            <div style="min-width:0">
              <div class="lesson-class">${escHtml(l.class)}${statusBadge}</div>
              <div class="lesson-meta">
                <span>第${l.period}節</span>
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
        <div class="compare-card" data-class="${escHtml(cls)}">
          <div class="class-name">${escHtml(cls)}</div>
          <div class="class-level">${escHtml(state.plan.schedule[cls].level)} · ${state.plan.schedule[cls].periods_per_week}堂/週</div>
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
          <button class="btn btn-sm btn-outline btn-block compare-detail-btn" style="margin-top:12px" data-class="${escHtml(cls)}">查看詳細</button>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.compare-detail-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectClass(btn.dataset.class);
        switchView('today');
      });
    });
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
        const isActive = state.selectedClasses.size === 0 || state.selectedClasses.has(cls);
        const opacity = isActive ? '1' : '0.3';
        return `<span class="cal-legend-item" style="opacity:${opacity};cursor:pointer" data-class="${escHtml(cls)}"><span class="cal-legend-dot" style="background:${color}"></span>${escHtml(cls)}</span>`;
      }).join('');
      legend.querySelectorAll('.cal-legend-item').forEach(item => {
        item.addEventListener('click', () => selectClass(item.dataset.class));
      });
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
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
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
        html += `<span class="cal-holiday-tag">${escHtml(hol) || '假期'}</span>`;
      }
      html += `</div>`;

      for (const l of dayLessons) {
        const statusCls = l.done ? 'done' : (parseDate(l.date) < today() && !l.postponed ? 'overdue' : 'pending');
        const color = CLASS_COLORS[l.class] || '#64748b';
        html += `<div class="cal-lesson cal-lesson-clickable ${statusCls}" style="border-left-color:${color}" data-id="${l.id}">`;
        html += `<span class="cal-lesson-class">${escHtml(l.class)}</span>`;
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
    container.querySelectorAll('.cal-lesson-clickable').forEach(el => {
      el.addEventListener('click', () => openLessonModal(el.dataset.id));
    });
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
    const snaps = getSnapshots();

    const snapshotHtml = snaps.length === 0
      ? `<p style="font-size:13px;color:var(--gray-400);line-height:1.7">尚無備份。每次同步、重設進度或還原前，會自動保留當下的版本，最多 5 份。</p>`
      : snaps.map((s, i) => `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--gray-100)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600">${escHtml(s.reason)}</div>
              <div style="font-size:12px;color:var(--gray-400)">${new Date(s.at).toLocaleString('zh-TW')} · ${snapshotSummary(s)}</div>
            </div>
            <button class="btn btn-sm btn-outline snap-restore-btn" data-index="${i}">還原</button>
          </div>`).join('');

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
          <input type="password" id="settings-token" value="${escHtml(state.token)}" placeholder="ghp_xxxxxxxxxxxx">
          <div class="hint">需要 <code>gist</code> 權限。<a href="https://github.com/settings/tokens/new?scopes=gist&description=App" target="_blank">點此建立 Token</a></div>
        </div>
        <div class="form-group">
          <label>課程設定 Gist ID</label>
          <input type="text" id="settings-plan-gist" value="${escHtml(state.planGistId)}" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
          <div class="hint">包含 plan.json 的 Secret Gist ID</div>
        </div>
        <div class="form-group">
          <label>進度紀錄 Gist ID</label>
          <input type="text" id="settings-progress-gist" value="${escHtml(state.progressGistId)}" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
          <div class="hint">包含 progress.json 的 Secret Gist ID（多裝置請輸入同一個 ID）</div>
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
        <h3>版本紀錄（自動備份）</h3>
        <div style="margin-top:8px">${snapshotHtml}</div>
        ${snaps.length > 0 ? `<button class="btn btn-sm btn-outline" id="btn-clear-snapshots" style="margin-top:12px">清除全部備份</button>` : ''}
      </div>

      <div class="card settings-section">
        <h3>多裝置同步教學</h3>
        <div style="font-size:14px;color:var(--gray-600);line-height:1.8">
          <p>1. 在每台裝置的瀏覽器開啟此 App</p>
          <p>2. 進入「設定」頁面，輸入同一組 Token、課程 Gist ID 及進度 Gist ID</p>
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
    $('btn-clear-snapshots')?.addEventListener('click', clearSnapshots);
    container.querySelectorAll('.snap-restore-btn').forEach(btn => {
      btn.addEventListener('click', () => restoreSnapshot(Number(btn.dataset.index)));
    });
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
    markLessonDirty(id);
    renderAll();
    toast(l.done ? `✅ ${l.class} 第${l.period}節已完成` : `已取消完成`, l.done ? 'success' : 'info');
  }

  function toggleExpand(id, forceOpen) {
    if (forceOpen || !state.expandedLessons.has(id)) {
      state.expandedLessons.add(id);
    } else {
      state.expandedLessons.delete(id);
    }
    // 之前只寫進記憶體，重新載入就全部收合 —— 老師正在補進度的時候特別惱人
    lsSet(LS_KEYS.expandedLessons, [...state.expandedLessons]);
    renderCurrentView();
  }

  function updateTopic(id, value) {
    const l = findLesson(id);
    if (!l) return;
    l.topic = value;
    markLessonDirty(id);
  }

  function updateNote(id, value) {
    const l = findLesson(id);
    if (!l) return;
    l.note = value;
    markLessonDirty(id);
  }

  function postponeLesson(id) {
    const l = findLesson(id);
    if (!l || l.done) return;
    l.postponed = !l.postponed;
    markLessonDirty(id);
    renderAll();
    toast(l.postponed ? `⏸ ${l.class} 第${l.period}節已延期` : `▶ ${l.class} 第${l.period}節已取消延期`, l.postponed ? 'warning' : 'success');
  }

  function autoShift(id) {
    const l = findLesson(id);
    if (!l) return;
    const cls = l.class;
    const sem = l.semester;

    // 這台裝置若還沒存過進度，state.progress 會是 null
    if (!state.progress) state.progress = initEmptyProgress();
    if (!state.progress.classes) state.progress.classes = {};
    if (!state.progress.classes[cls]) state.progress.classes[cls] = {};
    if (!state.progress.classes[cls][sem]) state.progress.classes[cls][sem] = {};
    const slot = state.progress.classes[cls][sem];
    const currentShift = slot.shift_count || 0;

    // 順延次數是純量，兩台裝置各按一次沒辦法逐節合併 —— 比時間戳決定誰新。
    if (currentShift > 0) {
      // Undo: decrement shift count
      slot.shift_count = currentShift - 1;
      slot.shift_count_at = stampNow();
      regenerateClassLessons(cls);
      markDirty();
      renderAll();
      toast(`↩ ${cls} 已取消一節順延（剩餘 ${currentShift - 1} 節）`, 'success');
    } else {
      // Shift: increment shift count
      slot.shift_count = currentShift + 1;
      slot.shift_count_at = stampNow();
      regenerateClassLessons(cls);
      markDirty();
      renderAll();
      toast(`⏩ ${cls} 已順延一節`, 'info');
    }
  }

  function regenerateClassLessons(cls) {
    const info = state.plan?.schedule?.[cls];
    if (!info) return;
    const holidaySet = buildHolidaySet();
    const examRanges = buildExamRanges();
    const { s1, s2 } = getSemesterRanges();
    const sem1Start = s1.start;
    const sem1End = s1.end;
    const sem2Start = s2.start;
    const sem2End = s2.end;
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
          topic: isOverridden(old) ? old.topic : content.label, chapter: content.chapter,
          baseTopic: content.label,
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
          topic: isOverridden(old) ? old.topic : content.label, chapter: content.chapter,
          baseTopic: content.label,
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

    title.textContent = `${l.class} 第${l.period}節`;
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
      markLessonDirty(l.id);
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
      markLessonDirty(l.id);
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
    title.textContent = `${l.class} 第${l.period}節 — 作業`;
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
      markLessonDirty(l.id);
      overlay.classList.remove('open');
      renderCurrentView();
      toast('作業已更新', 'success');
    };
    $('modal-cancel').onclick = () => overlay.classList.remove('open');
  }

  // ============ SETTINGS ACTIONS ============
  async function saveSettings() {
    const token = $('settings-token')?.value.trim() ?? '';
    const gistId = $('settings-plan-gist')?.value.trim() ?? '';
    const progressGistId = $('settings-progress-gist')?.value.trim() ?? '';

    // 清空 Gist ID 會讓下次存檔另建一個新的 gist，舊的那份留在那裡沒人記得 ——
    // 這是老師清得掉但找不回來的東西，先問一聲。換 gist 請直接貼新的 ID。
    const clearing = [];
    if (!gistId && state.planGistId) clearing.push('課程設定 Gist');
    if (!progressGistId && state.progressGistId) clearing.push('進度紀錄 Gist');
    if (clearing.length && !confirm(
      `即將清空：${clearing.join('、')}\n\n`
      + '下次存檔會另外建立一個新的 Gist。舊的那份不會被刪除，但也不會再被使用。\n'
      + '如果只是想換成另一個 Gist，請直接貼上新的 ID，不要留空。\n\n確定要清空嗎？'
    )) return;

    // 之前是「有填才寫」，填錯了只能覆蓋、清不掉 —— 現在一律照欄位內容走
    const tokenCleared = !token && !!state.token;
    state.token = token;
    lsSet(LS_KEYS.token, token);
    state.planGistId = gistId;
    lsSet(LS_KEYS.planGistId, gistId);

    if (progressGistId !== state.progressGistId) {
      // 換了進度 gist，之前記下的遠端時間戳就不是這一本的 —— 留著會讓
      // localHasUnpushed() 誤判「本機沒有未送出的東西」，載入時直接把本機蓋掉。
      state.progressGistId = progressGistId;
      lsSet(LS_KEYS.progressGistId, progressGistId);
      localStorage.removeItem(LS_KEYS.lastRemoteStamp);
    }

    renderAll();
    if (tokenCleared) toast('設定已儲存 —— Token 已清空，同步會停用', 'warning');
    else toast('設定已儲存', 'success');
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
      if (state.progressGistId) {
        // 本機有未送出的修改就先合併，不要直接讀遠端蓋掉它
        if (localHasUnpushed()) await apiSaveProgress();
        else await apiLoadProgress();
      }
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
      snapshots: getSnapshots(),   // 備份只存在瀏覽器裡，不一起帶走的話清掉就真的沒了
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
      let data;
      try { data = JSON.parse(reader.result); }
      catch { toast('匯入失敗: 不是有效的 JSON', 'error'); return; }

      // 先驗證形狀，通過了才動任何狀態。之前是一邊解析一邊覆寫 localStorage，
      // 壞檔會留在 tp_plan 裡，下次啟動 generateLessonSlots() 直接丟錯，
      // 整個 app 跳到設定畫面 —— 看起來就像資料全沒了。
      const plan = data?.plan;
      const progress = data?.progress;
      const planOk = !!plan && typeof plan.schedule === 'object' && plan.schedule !== null;
      const progressOk = !!progress && typeof progress.classes === 'object' && progress.classes !== null;
      if (!planOk && !progressOk) {
        toast('匯入失敗: 檔案裡沒有可用的 plan 或 progress', 'error');
        return;
      }

      if (planOk) { state.plan = plan; lsSet(LS_KEYS.plan, plan); }
      if (progressOk) { state.progress = progress; lsSet(LS_KEYS.progress, progress); }
      if (Array.isArray(data.snapshots)) {          // 匯出檔有帶備份的話一併還原
        try { lsSet(LS_KEYS.snapshots, data.snapshots); } catch { }
      }

      generateLessonSlots();
      renderAll();

      // 匯入＝「我刻意載入這份」，是明確的覆蓋意圖，直接推上遠端。
      // 走一般存檔會先被衝突檢查擋下，結果匯入的內容根本沒送出去。
      try {
        await apiSaveProgress(true);
        toast('匯入成功', 'success');
      } catch (err) {
        toast('匯入成功（僅本機），同步失敗: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function resetProgress() {
    if (!confirm('確定要重設所有進度？\n\n重設前會自動保留一份備份，可從「版本紀錄」還原。')) return;
    takeSnapshot('重設前', state.progress, true);   // 最危險的操作，強制留一份
    initEmptyProgress();
    generateLessonSlots();
    renderAll();
    // 重設是明確的覆蓋意圖，必須走 force。走一般存檔路徑的話，遠端那份舊資料
    // 會讓它被判定成衝突而永遠送不出去 —— 表面上重設了，下次載入又整份回來。
    try {
      await apiSaveProgress(true);
      toast('進度已重設（可從版本紀錄還原）', 'warning');
    } catch (e) {
      toast('重設後同步失敗: ' + e.message, 'error');
    }
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

    const progressGistId = $('setup-progress-gist-id')?.value.trim();
    if (progressGistId) {
      state.progressGistId = progressGistId;
      lsSet(LS_KEYS.progressGistId, progressGistId);
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
    state.selectedClasses = new Set(lsGet(LS_KEYS.selectedClasses, []));
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
          if (state.progressGistId) {
            if (localHasUnpushed()) {
              // 本機有還沒送出的修改 —— 先合併推上去，不能讓遠端直接蓋掉。
              // apiSaveProgress 會先讀遠端再逐節合併，這條路本來就是安全的。
              await apiSaveProgress();
            } else {
              await apiLoadProgress();
            }
          }
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

    // Bind day navigation
    $('today-prev')?.addEventListener('click', () => navDay(-1));
    $('today-next')?.addEventListener('click', () => navDay(1));
    $('today-today')?.addEventListener('click', () => navDay(0));

    // Bind week navigation
    $('week-prev')?.addEventListener('click', () => navWeek(-1));
    $('week-next')?.addEventListener('click', () => navWeek(1));
    $('week-this')?.addEventListener('click', () => navWeek(0));

    // Bind modal close
    $('modal-close')?.addEventListener('click', () => $('modal-overlay')?.classList.remove('open'));
    $('modal-overlay')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
    });

    // Bind auto-sync on visibility change
    document.addEventListener('visibilitychange', async () => {
      // 切離畫面（手機切到別的 App）＝ 立刻把待存的內容送出，不等 debounce
      if (document.hidden) {
        if (state.isDirty) {
          clearTimeout(state.saveTimer);
          saveProgressNow();
        }
        return;
      }

      if (!state.token || !state.plan) return;
      // 還有沒同步的修改就先不要被遠端覆蓋，改成把它送出去。
      // 只檢查 isDirty 不夠 —— 它只涵蓋「這個工作階段」的編輯，
      // 上次沒送出去的東西要看時間戳（localHasUnpushed）。這裡同時也是
      // 「回到畫面上就重試一次」的入口，離線時失敗的存檔會在這時候補上。
      if (state.isDirty || localHasUnpushed()) { saveProgressNow(); return; }
      try {
        if (state.progressGistId) await apiLoadProgress();
        generateLessonSlots();
        renderAll();
      } catch { }
    });

    // 恢復連線就立刻再試一次，不必等退避計時器跑完
    window.addEventListener('online', () => {
      if (!state.isDirty && !localHasUnpushed()) return;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.retryDelay = 0;
      saveProgressNow();
    });

    // Register SW
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('./sw.js'); } catch { }
    }

    // Set active nav tab and view panel
    switchView(state.currentView);
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();