(() => {
  'use strict';

  const STORAGE_KEY = 'sabeel.app.v1';
  const todayKey = () => formatDate(new Date());
  const defaultPrayers = [
    { id:'fajr', name:'Фаджр', time:'05:15', required:true },
    { id:'sunrise', name:'Восход', time:'06:48', optional:true },
    { id:'dhuhr', name:'Зухр', time:'13:12', required:true },
    { id:'asr', name:'Аср', time:'16:42', required:true },
    { id:'maghrib', name:'Магриб', time:'19:37', required:true },
    { id:'isha', name:'Иша', time:'21:04', required:true }
  ];
  const learningTypes = [
    { id:'reading', label:'Чтение' }, { id:'review', label:'Повторение' },
    { id:'memorizing', label:'Заучивание' }, { id:'knowledge', label:'Знания' }
  ];
  const emotions = [
    { id:'calm', emoji:'😌', label:'Спокойствие' }, { id:'joy', emoji:'😊', label:'Радость' },
    { id:'love', emoji:'❤️', label:'Любовь' }, { id:'focus', emoji:'🎯', label:'Фокус' },
    { id:'energy', emoji:'💪', label:'Энергия' }, { id:'knowledge', emoji:'🧠', label:'Знания' },
    { id:'growth', emoji:'🌱', label:'Рост' }, { id:'spark', emoji:'✨', label:'Вдохновение' }
  ];

  const clone = value => JSON.parse(JSON.stringify(value));
  const defaultState = () => ({ version:1, settings:{ name:'', prayers:clone(defaultPrayers) }, habits:[], books:[], days:{} });
  let state = loadState();
  let activeScreen = 'home';
  let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let toastTimer;
  let bookDbPromise = null;
  let readerSession = null;
  let readerTimerHandle = null;

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      const saved = JSON.parse(raw);
      const base = defaultState();
      const savedPrayers = Array.isArray(saved?.settings?.prayers) ? saved.settings.prayers : [];
      const prayerMap = new Map(savedPrayers.filter(p => p && p.id !== 'tahajjud').map(p => [p.id, p]));
      const prayers = base.settings.prayers.map(p => ({ ...p, ...(prayerMap.get(p.id) || {}) }));
      return {
        ...base, ...saved,
        settings:{...base.settings,...saved.settings,prayers},
        habits:Array.isArray(saved.habits) ? saved.habits : [], books:Array.isArray(saved.books) ? saved.books : [], days:saved.days && typeof saved.days === 'object' ? saved.days : {}
      };
    }catch(error){ console.warn('Sabeel state could not be loaded', error); return defaultState(); }
  }
  function save(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function openBookDb(){
    if(bookDbPromise) return bookDbPromise;
    bookDbPromise = new Promise((resolve,reject)=>{
      if(!('indexedDB' in window)){ reject(new Error('IndexedDB недоступен')); return; }
      const request=indexedDB.open('sabeel.books.v1',1);
      request.onupgradeneeded=()=>{ if(!request.result.objectStoreNames.contains('books')) request.result.createObjectStore('books',{keyPath:'id'}); };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error || new Error('Не удалось открыть хранилище книг'));
    });
    return bookDbPromise;
  }
  async function putBookFile(id,file){
    const db=await openBookDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('books','readwrite'); tx.objectStore('books').put({id,blob:file});
      tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error || new Error('Не удалось сохранить книгу'));
    });
  }
  async function getBookFile(id){
    const db=await openBookDb();
    return new Promise((resolve,reject)=>{ const req=db.transaction('books','readonly').objectStore('books').get(id); req.onsuccess=()=>resolve(req.result?.blob || null); req.onerror=()=>reject(req.error); });
  }
  async function deleteBookFile(id){
    try{ const db=await openBookDb(); await new Promise((resolve,reject)=>{ const tx=db.transaction('books','readwrite'); tx.objectStore('books').delete(id); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }catch(error){ console.warn('Book file delete failed',error); }
  }
  async function clearBookFiles(){ try{ const db=await openBookDb(); await new Promise((resolve,reject)=>{ const tx=db.transaction('books','readwrite'); tx.objectStore('books').clear(); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }catch(error){ console.warn('Book storage reset failed',error); } }
  function bookKind(file){
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    if(ext==='pdf' || file.type==='application/pdf') return 'pdf';
    if(['txt','md','markdown'].includes(ext) || /^text\//.test(file.type)) return 'text';
    if(['html','htm'].includes(ext) || file.type==='text/html') return 'html';
    return '';
  }
  function bookIcon(kind){ return kind==='pdf'?'▱':kind==='html'?'◇':'≡'; }
  function bookFormatLabel(kind){ return kind==='pdf'?'PDF':kind==='html'?'HTML':'TXT / MD'; }
  function formatReaderTime(seconds){ const total=Math.max(0,Math.floor(seconds)); const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), sec=total%60; return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function totalReadingToday(){ return Number(getDay().learning.reading||0); }
  function checkpointReading(){
    if(!readerSession) return;
    const now=Date.now(); const delta=Math.max(0,Math.floor((now-readerSession.checkpointAt)/1000));
    readerSession.checkpointAt=now; readerSession.elapsedSec+=delta;
    readerSession.pendingSec+=delta;
    const minutes=Math.floor(readerSession.pendingSec/60);
    if(minutes>0){ getDay().learning.reading += minutes; readerSession.pendingSec -= minutes*60; save(); renderLearning(); renderSummary(); renderStats(); updateReaderTimer(); }
  }
  function startReadingSession(book){
    stopReadingSession();
    readerSession={bookId:book.id,startedAt:Date.now(),checkpointAt:Date.now(),elapsedSec:0,pendingSec:0};
    updateReaderTimer();
    clearInterval(readerTimerHandle); readerTimerHandle=setInterval(()=>{ checkpointReading(); updateReaderTimer(); },15000);
  }
  function stopReadingSession(){
    if(!readerSession) return;
    checkpointReading(); clearInterval(readerTimerHandle); readerTimerHandle=null; readerSession=null;
  }
  function updateReaderTimer(){
    if(!readerSession) return;
    const timer=document.getElementById('readerTimer'); if(timer) timer.textContent=formatReaderTime(readerSession.elapsedSec);
    const today=document.getElementById('readerTodayMinutes'); if(today) today.textContent=`${totalReadingToday()} мин сегодня`;
  }
  function renderBooks(){
    const el=document.getElementById('bookLibrary'); if(!el) return;
    const books=state.books||[];
    if(!books.length){ el.innerHTML=`<div class="books-empty card"><div class="books-empty-icon">▤</div><h3>Здесь будут ваши книги</h3><p>Добавьте PDF или текстовую книгу. Она останется на этом устройстве, а время чтения автоматически попадёт в ваши цели.</p><button class="secondary-button" data-upload-book>Выбрать файл</button></div>`; }
    else el.innerHTML=books.map(book=>`<article class="book-card card"><div class="book-cover"><span>${bookIcon(book.kind)}</span><small>${bookFormatLabel(book.kind)}</small></div><div class="book-card-copy"><strong>${esc(book.title)}</strong><span>${book.kind==='pdf'?'Документ для чтения':'Текстовая книга'} · ${formatBytes(book.size)}</span><small>Добавлена ${esc(book.addedAtLabel||'сегодня')}</small></div><button class="book-open" data-open-book="${esc(book.id)}">Читать <span>›</span></button><button class="book-delete" data-delete-book="${esc(book.id)}" aria-label="Удалить книгу">×</button></article>`).join('');
    document.querySelectorAll('[data-upload-book]').forEach(btn=>btn.addEventListener('click',()=>document.getElementById('bookFileInput').click()));
    document.querySelectorAll('[data-open-book]').forEach(btn=>btn.addEventListener('click',()=>openBook(btn.dataset.openBook)));
    document.querySelectorAll('[data-delete-book]').forEach(btn=>btn.addEventListener('click',()=>removeBook(btn.dataset.deleteBook)));
    const total=document.getElementById('readingTodayTotal'); if(total) total.textContent=`${totalReadingToday()} мин`;
  }
  function formatBytes(bytes){ if(!bytes) return 'размер неизвестен'; const units=['Б','КБ','МБ','ГБ']; let n=bytes,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++;} return `${n>=10||i===0?Math.round(n):n.toFixed(1)} ${units[i]}`; }
  async function handleBookFiles(files){
    for(const file of files){
      const kind=bookKind(file);
      if(!kind){ showToast('Поддерживаются PDF, TXT, MD и HTML'); continue; }
      const id=`book_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const book={id,title:file.name.replace(/\.[^.]+$/,''),fileName:file.name,size:file.size,kind,addedAt:Date.now(),addedAtLabel:formatLongDate(new Date())};
      try{ await putBookFile(id,file); state.books.unshift(book); save(); renderBooks(); showToast(`«${book.title}» добавлена`); }
      catch(error){ console.error(error); showToast('Не удалось сохранить книгу. Возможно, хранилище переполнено.'); }
    }
  }
  async function removeBook(id){
    const book=state.books.find(b=>b.id===id); if(!book || !confirm(`Удалить «${book.title}» с устройства?`)) return;
    if(readerSession?.bookId===id) closeReader();
    state.books=state.books.filter(b=>b.id!==id); save(); await deleteBookFile(id); renderBooks(); showToast('Книга удалена');
  }
  async function openBook(id){
    const book=state.books.find(b=>b.id===id); if(!book) return;
    try{
      const blob=await getBookFile(id); if(!blob) throw new Error('Файл не найден');
      document.getElementById('booksLibraryView').hidden=true; document.getElementById('readerView').hidden=false;
      document.getElementById('readerTitle').textContent=book.title; document.getElementById('readerStage').innerHTML='';
      if(book.kind==='pdf'){
        const url=URL.createObjectURL(blob);
        document.getElementById('readerStage').innerHTML=`<iframe class="pdf-reader" src="${url}#toolbar=1&navpanes=0&view=FitH" title="${esc(book.title)}"></iframe>`;
      } else if(book.kind==='text'){
        const text=await blob.text(); document.getElementById('readerStage').innerHTML=`<article class="text-reader">${esc(text).replace(/\n/g,'<br>')}</article>`;
      } else {
        const html=await blob.text(); const safe=html.replace(/<script[\s\S]*?<\/script>/gi,''); document.getElementById('readerStage').innerHTML=`<iframe class="html-reader" sandbox="allow-same-origin" title="${esc(book.title)}"></iframe>`; const frame=document.querySelector('.html-reader'); frame.srcdoc=safe;
      }
      startReadingSession(book); updateReaderTimer();
    }catch(error){ console.error(error); showToast('Не удалось открыть книгу'); }
  }
  function closeReader(){
    stopReadingSession();
    const stage=document.getElementById('readerStage'); const frame=stage?.querySelector('iframe'); if(frame?.src?.startsWith('blob:')) URL.revokeObjectURL(frame.src);
    if(stage) stage.innerHTML='';
    document.getElementById('readerView').hidden=true; document.getElementById('booksLibraryView').hidden=false; renderBooks(); renderAll(false);
  }
  function openManualReading(){ document.getElementById('readingModalBackdrop').hidden=false; setTimeout(()=>document.getElementById('manualReadingMinutes').focus(),30); }
  function closeManualReading(){ document.getElementById('readingModalBackdrop').hidden=true; document.getElementById('readingForm').reset(); }
  function addManualReading(minutes){ const value=Math.max(1,Math.min(1440,Math.round(Number(minutes)||0))); if(!value) return; getDay().learning.reading += value; save(); closeManualReading(); renderAll(false); showToast(`Добавлено ${value} мин чтения`); }
  function formatDate(date){ return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-'); }
  function parseDate(key){ const [y,m,d]=key.split('-').map(Number); return new Date(y,m-1,d); }
  function getDay(key=todayKey()){
    if(!state.days[key]) state.days[key]={ prayers:{}, habits:{}, learning:{reading:0,review:0,memorizing:0,knowledge:0} };
    const day=state.days[key]; day.prayers ||= {}; day.habits ||= {}; day.learning ||= {reading:0,review:0,memorizing:0,knowledge:0};
    learningTypes.forEach(x=>{ if(typeof day.learning[x.id] !== 'number') day.learning[x.id]=0; });
    return day;
  }
  function formatLongDate(date){ return new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long'}).format(date).replace(/^./, c=>c.toUpperCase()); }
  function hijriDate(date){ try { return new Intl.DateTimeFormat('ru-RU-u-ca-islamic',{day:'numeric',month:'long',year:'numeric'}).format(date); } catch { return ''; } }
  function esc(value){ return String(value).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function currentMinutes(){ const d=new Date(); return d.getHours()*60+d.getMinutes(); }
  function timeMinutes(time){ const [h,m]=time.split(':').map(Number); return h*60+m; }
  function initials(name){ return name ? name.trim().slice(0,1).toUpperCase() : '✦'; }
  function currentRequiredCount(day){ return state.settings.prayers.filter(p=>p.required && day.prayers[p.id]).length; }
  function dayCompletion(key=todayKey()){
    const day=getDay(key), required=5, prayers=currentRequiredCount(day)/required;
    const habitsTotal=state.habits.length, habitsDone=state.habits.filter(h=>day.habits[h.id]).length;
    const habitScore=habitsTotal ? habitsDone/habitsTotal : 0;
    const learningTotal=learningTypes.reduce((sum,x)=>sum+Number(day.learning[x.id]||0),0);
    const learningScore=Math.min(learningTotal/60,1);
    return Math.round((prayers*0.55 + habitScore*0.3 + learningScore*0.15)*100);
  }
  function renderHeader(){
    const now=new Date(); document.getElementById('gregorianDate').textContent=formatLongDate(now);
    document.getElementById('hijriDate').textContent=hijriDate(now);
    const name=state.settings.name.trim(); document.getElementById('greeting').textContent=name ? `Ассаляму алейкум, ${name}` : 'Ассаляму алейкум';
  }
  function renderPrayers(){
    const day=getDay(), now=currentMinutes(), prayers=state.settings.prayers;
    const nextIndex=prayers.findIndex(p=>timeMinutes(p.time)>=now && !day.prayers[p.id]);
    document.getElementById('prayerScroller').innerHTML=prayers.map((p,i)=>{
      const done=!!day.prayers[p.id], current=i===nextIndex;
      return `<button class="prayer-card ${done?'completed':''} ${current?'current':''} ${p.optional?'nonessential':''}" data-prayer="${p.id}" aria-label="${esc(p.name)} ${done?'выполнен':'не выполнен'}">
        <span class="prayer-name">${esc(p.name)}</span><span class="prayer-time">${esc(p.time)}</span>
        <span class="check-ring">${checkSvg()}</span></button>`;
    }).join('');
    const count=currentRequiredCount(day); document.getElementById('prayerProgress').textContent=`${count} / 5`;
    document.getElementById('prayerProgressBar').style.width=`${count*20}%`;
    document.getElementById('prayerScroller').querySelectorAll('[data-prayer]').forEach(btn=>btn.addEventListener('click',()=>togglePrayer(btn.dataset.prayer)));
  }
  function checkSvg(){ return '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  function renderHabits(){
    const day=getDay();
    const html=state.habits.length ? state.habits.map(h=>habitHtml(h,day)).join('') : `<div class="empty-state">Пока нет привычек. Добавьте одну маленькую цель на сегодня.</div>`;
    document.getElementById('habitList').innerHTML=html; document.getElementById('habitListFull').innerHTML=html;
    document.querySelectorAll('[data-habit-toggle]').forEach(el=>el.addEventListener('click',()=>toggleHabit(el.dataset.habitToggle)));
    document.querySelectorAll('[data-habit-delete]').forEach(el=>el.addEventListener('click',()=>deleteHabit(el.dataset.habitDelete)));
  }
  function habitHtml(h,day){ const done=!!day.habits[h.id]; const emotion=emotions.find(e=>e.id===h.emotion) || emotions[0]; return `<article class="habit-item ${done?'done':''}">
    <button class="habit-check" data-habit-toggle="${h.id}" aria-label="${done?'Снять отметку':'Отметить'} ${esc(h.name)}">${checkSvg()}</button>
    <span class="habit-emoji" title="${esc(emotion.label)}" aria-hidden="true">${emotion.emoji}</span>
    <div class="habit-copy"><strong>${esc(h.name)}</strong><small>${h.time ? `Запланировано на ${esc(h.time)}` : 'Без времени · в удобный момент'}</small></div>
    <button class="delete-habit" data-habit-delete="${h.id}" aria-label="Удалить ${esc(h.name)}">×</button></article>`; }
  function renderLearning(){
    const day=getDay(); const total=learningTypes.reduce((s,x)=>s+Number(day.learning[x.id]||0),0); document.getElementById('learningTotal').textContent=total;
    document.getElementById('learningGrid').innerHTML=learningTypes.map(x=>`<label class="learning-cell"><span>${x.label}</span><input type="number" min="0" max="999" inputmode="numeric" value="${Number(day.learning[x.id]||0)}" data-learning="${x.id}" aria-label="${x.label}, минут"></label>`).join('');
    document.querySelectorAll('[data-learning]').forEach(input=>input.addEventListener('change',()=>{ const value=Math.max(0,Math.min(999,Number(input.value)||0)); getDay().learning[input.dataset.learning]=value; save(); renderAll(false); showToast('Учебное время сохранено'); }));
  }
  function renderNextGoal(){
    const day=getDay(), now=currentMinutes(); const goals=[];
    state.settings.prayers.forEach(p=>{ if(!day.prayers[p.id]) goals.push({name:p.name,time:p.time,minutes:timeMinutes(p.time),type:'prayer'}); });
    state.habits.forEach(h=>{ if(!day.habits[h.id] && h.time) goals.push({name:h.name,time:h.time,minutes:timeMinutes(h.time),type:'habit'}); });
    goals.sort((a,b)=>a.minutes-b.minutes);
    let upcoming=goals.find(g=>g.minutes>=now);
    if(!upcoming) upcoming=goals[0];
    const title=document.getElementById('nextGoalTitle'), meta=document.getElementById('nextGoalMeta'), initial=document.getElementById('goalInitial');
    if(!upcoming){ title.textContent='День завершён'; meta.textContent='Все цели с указанным временем выполнены'; initial.textContent='✓'; return; }
    title.textContent=upcoming.name; meta.textContent=upcoming.type==='prayer' ? upcoming.time : `${upcoming.time} · привычка`; initial.textContent=initials(upcoming.name);
  }
  function renderSummary(){
    const score=dayCompletion(), day=getDay(), total=state.habits.length, done=state.habits.filter(h=>day.habits[h.id]).length;
    document.getElementById('dayScore').textContent=`${score}%`;
    document.getElementById('dayProgressBar').style.width=`${score}%`;
    document.getElementById('habitProgressLabel').textContent=total ? `${done} из ${total} ${plural(total,['привычка','привычки','привычек'])}` : 'Добавьте первую привычку';
    document.getElementById('completionLabel').textContent=score>=80?'Очень хороший день':score>=45?'Хороший ритм':score>0?'В пути':'Начало пути';
    const streak=calculateStreak(); document.getElementById('streakLabel').textContent=`${streak} ${plural(streak,['день','дня','дней'])}`;
  }
  function calculateStreak(){ let count=0, date=new Date(); while(true){ const key=formatDate(date); if(dayCompletion(key)<60) break; count++; date.setDate(date.getDate()-1); if(count>366) break; } return count; }
  function plural(n,forms){ const x=n%100; return forms[(x>=11&&x<=14)?2:(n%10===1?0:n%10>=2&&n%10<=4?1:2)]; }
  function togglePrayer(id){ const day=getDay(); day.prayers[id]=!day.prayers[id]; save(); renderAll(); showToast(day.prayers[id]?'Намаз отмечен':'Отметка снята'); }
  function toggleHabit(id){ const day=getDay(); day.habits[id]=!day.habits[id]; save(); renderAll(); showToast(day.habits[id]?'Привычка выполнена':'Отметка снята'); }
  function deleteHabit(id){ const h=state.habits.find(x=>x.id===id); if(!h || !confirm(`Удалить привычку «${h.name}»?`)) return; state.habits=state.habits.filter(x=>x.id!==id); Object.values(state.days).forEach(d=>{ if(d.habits) delete d.habits[id]; }); save(); renderAll(); showToast('Привычка удалена'); }
  function addHabit(name,time,emotion='calm'){ state.habits.push({id:`habit_${Date.now()}_${Math.random().toString(16).slice(2)}`,name:name.trim(),time:time||'',emotion:emotion||'calm'}); save(); renderAll(); showToast('Привычка добавлена'); }
  function renderEmotionPicker(selected='calm'){
    document.getElementById('emotionPicker').innerHTML=emotions.map(e=>`<button type="button" class="emotion-option ${e.id===selected?'selected':''}" data-emotion="${e.id}" aria-label="${esc(e.label)}" aria-pressed="${e.id===selected}">${e.emoji}</button>`).join('');
    document.querySelectorAll('[data-emotion]').forEach(btn=>btn.addEventListener('click',()=>{ document.querySelectorAll('[data-emotion]').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false')}); btn.classList.add('selected');btn.setAttribute('aria-pressed','true'); }));
  }
  function openModal(){ document.getElementById('modalBackdrop').hidden=false; renderEmotionPicker('calm'); setTimeout(()=>document.getElementById('habitName').focus(),30); }
  function closeModal(){ document.getElementById('modalBackdrop').hidden=true; document.getElementById('habitForm').reset(); renderEmotionPicker('calm'); }
  function renderStats(){
    const dates=[]; for(let i=6;i>=0;i--){ const d=new Date(); d.setDate(d.getDate()-i); dates.push(d); }
    const weekScores=dates.map(d=>dayCompletion(formatDate(d))); const avg=Math.round(weekScores.reduce((a,b)=>a+b,0)/7);
    const habitDone=dates.reduce((sum,d)=>{ const day=getDay(formatDate(d)); return sum+state.habits.filter(h=>day.habits[h.id]).length; },0);
    const learning=dates.reduce((sum,d)=>{ const day=getDay(formatDate(d)); return sum+learningTypes.reduce((s,x)=>s+Number(day.learning[x.id]||0),0); },0);
    const prayerCount=dates.reduce((sum,d)=>sum+currentRequiredCount(getDay(formatDate(d))),0);
    document.getElementById('statsGrid').innerHTML=[['Среднее за 7 дней',`${avg}%`],['Намазы',`${prayerCount} / 35`],['Привычки',`${habitDone}`],['Учёба',`${learning} мин`]].map(([label,value])=>`<article class="stat-card card"><span class="section-kicker">${label}</span><div class="stat-value">${value}</div><span class="stat-label">по сохранённым дневным записям</span></article>`).join('');
    document.getElementById('weekBars').innerHTML=dates.map((d,i)=>`<div class="bar-wrap"><span class="bar-value">${weekScores[i]}</span><div class="bar" style="height:${Math.max(4,weekScores[i])}%"></div><span class="bar-label">${new Intl.DateTimeFormat('ru-RU',{weekday:'short'}).format(d).slice(0,2)}</span></div>`).join('');
  }
  function renderCalendar(){
    const y=calendarCursor.getFullYear(), m=calendarCursor.getMonth(); document.getElementById('calendarTitle').textContent=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(calendarCursor).replace(/^./,c=>c.toUpperCase());
    document.getElementById('weekdays').innerHTML=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<span>${x}</span>`).join('');
    const first=new Date(y,m,1), last=new Date(y,m+1,0), offset=(first.getDay()+6)%7; let cells='';
    for(let i=0;i<offset;i++) cells+='<button class="calendar-day muted" disabled></button>';
    for(let day=1;day<=last.getDate();day++){ const date=new Date(y,m,day), key=formatDate(date), score=dayCompletion(key), isToday=key===todayKey(); cells+=`<button class="calendar-day ${isToday?'today ':''}${score>=60?'good':score>0?'partial':''}" data-calendar-date="${key}">${day}${score>0?'<span class="dot"></span>':''}</button>`; }
    document.getElementById('calendarGrid').innerHTML=cells;
    document.querySelectorAll('[data-calendar-date]').forEach(btn=>btn.addEventListener('click',()=>{ if(btn.dataset.calendarDate===todayKey()) showToast('Сегодня открыт на главной'); else showToast(`${btn.dataset.calendarDate}: ${dayCompletion(btn.dataset.calendarDate)}% выполнения`); }));
  }
  function renderSettings(){
    const input=document.getElementById('nameSetting'); if(document.activeElement!==input) input.value=state.settings.name;
    document.getElementById('prayerSettings').innerHTML=state.settings.prayers.map(p=>`<label class="prayer-setting"><span>${p.name}</span><input type="time" value="${p.time}" data-prayer-time="${p.id}"></label>`).join('');
    document.querySelectorAll('[data-prayer-time]').forEach(input=>input.addEventListener('change',()=>{ const p=state.settings.prayers.find(x=>x.id===input.dataset.prayerTime); if(p){p.time=input.value;save();renderAll();showToast('Время обновлено');} }));
  }
  function renderAll(renderNav=true){ renderHeader(); renderPrayers(); renderHabits(); renderLearning(); renderNextGoal(); renderSummary(); renderCalendar(); renderStats(); renderSettings(); renderBooks(); if(renderNav) setScreen(activeScreen,false); }
  function setScreen(screen,scroll=true){ activeScreen=screen; document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.dataset.screen===screen || s.id===`${screen}Screen`)); document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.nav===screen)); if(scroll) window.scrollTo({top:0,behavior:'smooth'}); }
  function showToast(message){ const el=document.getElementById('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),1700); }
  function bind(){
    document.querySelectorAll('[data-nav]').forEach(btn=>btn.addEventListener('click',()=>setScreen(btn.dataset.nav)));
    document.querySelectorAll('[data-open-add-habit]').forEach(btn=>btn.addEventListener('click',openModal));
    document.getElementById('settingsButton').addEventListener('click',()=>setScreen('settings'));
    document.getElementById('modalClose').addEventListener('click',closeModal); document.getElementById('modalCancel').addEventListener('click',closeModal);
    document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});
    document.getElementById('habitForm').addEventListener('submit',e=>{e.preventDefault();const name=document.getElementById('habitName').value.trim();const selected=document.querySelector('[data-emotion].selected')?.dataset.emotion || 'calm';if(name){addHabit(name,document.getElementById('habitTime').value,selected);closeModal();}});
    document.querySelector('[data-open-add-learning]')?.addEventListener('click',()=>{ const input=document.querySelector('[data-learning]'); if(input){input.focus();input.select();showToast('Укажите минуты полезного времени');} });
    document.getElementById('uploadBookButton').addEventListener('click',()=>document.getElementById('bookFileInput').click());
    document.getElementById('bookFileInput').addEventListener('change',e=>{ if(e.target.files?.length) handleBookFiles([...e.target.files]); e.target.value=''; });
    document.getElementById('manualReadingButton').addEventListener('click',openManualReading);
    document.getElementById('readingModalClose').addEventListener('click',closeManualReading); document.getElementById('readingModalCancel').addEventListener('click',closeManualReading);
    document.getElementById('readingModalBackdrop').addEventListener('click',e=>{if(e.target.id==='readingModalBackdrop')closeManualReading();});
    document.getElementById('readingForm').addEventListener('submit',e=>{e.preventDefault();addManualReading(document.getElementById('manualReadingMinutes').value);});
    document.getElementById('readerBack').addEventListener('click',closeReader); document.getElementById('readerClose').addEventListener('click',closeReader);
    window.addEventListener('pagehide',()=>{ checkpointReading(); });
    document.addEventListener('visibilitychange',()=>{ if(document.hidden) checkpointReading(); else if(readerSession){ readerSession.checkpointAt=Date.now(); } });
    document.getElementById('nameSetting').addEventListener('change',e=>{state.settings.name=e.target.value.trim();save();renderHeader();showToast('Имя сохранено');});
    document.getElementById('prevMonth').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar();}); document.getElementById('nextMonth').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar();});
    document.getElementById('resetData').addEventListener('click',()=>{if(confirm('Удалить все локальные данные Sabeel?')){state=defaultState();save();clearBookFiles();renderAll();showToast('Данные сброшены');}});
    document.addEventListener('keydown',e=>{if(e.key!=='Escape')return; if(!document.getElementById('modalBackdrop').hidden)closeModal(); if(!document.getElementById('readingModalBackdrop').hidden)closeManualReading();});
  }
  bind(); renderAll();
})();
