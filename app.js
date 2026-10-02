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
    dayOffset: 0,         // 0 = today, -1 = yesterday, 1 = tomorrow
    // 行事曆那個當天小視窗正在看哪一天。用來在資料變動後重畫它 ——
    // 在裡面按「全部完成」或事後按「復原」，清單上的狀態都要跟著更新。
    dayModalDate: null
  };

  // Class colors for calendar
  const CLASS_COLORS = {
    '[class-A]': '#3b82f6', '[class-B]': '#8b5cf6',
    '[class-C]': '#10b981', '[class-D]': '#14b8a6',
    '[class-E]': '#f59e0b', '[class-F]': '#ef4444'
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

  // 帶動作的提示要留久一點 —— 3 秒內老師還沒意識到自己勾錯了。
  const TOAST_ACTION_MS = 8000;

  function toast(msg, type = 'info', action = null) {
    const c = $('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    let timer;
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        clearTimeout(timer);
        el.remove();
        action.onClick();
      });
      el.appendChild(btn);
      // 淡出寫死在 .toast 的 animation-delay（2.7s）。帶按鈕的得把淡出往後推，
      // 否則它會在還來得及按之前就先淡掉。
      el.style.animation = `slideIn 0.3s ease, fadeOut 0.3s ease ${(TOAST_ACTION_MS - 300) / 1000}s`;
    }
    c.appendChild(el);
    timer = setTimeout(() => el.remove(), action ? TOAST_ACTION_MS : 3000);
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

  // 統測週、考試週是全校同一天的事，跟假期一樣寫一次就夠。
  // 課節表上每個班都各自寫了一遍「統測」，加起來一大串 —— 老師看日曆時
  // 只想知「這天是統測週」，不想看六個班重複六次，所以改由這裡統一出標籤。
  // 格子窄，用簡稱；點進去看當天清單時才顯示全名。
  function examLabel(event) {
    if (/統測/.test(event)) return '統測';
    if (/考試/.test(event)) return '考試';
    return event;
  }

  function buildExamTags() {
    const tags = new Map();
    for (const r of buildExamRanges()) {
      const full = r.event || '';
      const short = examLabel(full);
      for (let d = new Date(r.start); d <= r.end; d.setDate(d.getDate() + 1)) {
        tags.set(fmtDate(d), { short, full });
      }
    }
    return tags;
  }

  // ============ DATA: ASSESSMENT DATES ============
  // plan.json 的 assessments 一直沒有被用到。老師早就把每班的測驗、考試、
  // 功課截止日都輸入了，行事曆上卻什麼都看不到 —— 這一塊把它攤平成「日期 → 事件」。
  const ASSESS_LABEL = {
    test:    { text: '測驗', cls: 'cal-assess-test' },
    midterm: { text: '期中考', cls: 'cal-assess-exam' },
    exam:    { text: '考試', cls: 'cal-assess-exam' },
    hw:      { text: '交', cls: 'cal-assess-hw' },
    cw:      { text: '堂課', cls: 'cal-assess-cw' }
  };

  // 只挑字串裡的 YYYY-MM-DD。homework.assign 長成 "W3 2026-09-14"，
  // 整串丟給 parseDate 會拿到 Invalid Date，所以一律先把日期挑出來。
  function datesIn(raw) {
    return (String(raw || '').match(/\d{4}-\d{2}-\d{2}/g) || [])
      .map(parseDate).filter(d => !isNaN(d));
  }

  // 單日回一天；寫成區間的（期中考、部分班的考試）逐日展開，這樣整段都看得到。
  function expandDates(raw) {
    const ds = datesIn(raw);
    if (ds.length <= 1) return ds;
    const out = [];
    for (let d = new Date(ds[0]); d <= ds[ds.length - 1]; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }

  // 老師 2026-10-02 指示：assessments 那份資料他要先自己整理過，整理好之前
  // 不要顯示。日曆上的「測驗／期中考／考試／交／堂課」標籤全部來自它，
  // 開關就這一個。整理好之後改成 true 就即刻回來。
  // 關掉期間，日曆上的作業／統測提醒改由課節表抄下來的 notes 負責（見下）。
  const SHOW_ASSESSMENTS = false;

  function buildAssessmentIndex() {
    const index = new Map();
    if (!SHOW_ASSESSMENTS) return index;
    const all = state.plan?.assessments;
    if (!all || typeof all !== 'object') return index;

    const push = (dateObj, type, detail, cls) => {
      const key = fmtDate(dateObj);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ type, detail, cls });
    };

    for (const [cls, sems] of Object.entries(all)) {
      // 有些班是寫 {"same_as": "[class-C]"}，沿用被指向那一班的內容
      const own = sems && sems.same_as ? all[sems.same_as] : sems;
      if (!own || typeof own !== 'object') continue;
      // 行事曆上方已經有班級篩選了，這裡必須跟著同一個篩選，
      // 否則會冒出「我根本沒選這班」的測驗日。
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;

      for (const v of Object.values(own)) {
        if (!v || typeof v !== 'object') continue;
        for (const t of v.tests || [])
          for (const d of expandDates(t.date)) push(d, 'test', t.topic || t.id || '', cls);
        for (const c of v.classwork || [])
          for (const d of expandDates(c.date)) push(d, 'cw', c.topic || c.id || '', cls);
        // 只畫截止日。派發日也畫的話一份功課會佔掉兩格，格子本來就不大。
        for (const h of v.homework || [])
          for (const d of expandDates(h.due)) push(d, 'hw', h.topic || h.id || '', cls);
        for (const [key, type] of [['midterm', 'midterm'], ['exam', 'exam']]) {
          const o = v[key];
          if (!o || typeof o !== 'object') continue;
          for (const d of expandDates(o.period || o.date)) push(d, type, o.scope || '', cls);
        }
      }
    }
    return index;
  }

  // ============ DATA: 課節表的非上課日備註 ============
  // 課節表上有些格沒有節數（那天不用上課），但寫了「交作業二」「統測」這些事。
  // 它們不是課堂，不進課堂清單，但那天要記得，所以畫在日曆上。
  //
  // 顯示時一定要帶班級 —— 六個班都各有「交作業二」，只寫「交作業二」的話
  // 老師根本看不出是哪一班。
  //
  // kind 決定顏色：交／派是功課，統測／考試是測考，其餘是雜項。
  // 顏色分三種：交／派作業藍、統測琥珀、考試紅，其餘灰。
  // 「統測」用搜尋而不是比對開頭 —— 課節表上寫的是「統測 …」，
  // 但老師另外記的考試時間寫成「物理統測 第3節」，兩種都要著色。
  function noteKind(text) {
    if (/^交/.test(text)) return 'hw';
    if (/^派/.test(text)) return 'hw';
    if (/統測/.test(text)) return 'test';
    if (/考試/.test(text)) return 'exam';
    return 'misc';
  }

  function buildNoteIndex() {
    const index = new Map();
    const sched = state.plan?.schedule;
    if (!sched || typeof sched !== 'object') return index;
    for (const [cls, info] of Object.entries(sched)) {
      // 跟行事曆上方的班級篩選同一套，沒選的班不畫。
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
      for (const n of (info.notes || [])) {
        const date = n?.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
        if (!index.has(date)) index.set(date, []);
        index.get(date).push({ cls, text: n.text || '', kind: noteKind(n.text || '') });
      }
    }
    return index;
  }

  // max 預設 2 —— 月曆格子只有六十幾 px 寬，一格裡還要放課堂藥丸，
  // 備註塞太多會把課堂擠出去。當日清單（openDayModal）不受這個限制。
  function renderNoteChips(notes, max = 2) {
    if (!notes || notes.length === 0) return '';
    let html = '<div class="cal-note">';
    for (const n of notes.slice(0, max)) {
      html += `<span class="cal-note-chip cal-note-${n.kind}" title="${escHtml(n.cls + '：' + n.text)}">`
        + escHtml(`${n.cls}：${n.text}`) + '</span>';
    }
    if (notes.length > max) {
      html += `<span class="cal-note-chip cal-note-more" title="${escHtml(notes.slice(max).map(n => n.cls + '：' + n.text).join('\n'))}">`
        + `+${notes.length - max}</span>`;
    }
    return html + '</div>';
  }

  // 同一天同一個測驗六個班都要考時，畫六個「測驗」沒有意義，
  // 所以同型別＋同範圍的合成一個，後面掛班級數。
  //
  // 考試與期中考例外，只按型別合併：它們是全校統一的日子，但每個班的 scope
  // 寫法不一樣（[class-A]寫「機械運動+聲現象…」、[class-C]寫「功與機械能…」、有的班
  // 根本空著），照 scope 分組會讓同一天冒出三個「考試」標記。scope 收進 tooltip。
  // max 預設 3 —— 月曆格子只有六十幾 px 寬，塞不下更多。
  // 當日清單（openDayModal）不受這個限制，那裡有整個視窗的寬度。
  function renderAssessChips(events, max = 3) {
    if (!events || events.length === 0) return '';
    const schoolWide = t => t === 'exam' || t === 'midterm';
    const groups = new Map();
    for (const e of events) {
      const k = schoolWide(e.type) ? e.type : e.type + '|' + e.detail;
      if (!groups.has(k)) groups.set(k, { type: e.type, details: [], classes: [] });
      const g = groups.get(k);
      if (e.detail && !g.details.includes(e.detail)) g.details.push(e.detail);
      if (!g.classes.includes(e.cls)) g.classes.push(e.cls);
    }
    const list = [...groups.values()];
    const tip = g => ASSESS_LABEL[g.type].text + (g.details.length ? '：' + g.details.join('／') : '')
      + '　' + g.classes.join('、');

    let html = '<div class="cal-assess">';
    for (const g of list.slice(0, max)) {
      const meta = ASSESS_LABEL[g.type];
      html += `<span class="cal-assess-chip ${meta.cls}" title="${escHtml(tip(g))}">`
        + escHtml(meta.text)
        + (g.classes.length > 1 ? `<span class="cal-assess-n">${g.classes.length}</span>` : '')
        + '</span>';
    }
    if (list.length > max) {
      const rest = list.slice(max);
      html += `<span class="cal-assess-chip cal-assess-more" title="${escHtml(rest.map(tip).join('\n'))}">`
        + `+${rest.length}</span>`;
    }
    return html + '</div>';
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
    const level = className.startsWith('高一') ? '[class-E]'
      : className.startsWith('高二') ? '[class-F]'
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

  // ============ DATA: 逐日課節表 ============
  // plan 的 schedule[班級].days 是課節表「日期／節數／內容」的逐字抄錄。
  // 有它就完全照它排課：日期、節數、內容都不再從 weekly_slots、假期表、考試表
  // 推導 —— 推導只要有一處對不上，後面每一節都會位移。沒有 days 的班級／學期
  // （舊 plan、VEX班、創客班）才走原本的推導路徑。
  function explicitDays(className, semester) {
    const d = state.plan?.schedule?.[className]?.days?.[semester];
    return Array.isArray(d) && d.length ? d : null;
  }

  // 課節表只寫「這天有幾節」，不寫第幾節。節次由該班的 weekly_slots 取該星期的
  // 前 N 個（依節次排序 —— weekly_slots 的陣列順序不保證照節次排）。
  // 該星期沒排課就退回該班第一個時段：26-27 只有[class-C]／乙 2027-04-24（星期六）
  // 這一格，課節表上沒有時間可抄。
  function slotsForDay(slotsByDay, dow, n) {
    const have = (slotsByDay[dow] || []).slice().sort((a, b) => a.period - b.period);
    const out = [];
    for (let k = 0; k < n; k++) out.push(have[k] || have[have.length - 1] || { period: null, time: '' });
    return out;
  }

  function groupSlotsByDay(slots) {
    const byDay = {};
    for (const s of slots) {
      const dn = DAYS[s.day];
      if (!byDay[dn]) byDay[dn] = [];
      byDay[dn].push(s);
    }
    return byDay;
  }

  // 產生一個班一個學期的全部課堂。八個班、兩個學期都走這一段，各處才不會漂掉。
  // oldLessons 有傳就沿用其中的勾選／備註／主題覆寫（重新產生時用）。
  function buildClassLessons(className, semester, oldLessons) {
    const info = state.plan?.schedule?.[className];
    if (!info) return [];
    const slots = info.weekly_slots || [];
    const days = explicitDays(className, semester);
    if (!days && slots.length === 0) return [];

    const slotsByDay = groupSlotsByDay(slots);
    const slotDayNums = slots.map(s => DAYS[s.day]).sort((a, b) => a - b);
    // 內容一律攤成逐節的清單。日期是課節表的事實，不會動；會動的只有
    // 「每一節配到哪一條內容」，見下面 ci 的說明。
    const content = days
      ? days.flatMap(d => Array(Math.max(1, d.periods || 1)).fill({ label: d.content || '', chapter: '' }))
      : flattenContent(className, semester);

    // 先把「哪一天、第幾節」列出來，兩條路徑最後都收斂成同一種形狀。
    const plan = [];
    if (days) {
      for (const d of days) {
        const dow = dayOfWeek(parseDate(d.date));
        const n = Math.max(1, d.periods || 1);
        const daySlots = slotsForDay(slotsByDay, dow, n);
        for (let k = 0; k < n; k++) plan.push({ date: d.date, dow, slot: daySlots[k], nth: k + 1 });
      }
    } else {
      const holidaySet = buildHolidaySet();
      const examRanges = buildExamRanges();
      const ranges = getSemesterRanges();
      const range = semester === 'semester1' ? ranges.s1 : ranges.s2;
      for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) {
        const dow = dayOfWeek(d);
        if (!slotDayNums.includes(dow)) continue;
        const dateStr = fmtDate(d);
        if (isHoliday(dateStr, holidaySet)) continue;
        if (isExamDay(dateStr, examRanges)) continue;
        const daySlots = (slotsByDay[dow] || []).slice().sort((a, b) => a.period - b.period);
        for (let k = 0; k < daySlots.length; k++) plan.push({ date: dateStr, dow, slot: daySlots[k], nth: k + 1 });
      }
    }

    // 課堂的身分是「日期＋當天第幾節」，不是名次。名次會因為 plan 而整體
    // 位移，用它當鍵會讓老師勾的、寫的備註貼到別的日期上。
    const semTag = semester === 'semester1' ? 's1' : 's2';
    const seen = new Set();
    const out = [];

    // 一節配一條內容，就是照課節表的次序派下去。要改次序的話，老師是在卡片
    // 上直接改主題，或者按「➜ 加到下一節」把這一節的內容併進下一節 ——
    // 排課程式這邊不去猜「老師落後了」。
    for (const p of plan) {
      const idx = out.length;
      const id = `${className}_${semTag}_${p.date}_${p.nth}`;
      if (seen.has(id)) console.warn('課堂 id 重複，findLesson 會找到錯的一節：', id);
      seen.add(id);
      const old = oldLessons?.find(x => x.id === id);

      const c = content[idx] || { label: '(待補)' };
      const label = c.label || '(待補)';

      out.push({
        id,
        class: className,
        semester,
        lessonNum: idx + 1,
        seq: p.nth,                 // 同一天的第幾節，也是存檔時的身分
        date: p.date,
        dayOfWeek: DAY_NAMES[p.dow],
        time: p.slot.time,
        period: p.slot.period,
        topic: isOverridden(old) ? old.topic : label,
        baseTopic: label,           // 產生時的主題，用來判斷老師有沒有改過
        chapter: c.chapter || '',
        done: old?.done || false,
        note: old?.note || '',
        hw: old?.hw || null
      });
    }
    return out;
  }

  function generateLessonSlots() {
    if (!state.plan) return;
    const allLessons = {};

    for (const className of Object.keys(state.plan.schedule)) {
      const slots = state.plan.schedule[className]?.weekly_slots || [];
      if (slots.length === 0
        && !explicitDays(className, 'semester1')
        && !explicitDays(className, 'semester2')) continue;
      allLessons[className] = [
        ...buildClassLessons(className, 'semester1'),
        ...buildClassLessons(className, 'semester2')
      ];
    }

    state.lessons = allLessons;
    mergeProgress();
    pruneStaleUiState();
  }

  // 側邊欄篩選存在 localStorage。班級會因為換了 plan 而不存在，
  // 不修剪的話會留著永遠選不到東西的篩選條件。
  function pruneStaleUiState() {
    // 班級也可能因為換了 plan 而不存在了，一起清掉，否則側邊欄會篩選到空集合
    const classes = new Set(Object.keys(state.plan?.schedule || {}));
    const before = state.selectedClasses.size;
    for (const c of state.selectedClasses) if (!classes.has(c)) state.selectedClasses.delete(c);
    if (state.selectedClasses.size !== before) lsSet(LS_KEYS.selectedClasses, [...state.selectedClasses]);
  }

  // ============ DATA: MERGE PROGRESS INTO LESSONS ============
  function hasDate(rec) { return /^\d{4}-\d{2}-\d{2}$/.test(rec?.date || ''); }
  function lessonKey(l) { return `${l.date}#${l.seq}`; }

  // 課節表有一天只寫了節數、沒寫節次：[class-C]／乙 2027-04-24（星期六），
  // 兩班的 weekly_slots 都沒有星期六。那一節的 period 是 null，寧可少顯示一段，
  // 也不要編一個不存在的節次或時間出來。
  function periodLabel(l) {
    return Number.isInteger(l?.period) ? `第${l.period}節` : '';
  }
  function periodSpan(l) {
    const p = periodLabel(l);
    return p ? `<span>${p}</span>` : '';
  }
  function classPeriod(l) {
    const p = periodLabel(l);
    return p ? `${l.class} ${p}` : l.class;
  }

  // 課堂紀錄的排序與身分都以「日期＋當天第幾節」為準。lesson 只是名次，換 plan
  // 就會整體位移，不能拿來當身分。
  function compareRecords(a, b) {
    const da = hasDate(a) ? a.date : '';
    const db = hasDate(b) ? b.date : '';
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.seq || a.lesson || 0;
    const sb = b.seq || b.lesson || 0;
    if (sa !== sb) return sa - sb;
    return (a.lesson || 0) - (b.lesson || 0);
  }

  // 把一組紀錄依「日期＋當天第幾節」編號。同一天有多節時，第幾節由 seq 決定；
  // 沒有 seq 的舊紀錄就依排序後的名次補上。
  // 本機與遠端要各算一次，不能共用計數器 —— 共用會讓遠端接著本機的數字往下數，
  // 兩邊的鍵就對不起來。
  function recordKeyer() {
    const nth = new Map();
    return rec => {
      if (!hasDate(rec)) return `n${rec.lesson}`;
      const c = (nth.get(rec.date) || 0) + 1;
      nth.set(rec.date, c);
      return `${rec.date}#${rec.seq || c}`;
    };
  }

  function mergeProgress() {
    if (!state.progress?.classes) return;
    for (const [className, classData] of Object.entries(state.progress.classes)) {
      const classLessons = state.lessons[className];
      if (!classLessons) continue;
      for (const semKey of ['semester1', 'semester2']) {
        const semData = classData[semKey];
        if (!semData?.lessons) continue;

        const byKey = new Map();
        const byNum = new Map();
        for (const l of classLessons) {
          if (l.semester !== semKey) continue;
          byKey.set(lessonKey(l), l);
          byNum.set(l.lessonNum, l);
        }

        const keyOf = recordKeyer();
        for (const rec of semData.lessons.slice().sort(compareRecords)) {
          // 日期優先，而且有日期就只用日期。退回名次配只給完全沒日期的舊紀錄 ——
          // 有日期的紀錄配不到，代表那一節在現在的 plan 上不存在（孤兒），
          // 用名次硬配會把它貼到別的日期上，正是要避免的事。
          const lesson = hasDate(rec) ? byKey.get(keyOf(rec)) : byNum.get(rec.lesson);
          if (!lesson) continue;      // 孤兒：原樣留在 state.progress，存檔時帶下去
          lesson.done = rec.done || false;
          lesson.note = rec.note || '';
          lesson.hw = rec.hw || null;
          if (rec.topic_override) lesson.topic = rec.topic_override;
        }
      }
    }
  }

  // ============ DATA: SAVE PROGRESS ============
  // 主題是否被老師手動改過。比對的是產生當下的 baseTopic，不是重算出來的內容 ——
  // 課程表一改，每一節對應的內容就整批換過，重算會把整班的未修改課堂都誤判成覆寫。
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
    // schema 2 = 逐節紀錄多了 seq（同一天的第幾節），合併的鍵從 lesson 名次改成
    // 「日期＋seq」。舊版 app 仍用名次當鍵，兩版同時寫會撞號，所以存檔時要提醒。
    progress._meta.schema = 2;
    progress._meta.last_modified = stampNow();
    const now = progress._meta.last_modified;

    for (const [className, lessons] of Object.entries(state.lessons)) {
      const classData = {};
      for (const semKey of ['semester1', 'semester2']) {
        const semLessons = lessons.filter(l => l.semester === semKey);
        const prevSem = state.progress?.classes?.[className]?.[semKey];
        const prevRecords = prevSem?.lessons || [];

        const byKey = new Map();
        const byNum = new Map();
        const keyOf = recordKeyer();
        for (const r of prevRecords.slice().sort(compareRecords)) {
          if (hasDate(r)) byKey.set(keyOf(r), r);
          else byNum.set(r.lesson, r);
        }

        const claimed = new Set();
        const emitted = semLessons.map(l => {
          const prev = byKey.get(lessonKey(l)) || byNum.get(l.lessonNum);
          if (prev) claimed.add(prev);
          // 碰過的蓋新時間戳；沒碰過的沿用載入時帶進來的值。
          // 這裡刻意不給沒有值的紀錄補一個「現在」—— 那會讓每一筆沒碰過的課堂
          // 都被當成有變動而寫進文件（稀疏過濾整段失效），而且會讓它們在合併時
          // 無條件贏過別台裝置真正較新的紀錄。代理值改在 mergeProgressData 裡給。
          const updated_at = state.dirtyLessons.has(l.id) ? now : prev?.updated_at;
          // 最後一項是關鍵：紀錄一旦被碰過就永遠保留。少了它，「取消打卡」會讓
          // 所有欄位變成 falsy 而整筆消失，合併時遠端較舊的 done:true 就會復活。
          if (!(l.done || l.note || l.hw || isOverridden(l) || updated_at)) return null;
          return {
            lesson: l.lessonNum,
            date: l.date,
            seq: l.seq,
            done: l.done,
            note: l.note || undefined,
            hw: l.hw || undefined,
            topic_override: isOverridden(l) ? l.topic : undefined,
            updated_at
          };
        }).filter(Boolean);

        // 配不到目前任何一節的紀錄原樣帶著走。老師真的上過、但 plan 上沒有這一節
        // （例：[class-E] 9/11 開學彌撒）不該因為存一次檔就消失 —— 這裡是每次存檔
        // 都會跑的路徑，少了這段，切換 plan 後的第一次存檔就把它清掉了。
        // 原樣 = 不補 updated_at，否則它會在往後每次合併都無條件贏過別台裝置。
        const orphans = prevRecords.filter(r => !claimed.has(r));

        // shift_count 是從前的「順延」留下來的，現在已經沒有人會改它、也沒有人
        // 讀它來排內容了。原樣帶着只是為了讓新舊裝置算出來的內容鍵一模一樣
        // （contentKey 沒有剔除它），免得升版時白做一次全量上傳。
        classData[semKey] = {
          shift_count: prevSem?.shift_count || 0,
          lessons: [...emitted, ...orphans].sort(compareRecords)
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

  // 逐節合併。課堂紀錄彼此獨立 —— A 裝置勾了[class-C]第 12 節、B 裝置勾了[class-E]第 8 節
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
    // 比對「內容」時只看語意欄位：時間戳不同不等於資料不同，否則每次合併都會
    // 誤報一堆「被取代」，通知就失去意義了。lesson 是可變的名次、seq 是新舊版
    // 的差異，兩者都不算資料 —— 把它們算進去，光是換版本就會讓每一筆都被當成
    // 「本機被取代」，然後每次存檔都逼出兩份快照。
    const recKey = r => JSON.stringify([
      hasDate(r) ? r.date : '', !!r.done, r.note || '', r.hw || null,
      r.topic_override || ''
    ]);

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

        // shift_count 是舊「順延」的遺物，兩邊都只會是 0，但是純量沒辦法逐節
        // 合併，所以照舊比時間戳決定誰新 —— 留著讓舊裝置的資料合併時有着落。
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

        // 鍵用「日期＋當天第幾節」，不能用 lesson 名次：換 plan 之後同一筆紀錄在
        // 兩台裝置上的名次會不同，而且孤兒紀錄會跟線上課堂撞號 —— 撞到就有
        // 一筆被無聲吃掉，連「被取代 N 筆」都不會報。
        const byKey = new Map();
        const localKeyOf = recordKeyer();
        for (const r of (ls.lessons || []).slice().sort(compareRecords)) byKey.set(localKeyOf(r), r);
        const remoteKeyOf = recordKeyer();
        for (const r of (rs.lessons || []).slice().sort(compareRecords)) {
          const k = remoteKeyOf(r);
          const cur = byKey.get(k);
          if (!cur) { byKey.set(k, r); continue; }
          const lt = ts(cur, localFallback);
          const rt = ts(r, remoteStamp);
          const differs = recKey(cur) !== recKey(r);
          if (rt > lt) {
            if (differs) lostLocal++;                    // 遠端較新，本機這筆被取代
            byKey.set(k, r);
          } else if (lt > rt) {
            if (differs) lostRemote++;                   // 本機較新，遠端這筆被取代
          } else if (differs) {
            lostRemote++;                                // 平手時本機勝（＝老師手上這台）
          }
        }
        out.lessons = [...byKey.values()].sort(compareRecords);
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
    // 還沒有進度 Gist ＝ 還沒有遠端可以「不同步」。首次使用時 setup 畫面就是叫人
    // 把這個欄位留空（系統自動建立），而那條路徑會經過 initEmptyProgress() 留下一份
    // 有 last_modified 的空文件、卻沒有 lastRemoteStamp —— 少了這一行，這裡會永遠
    // 判定為 true，而 init() 又因為沒有 gist id 而不會嘗試存檔，橫幅就再也消失不了。
    if (!state.progressGistId) return false;
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
        // 雲端沒有 schema 2 = 上一次寫它的是舊版 app，合併的鍵還是 lesson 名次。
        // 新舊版同時寫會撞號，先把遠端整份留一份底。不擋存檔 —— 讓老師的編輯
        // 卡在離線，比偶爾多一份快照糟得多。每台裝置每次開啟只吵一次。
        if (!remote._meta.schema && !state.warnedOldSchema) {
          state.warnedOldSchema = true;
          takeSnapshot('雲端進度是舊版 app 寫的（尚未升級）', remote, true);
          toast('有一台裝置的 app 還是舊版，已先備份雲端進度', 'warning');
        }
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
      // renderAll 裡面已經呼叫過 renderSyncBanner；這裡改用 flashSaved，
      // 存檔期間還有新編輯（isDirty 仍為真）時它會照樣顯示「尚未同步」。
      flashSaved();
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
    // 逾期＝日子過了還沒勾。內容調整（改主題、「加到下一節」）不影響這裡，
    // 那一節沒勾就是沒勾。
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
  let savedFlashUntil = 0;
  let savedFlashTimer = null;
  function renderSyncBanner() {
    const el = $('sync-banner');
    if (!el) return;
    const pendingForce = lsGet(LS_KEYS.pendingForce, '') === '1';
    const unsynced = state.isDirty || localHasUnpushed();
    const flashing = !unsynced && Date.now() < savedFlashUntil;
    const key = `${unsynced}|${pendingForce}|${flashing}`;
    if (key === lastBannerState) return;   // 別讓每次 markDirty 都重建 DOM
    lastBannerState = key;

    if (!unsynced && !flashing) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');

    if (flashing) {
      el.classList.add('saved');
      el.textContent = '✓ 已儲存';
      return;
    }
    el.classList.remove('saved');
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

  // 存檔成功後讓橫幅短暫變成「已儲存」再自己消失。老師改完一個東西最想知道的
  // 就是到底存了沒 —— 與其讓他盯著那個「尚未同步」猜，不如直接講。
  function flashSaved() {
    savedFlashUntil = Date.now() + 2500;
    lastBannerState = null;
    renderSyncBanner();
    clearTimeout(savedFlashTimer);
    savedFlashTimer = setTimeout(() => {
      lastBannerState = null;
      renderSyncBanner();
    }, 2600);
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
        if (!l.done && parseDate(l.date) < td) totalOverdue++;
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
    const odEl = $('stat-overdue');
    odEl.textContent = totalOverdue;
    // 為 0 時不標紅。永遠掛著一個紅色 0 只會讓人對紅色麻木，
    // 真的有欠的時候那個紅就不跳了。
    odEl.classList.toggle('is-overdue', totalOverdue > 0);
    // 這個數字算的是「正在看的那一天」，不是今天。用左右鍵翻到別天時
    // 標籤還寫「今日」會誤導。
    $('stat-today-label').textContent = state.dayOffset === 0 ? '今日' : '當日';
    $('stat-today').textContent = `${dayDone}/${dayLessons.length}`;

    if (dayLessons.length === 0) {
      paintLessons(container, `
        <div class="empty-state">
          <div class="icon">📅</div>
          <h3>${state.dayOffset === 0 ? '今天沒有課堂' : '當天沒有課堂'}</h3>
          <p>切換到「本週課表」查看本週安排</p>
        </div>`);
      return;
    }

    // 「全部完成」那條只在當天還有沒勾的課時出現。
    const dayUndone = dayLessons.filter(l => !l.done).length;
    const dayBarHtml = dayUndone === 0 ? '' : `
      <div class="day-actions">
        <span class="day-actions-text">${dayUndone} 節未完成</span>
        <button class="btn btn-sm btn-success" id="day-done-all">✓ 全部完成</button>
      </div>`;

    paintLessons(container, dayBarHtml + dayLessons.map(l => renderLessonCard(l)).join(''));

    const doneAllBtn = container.querySelector('#day-done-all');
    if (doneAllBtn) doneAllBtn.addEventListener('click', () => markDayDone(viewDateStr));
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
    paintLessons(container, html);
  }

  // ============ UI: LESSON CARD ============
  function renderLessonCard(l) {
    const td = today();
    const ld = parseDate(l.date);
    let statusClass = '';
    if (l.done) statusClass = 'completed';
    else if (isSameDay(ld, td)) statusClass = 'today';
    else if (ld < td) statusClass = 'overdue';

    const stats = getClassStats(l.class);
    const statusBadge = stats.status === 'ok' ? '' : `<span class="badge ${stats.status === 'behind' ? 'badge-behind' : 'badge-ahead'}" style="margin-left:8px">${stats.status === 'behind' ? '落後' : '領先'}</span>`;

    const nextLesson = nextLessonOf(l);

    // 主題與備註一律渲染成真的輸入框，只是平時靠 CSS 裝成一行文字（.inline-edit）。
    // 以前要按「展開」才生得出輸入框，改一個欄位得先點兩下；現在點一下就能打，
    // 也不必再維護「哪幾張卡是展開的」那份狀態。
    return `
      <div class="lesson-card ${statusClass}" data-id="${l.id}" data-class="${escHtml(l.class)}">
        <div class="lesson-header">
          <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
            <button class="check-btn ${l.done ? 'checked' : ''}" data-id="${l.id}" title="標記這節上完了">✓</button>
            <div style="min-width:0">
              <div class="lesson-class">${escHtml(l.class)}${statusBadge}</div>
              <div class="lesson-meta">
                ${periodSpan(l)}
                <span>${l.dayOfWeek} ${l.time}</span>
              </div>
            </div>
          </div>
          <div class="lesson-actions">
            ${nextLesson ? `<button class="btn btn-sm btn-outline carry-btn" data-id="${l.id}" title="把這一節的內容補進 ${fmtDisplay(nextLesson.date)} 那一節，兩條一齊上">➜ 加到下一節</button>` : ''}
            <button class="btn btn-sm btn-outline hw-btn" data-id="${l.id}">📋 作業</button>
          </div>
        </div>
        <div class="lesson-topic">
          <input class="inline-edit" type="text" data-field="topic" data-id="${escHtml(l.id)}"
                 value="${escHtml(l.topic)}" placeholder="輸入教學主題" aria-label="教學主題">
        </div>
        <div class="lesson-note">
          <textarea class="inline-edit" data-field="note" data-id="${escHtml(l.id)}" rows="1"
                    placeholder="點此寫課後備註…" aria-label="課後備註">${escHtml(l.note)}</textarea>
        </div>
        ${l.hw ? `<div class="lesson-hw">📋 ${escHtml(typeof l.hw === 'string' ? l.hw : l.hw.topic || '')}</div>` : ''}
      </div>`;
  }

  // textarea 不會自己長高。備註是課後才補的，常越寫越長，固定高度會冒出捲軸。
  // 隱藏中的元素 scrollHeight 是 0，跳過才不會把它壓成 0 高。
  function autoGrow(ta) {
    ta.style.height = 'auto';
    if (ta.scrollHeight) ta.style.height = ta.scrollHeight + 'px';
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 課堂清單是整批 innerHTML 重建的。如果重建的當下老師正好在打字，那個欄位會
  // 連同還沒送出的字一起被換掉。這裡在重建前記下是哪一節的哪個欄位、游標停在
  // 第幾個字，重建後還原。（值本身已經由 input 事件即時寫回 state。）
  function paintLessons(container, html) {
    const ae = document.activeElement;
    const editing = ae && container.contains(ae) && ae.dataset && ae.dataset.field ? ae : null;
    const start = editing ? editing.selectionStart : null;
    const end = editing ? editing.selectionEnd : null;

    container.innerHTML = html;
    bindLessonCardEvents(container);

    if (!editing) return;
    const next = container.querySelector(
      `[data-field="${editing.dataset.field}"][data-id="${editing.dataset.id}"]`);
    if (!next) return;   // 那一節被別台裝置改掉了，不硬把焦點塞回去
    next.focus();
    if (typeof start === 'number') { try { next.setSelectionRange(start, end); } catch { } }
  }

  function bindLessonCardEvents(container) {
    container.querySelectorAll('.check-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleDone(btn.dataset.id);
      });
    });
    container.querySelectorAll('.carry-btn').forEach(btn => {
      btn.addEventListener('click', () => carryToNext(btn.dataset.id));
    });
    container.querySelectorAll('.hw-btn').forEach(btn => {
      btn.addEventListener('click', () => openHwModal(btn.dataset.id));
    });

    // 每按一鍵就寫回 state，不等失焦。這不只是「早點存」—— apiSaveProgress
    // 收尾時靠 editSeq 判斷要不要重建課堂，而那個判斷只有在打字會遞增 editSeq
    // 時才擋得住「存檔完成把老師正在打的欄位重建掉」。綁 change 的話打字期間
    // editSeq 不動，防護形同虛設。
    container.querySelectorAll('input[data-field="topic"]').forEach(inp => {
      inp.addEventListener('input', () => updateTopic(inp.dataset.id, inp.value));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Escape') inp.blur();
      });
    });
    container.querySelectorAll('textarea[data-field="note"]').forEach(ta => {
      autoGrow(ta);
      // 聚焦時重量一次：字型載入完成或視窗大小改變後，原本算好的高度會不準
      ta.addEventListener('focus', () => autoGrow(ta));
      ta.addEventListener('input', () => {
        autoGrow(ta);
        updateNote(ta.dataset.id, ta.value);
      });
      // 備註可以換行，所以 Enter 是換行、要按 Esc 或 ⌘/Ctrl+Enter 才收起來
      ta.addEventListener('keydown', e => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ta.blur();
      });
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

  // 把課堂按日期分組，同一天之內照上課時間排。
  // 行事曆原本只分組、沒排序，而外層是照班級跑的，所以格子裡看起來是
  // 「先按班級、再按節次」—— 跟今日／本週兩邊的順序對不起來。
  function groupByDateSorted(lessons) {
    const byDate = {};
    for (const l of lessons) {
      if (!byDate[l.date]) byDate[l.date] = [];
      byDate[l.date].push(l);
    }
    for (const list of Object.values(byDate)) {
      list.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    }
    return byDate;
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

    // Build holiday set
    const holidaySet = buildHolidaySet();
    const assessIndex = buildAssessmentIndex();
    const noteIndex = buildNoteIndex();
    const examTags = buildExamTags();

    // Legend
    if (legend) {
      const classes = Object.keys(state.lessons);
      let legendHtml = classes.map(cls => {
        const color = CLASS_COLORS[cls] || '#64748b';
        const isActive = state.selectedClasses.size === 0 || state.selectedClasses.has(cls);
        const opacity = isActive ? '1' : '0.3';
        return `<span class="cal-legend-item" style="opacity:${opacity};cursor:pointer" data-class="${escHtml(cls)}"><span class="cal-legend-dot" style="background:${color}"></span>${escHtml(cls)}</span>`;
      }).join('');

      // 行事曆上只會出現實際存在的標記種類，圖例也照樣只列那幾種 ——
      // 一直掛著「考試」但整學期沒有考試，只會讓人以為標記漏掉了。
      const present = new Set();
      for (const events of assessIndex.values()) for (const e of events) present.add(e.type);
      if (present.size > 0) {
        legendHtml += '<span class="cal-legend-sep"></span>'
          + [...present].map(t =>
            `<span class="cal-legend-item"><span class="cal-assess-chip ${ASSESS_LABEL[t].cls}">${escHtml(ASSESS_LABEL[t].text)}</span></span>`
          ).join('');
      }

      legend.innerHTML = legendHtml;
      legend.querySelectorAll('.cal-legend-item[data-class]').forEach(item => {
        item.addEventListener('click', () => selectClass(item.dataset.class));
      });
    }

    // 月曆是 6 欄（週一到週六）。星期日不排格子 —— 但「星期日在週末」這件事
    // 不能直接從 1 號算欄位：1 號若剛好是星期日，那一格根本不存在，會把第一格
    // 放到第 7 欄去。所以要找的是第一個「排得出來」的日子，再從它往回推到
    // 那一週的星期一。
    const monthEnd = new Date(year, month + 1, 0);
    const gridStart = (() => {
      let d = new Date(year, month, 1);
      if (d.getDay() === 0) d = addDays(d, 1);
      return addDays(d, -((d.getDay() + 6) % 7));
    })();

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
    const lessonsByDate = groupByDateSorted(allLessons);

    const td = fmtDate(today());
    let html = '<div class="cal-month-grid">';

    // Day headers
    const DAY_HEADERS = ['週一', '週二', '週三', '週四', '週五', '週六'];
    for (const dh of DAY_HEADERS) {
      html += `<div style="font-size:12px;font-weight:600;color:var(--gray-400);text-align:center;padding:8px 0">${dh}</div>`;
    }

    // 逐日排格子：從那一週的星期一開始，一路排到「涵蓋整個月，而且最後一列
    // 補滿」為止。補滿與否是數格子算的，不是拿 daysInMonth 去取餘數 ——
    // daysInMonth 含不排的星期日，兩者差 2~5 天，餘數幾乎必然是錯的，
    // 那正是以前每個月多出一整列空白的原因。
    let cellCount = 0;
    for (let d = new Date(gridStart); ; d = addDays(d, 1)) {
      if (d.getDay() === 0) continue; // 星期日不排
      const inMonth = d.getFullYear() === year && d.getMonth() === month;
      if (!inMonth && d > monthEnd && cellCount % 6 === 0) break;

      if (!inMonth) {
        html += `<div class="cal-day other-month"><div class="cal-day-header"><span class="cal-day-num">${d.getDate()}</span></div></div>`;
        cellCount++;
        continue;
      }

      const dateStr = fmtDate(d);
      const isToday = dateStr === td;
      const isHol = holidaySet.has(dateStr);
      const exam = examTags.get(dateStr);
      const dayLessons = lessonsByDate[dateStr] || [];

      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (isHol) cls += ' holiday';
      if (exam) cls += ' examday';

      // data-date 是「點這格看當天課堂」的依據（openDayModal）。
      // 別的月份的補格不帶，點了才不會跳出一個不屬於這個月的日子。
      html += `<div class="${cls}" data-date="${dateStr}">`;
      html += `<div class="cal-day-header">`;
      html += `<span class="cal-day-num">${d.getDate()}</span>`;
      const tags = [];
      if (exam) tags.push(`<span class="cal-exam-tag">${escHtml(exam.short)}</span>`);
      if (isHol) {
        const hol = getHolidayName(dateStr);
        tags.push(`<span class="cal-holiday-tag">${escHtml(hol) || '假期'}</span>`);
      }
      if (tags.length) html += `<span class="cal-day-tags">${tags.join('')}</span>`;
      html += `</div>`;

      // 測驗／考試／功課截止放在課堂之前 —— 這些是「那天一定要記得」的事，
      // 課堂清單一長就會把它們擠出格子。
      html += renderAssessChips(assessIndex.get(dateStr));
      html += renderNoteChips(noteIndex.get(dateStr));

      for (const l of dayLessons) {
        const statusCls = l.done ? 'done' : (parseDate(l.date) < today() ? 'overdue' : 'pending');
        const color = CLASS_COLORS[l.class] || '#64748b';
        // 班級、打勾、主題各自包一層 —— 手機上每格只有 54px 闊，這三段要能
        // 分開收：班級獨立一行、打勾收起來（顏色已經表示了狀態）、主題讓它截字。
        html += `<div class="cal-lesson cal-lesson-clickable ${statusCls}" style="border-left-color:${color}" data-id="${l.id}">`;
        html += `<span class="cal-lesson-class">${escHtml(l.class)}</span>`;
        html += `<span class="cal-lesson-mark">${l.done ? '✅' : '⬜'}</span>`;
        html += `<span class="cal-lesson-topic">${escHtml(l.topic.substring(0, 12))}${l.topic.length > 12 ? '...' : ''}</span>`;
        html += `</div>`;
      }

      html += `</div>`;
      cellCount++;
    }

    html += '</div>';
    container.innerHTML = html;
    container.querySelectorAll('.cal-lesson-clickable').forEach(el => {
      el.addEventListener('click', () => openLessonModal(el.dataset.id));
    });

    // 點日期格空白處 → 看那一天的課堂。藥丸自己已經有去處（單節的詳細視窗），
    // 事件會冒泡上來，所以在這裡擋掉，不然點藥丸會連開兩層。
    container.querySelectorAll('.cal-day[data-date]').forEach(day => {
      day.addEventListener('click', e => {
        if (e.target.closest('.cal-lesson-clickable')) return;
        openDayModal(day.dataset.date);
      });
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

  // 一次勾完某一天。請假、或隔了幾天才想到要補登時，一節一節點很痛苦。
  function markDayDone(dateStr) {
    const targets = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
      for (const l of lessons) {
        if (l.date !== dateStr || l.done) continue;
        targets.push(l.id);
      }
    }
    if (targets.length === 0) return;

    for (const id of targets) {
      const l = findLesson(id);
      if (l) { l.done = true; markLessonDirty(id); }
    }
    renderAll();
    repaintOpenDayModal();

    // 復原記的是 id 不是物件。存檔、換 plan 都會把課堂物件換掉，舊的物件已經
    // 不在 state 裡 —— 改它也改不到真的資料，得重新找回來。
    toast(`✅ 已勾選 ${targets.length} 節`, 'success', {
      label: '復原',
      onClick: () => {
        let n = 0;
        for (const id of targets) {
          const l = findLesson(id);
          if (l && l.done) { l.done = false; markLessonDirty(id); n++; }
        }
        renderAll();
        repaintOpenDayModal();
        toast(n ? `已復原 ${n} 節` : '沒有可復原的課堂', 'info');
      }
    });
  }

  function toggleDone(id) {
    const l = findLesson(id);
    if (!l) return;
    l.done = !l.done;
    markLessonDirty(id);
    renderAll();
    toast(l.done ? `✅ ${classPeriod(l)}已完成` : `已取消完成`, l.done ? 'success' : 'info');
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

  // 同一班同一學期的下一節。課堂陣列本身就是照日期排的（見 generateLessonSlots），
  // 所以下一節就是陣列裡的下一筆 —— 但要擋住跨學期那一步：上學期最後一節的
  // 「下一筆」是下學期第一節，把它們併在一起沒有意義。
  function nextLessonOf(l) {
    const list = state.lessons?.[l.class] || [];
    const i = list.findIndex(x => x.id === l.id);
    if (i < 0) return null;
    const next = list[i + 1];
    return next && next.semester === l.semester ? next : null;
  }

  // 「➜ 加到下一節」：這一節上唔切，把它的內容補進下一節一齊上。
  // 原位照樣顯示自己的內容，老師才看得到自己欠了哪一節；之後的節全部不動。
  // 做法就是在下一節寫一個 topic_override（跟直接在卡片上打字是同一條路），
  // 所以逐節同步、逐節合併都照舊，不需要新的存檔欄位。
  function carryToNext(id) {
    const l = findLesson(id);
    if (!l) return;
    const next = nextLessonOf(l);
    if (!next) return;

    if (!l.topic) { toast('這一節未有內容，冇得加', 'info'); return; }
    // 按第二次不該再加一次
    if (next.topic === l.topic || next.topic.startsWith(l.topic + '；')) {
      toast('這一節已經加過了', 'info');
      return;
    }

    const before = next.topic;
    next.topic = before ? `${l.topic}；${before}` : l.topic;
    markLessonDirty(next.id);
    renderAll();
    repaintOpenDayModal();

    // 復原記的是 id 不是字串：若中途換了 plan，整班的課堂物件會重新產生，
    // 舊物件已經不在 state 裡（同 markDayDone 的復原）。
    toast(`➜ 已加到 ${fmtDisplay(next.date)}`, 'success', {
      label: '復原',
      onClick: () => {
        const t = findLesson(next.id);
        if (!t) return;
        t.topic = before;
        markLessonDirty(next.id);
        renderAll();
        repaintOpenDayModal();
        toast('已復原', 'info');
      }
    });
  }

  // 點月曆的日期格 → 當天的完整清單。格子只有六十幾 px 寬，塞不下的都會被
  // 裁掉；這裡是唯一能看全一天的地方。跟今日課堂不同，它跟著月曆上方的
  // 班級篩選走 —— 兩邊顯示不同班級會讓人以為有課不見了。
  // 資料一變（在裡面按了「全部完成」、或按了提示上的「復原」）就重畫這個視窗。
  // 不重畫的話清單上的狀態會停在按下之前 —— 明明勾完了還寫著「未上」。
  // dayModalDate 由 openDayModal 設定、openLessonModal 清掉，所以單節的詳細
  // 視窗開著時不會被這裡蓋掉。
  function repaintOpenDayModal() {
    const overlay = $('modal-overlay');
    if (!state.dayModalDate || !overlay || !overlay.classList.contains('open')) return;
    openDayModal(state.dayModalDate);
  }

  function openDayModal(dateStr) {
    const overlay = $('modal-overlay');
    if (!overlay) return;
    state.dayModalDate = dateStr;
    const d = parseDate(dateStr);
    const DOW = ['日', '一', '二', '三', '四', '五', '六'];

    const dayLessons = [];
    for (const [cls, lessons] of Object.entries(state.lessons)) {
      if (state.selectedClasses.size > 0 && !state.selectedClasses.has(cls)) continue;
      for (const l of lessons) {
        if (l.date === dateStr) dayLessons.push(l);
      }
    }
    dayLessons.sort((a, b) => a.time.localeCompare(b.time));

    $('modal-title').textContent = `${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）`;

    const holiday = getHolidayName(dateStr);
    const exam = buildExamTags().get(dateStr);
    const assess = buildAssessmentIndex().get(dateStr) || [];
    const notes = buildNoteIndex().get(dateStr) || [];

    let body = '';
    if (holiday) body += `<div class="day-modal-holiday">🎌 ${escHtml(holiday)}</div>`;
    if (exam) body += `<div class="day-modal-exam">📝 ${escHtml(exam.full)}</div>`;
    // 這裡不受月曆那個「最多 3 個」的限制 —— 視窗夠寬，而且漏看一個考試
    // 比多佔一行嚴重得多。
    if (assess.length) body += renderAssessChips(assess, 99);
    if (notes.length) body += renderNoteChips(notes, 99);

    if (dayLessons.length === 0) {
      body += `<div class="day-modal-empty">這天沒有課堂</div>`;
    } else {
      body += '<div class="day-modal-list">' + dayLessons.map(l => {
        const color = CLASS_COLORS[l.class] || '#64748b';
        const late = !l.done && parseDate(l.date) < today();
        const status = l.done ? '已上完' : (late ? '未上 · 逾期' : '未上');
        const statusCls = l.done ? 'done' : (late ? 'overdue' : 'pending');
        return `<button type="button" class="day-modal-item" data-id="${escHtml(l.id)}">
            <span class="day-modal-dot" style="background:${color}"></span>
            <span class="day-modal-main">
              <span class="day-modal-line1">${escHtml(l.class)}<span class="day-modal-period">${escHtml(periodLabel(l))} ${escHtml(l.time)}</span></span>
              <span class="day-modal-line2">${escHtml(l.topic)}</span>
            </span>
            <span class="day-modal-status ${statusCls}">${status}</span>
          </button>`;
      }).join('') + '</div>';
    }

    $('modal-body').innerHTML = body;

    const undone = dayLessons.filter(l => !l.done).length;
    $('modal-footer').innerHTML = (undone === 0 ? '' : `
        <span class="day-modal-count">${undone} 節未完成</span>
        <button class="btn btn-success" id="day-modal-done-all">✓ 全部完成</button>`)
      + '<button class="btn btn-outline" id="day-modal-close">關閉</button>';
    overlay.classList.add('open');

    $('day-modal-close')?.addEventListener('click', () => overlay.classList.remove('open'));
    $('day-modal-done-all')?.addEventListener('click', () => markDayDone(dateStr));
    // 再點一節 → 進到單節的詳細視窗（同一層 overlay，直接換內容）。
    $('modal-body').querySelectorAll('.day-modal-item').forEach(item => {
      item.addEventListener('click', () => openLessonModal(item.dataset.id));
    });
  }

  function openLessonModal(id) {
    const l = findLesson(id);
    if (!l) return;
    // 換成單節的視窗了，別再讓 repaintOpenDayModal 把當天清單蓋回來。
    state.dayModalDate = null;
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    const title = $('modal-title');
    const hwData = l.hw && typeof l.hw === 'object' ? l.hw : (l.hw ? { topic: l.hw } : {});

    title.textContent = classPeriod(l);
    body.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span class="badge ${l.done ? 'badge-ok' : 'badge-behind'}">${l.done ? '已完成' : '未完成'}</span>
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
    state.dayModalDate = null;   // 同上：換視窗了，別再被當天清單蓋回來
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    const title = $('modal-title');
    title.textContent = `${classPeriod(l)} — 作業`;
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