'use strict';
const $=id=>document.getElementById(id);
const defaults={sets:3,reps:12,prep:5,rest:12,cooldown:3,cooldownOn:false,repInterval:3,voice:true};
let config={...defaults};
try{config={...defaults,...JSON.parse(localStorage.getItem('sgc_settings')||'{}')}}catch{}
// Earlier versions used "cooldown" for the manual +1 button. Automatic counting
// now has its own independent rep pace; do not silently add old cooldown delays.
if(!localStorage.getItem('sgc_auto_migrated')){config.cooldownOn=false;localStorage.setItem('sgc_auto_migrated','1')}
const number=(v,min,max)=>Math.min(max,Math.max(min,Math.floor(Number(v)||0)));
for(const k of Object.keys(defaults)){
 const el=$(k); if(!el)continue;
 if(el.type==='checkbox')el.checked=!!config[k];else el.value=config[k];
 el.addEventListener('change',()=>{
  config[k]=el.type==='checkbox'?el.checked:number(el.value,k==='sets'||k==='reps'||k==='repInterval'?1:0,k==='sets'||k==='reps'?9999:3600);
  if(el.type!=='checkbox')el.value=config[k];
  localStorage.setItem('sgc_settings',JSON.stringify(config));render();
 });
}
let active=null,phase='ready',set=1,rep=0,completed=0,total=0;
let started=null,ended=null,paused=false,pauseStarted=0,pausedDuration=0;
let deadline=0,remainingMs=0,timer=null,epoch=0,stepEnd=null,stepName=null,lastShown=-1;
let speechQueue=Promise.resolve();
function stopTimer(){if(timer!==null)clearInterval(timer);timer=null}
function cancelVoice(){if('speechSynthesis'in window)window.speechSynthesis.cancel();speechQueue=Promise.resolve()}
function speak(words,{urgent=false}={}){
 if(!active?.voice||!('speechSynthesis'in window))return Promise.resolve();
 if(urgent)cancelVoice();
 const current=epoch;
 const task=()=>new Promise(resolve=>{
  if(current!==epoch||paused||!active?.voice)return resolve();
  let settled=false;const finish=()=>{if(!settled){settled=true;clearTimeout(watchdog);resolve()}};
  const u=new SpeechSynthesisUtterance(String(words));u.lang='en-US';u.rate=1.07;u.volume=1;u.onend=finish;u.onerror=finish;
  const watchdog=setTimeout(finish,Math.max(1800,String(words).length*150));
  try{speechSynthesis.speak(u)}catch{finish()}
 });
 speechQueue=speechQueue.then(task,task);return speechQueue;
}
function updateClock(){
 $('clock').textContent=started?(duration((ended||Date.now())-started-pausedDuration-(paused?Date.now()-pauseStarted:0))):'00:00';
}
function duration(ms){const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)}m ${s%60}s`}
// A single timer engine is used for preparation, rep intervals, cooldown, and rest.
function countDown(ms,kind,finish){
 stopTimer();phase=kind;remainingMs=Math.max(0,ms);stepName=kind;stepEnd=finish;lastShown=-1;
 const session=epoch;
 if(remainingMs===0){render();queueMicrotask(()=>{if(epoch===session&&!paused)finish()});return}
 deadline=performance.now()+remainingMs;
 const tick=()=>{
  if(epoch!==session||paused)return;
  remainingMs=Math.max(0,deadline-performance.now());
  const sec=Math.ceil(remainingMs/1000);
  if(sec>0&&sec!==lastShown){lastShown=sec;
   if(['prep','rest','cooldown'].includes(kind))speak(sec.toString());
  }
  render();
  if(remainingMs<=0){stopTimer();if(epoch===session&&!paused)finish()}
 };
 tick();timer=setInterval(tick,60);
}
function startPreparation(){
 rep=0;countDown(active.prep*1000,'prep',()=>{
  phase='announcing';render();const session=epoch;
  speak('START!').then(()=>{if(session!==epoch||paused||phase!=='announcing')return;nextAutomaticRep()});
 });
}
function nextAutomaticRep(){countDown(active.repInterval*1000,'repWait',countRep)}
function countRep(){
 if(paused||!active||phase!=='repWait')return;
 rep+=1;total+=1;
 if(rep>=active.reps){completeSet();return}
 phase='repSpoken';render();const session=epoch;
 speak(String(rep)).then(()=>{
  if(session!==epoch||paused||phase!=='repSpoken')return;
  if(active.cooldownOn&&active.cooldown>0){countDown(active.cooldown*1000,'cooldown',nextAutomaticRep)}
  else nextAutomaticRep();
 });
}
function completeSet(){
 stopTimer();phase='setComplete';completed++;render();
 const session=epoch;
 // STOP takes priority over the final rep number. Say STOP first, then confirm.
 speak('STOP!',{urgent:true}).then(()=>{
  if(session!==epoch||paused||phase!=='setComplete')return;
  return speak('SET COMPLETED!').then(()=>{
   if(session!==epoch||paused||phase!=='setComplete')return;
   if(completed>=active.sets){finishWorkout();return}
   countDown(active.rest*1000,'rest',announceNextSet);
  });
 });
}
function announceNextSet(){
 phase='transition';render();const session=epoch;
 speak('NEXT SET!').then(()=>{
  if(session!==epoch||paused||phase!=='transition')return;
  set++;startPreparation();
 });
}
function finishWorkout(){
 stopTimer();phase='finished';ended=Date.now();render();
 speak('WORKOUT COMPLETED!',{urgent:true});
 const record={id:ended,date:new Date(started).toISOString(),ended:new Date(ended).toISOString(),duration:ended-started-pausedDuration,sets:completed,reps:total,config:{...active}};
 const history=getHistory();history.unshift(record);
 try{localStorage.setItem('sgc_history',JSON.stringify(history))}catch{}
 renderHistory();
}
function startWorkout(){
 if(!['ready','finished'].includes(phase))return;
 ++epoch;stopTimer();cancelVoice();active={...config};
 phase='ready';set=1;rep=0;total=0;completed=0;paused=false;pausedDuration=0;
 started=Date.now();ended=null;
 startPreparation();
}
// Pause suspends countdowns AND speech transitions; resume restores the exact stage.
function pauseWorkout(){
 if(['ready','finished'].includes(phase))return;
 if(!paused){
  paused=true;pauseStarted=Date.now();
  if(timer!==null)remainingMs=Math.max(0,deadline-performance.now());
  stopTimer();++epoch;cancelVoice();render();return;
 }
 paused=false;pausedDuration+=Date.now()-pauseStarted;++epoch;
 if(['prep','rest','cooldown','repWait'].includes(phase)){
  const stage=phase;
  const next={prep:()=>{phase='announcing';render();const e=epoch;speak('START!').then(()=>{if(e===epoch&&!paused&&phase==='announcing')nextAutomaticRep()})},
   rest:announceNextSet,cooldown:nextAutomaticRep,repWait:countRep}[stage];
  countDown(remainingMs,stage,next);
 }else if(phase==='announcing'){
  const e=epoch;speak('START!').then(()=>{if(e===epoch&&!paused&&phase==='announcing')nextAutomaticRep()});
 }else if(phase==='repSpoken'){
  const e=epoch;speak(String(rep)).then(()=>{if(e!==epoch||paused||phase!=='repSpoken')return;if(active.cooldownOn&&active.cooldown>0)countDown(active.cooldown*1000,'cooldown',nextAutomaticRep);else nextAutomaticRep()});
 }else if(phase==='transition')announceNextSet();
 else if(phase==='setComplete'){
  const e=epoch;speak('STOP!',{urgent:true}).then(()=>speak('SET COMPLETED!')).then(()=>{
   if(e!==epoch||paused||phase!=='setComplete')return;
   if(completed>=active.sets)finishWorkout();else countDown(active.rest*1000,'rest',announceNextSet);
  });
 }
 render();
}
function resetWorkout(){
 ++epoch;stopTimer();cancelVoice();active=null;phase='ready';set=1;rep=0;completed=0;total=0;
 started=null;ended=null;paused=false;pausedDuration=0;remainingMs=0;render();
}
function render(){
 const c=active||config,maximum=c.sets*c.reps;
 $('repValue').textContent=rep;$('targetLabel').textContent=` / ${c.reps}`;
 $('setLabel').textContent=`SET ${Math.min(set,c.sets)} / ${c.sets}`;
 $('phaseLabel').textContent=paused?'PAUSED':phase.toUpperCase();
 $('completed').textContent=completed;$('remaining').textContent=Math.max(0,c.sets-completed);$('totalReps').textContent=total;
 $('bar').style.width=`${Math.min(100,maximum?total/maximum*100:0)}%`;
 $('start').disabled=!['ready','finished'].includes(phase);
 $('start').textContent=phase==='finished'?'NEW WORKOUT':'START';
 $('pause').disabled=['ready','finished'].includes(phase);$('pause').textContent=paused?'RESUME':'PAUSE';
 const status={ready:'Ready to train',prep:'GET READY!',announcing:'START!',repWait:'AUTO COUNTING',repSpoken:'AUTO COUNTING',cooldown:'Extra rep rest',setComplete:'SET COMPLETED!',rest:'Rest & recover',transition:'NEXT SET!',finished:'WORKOUT COMPLETED!'};
 $('status').textContent=paused?'Workout paused':status[phase];
 $('countdown').textContent=paused?'Ⅱ':['prep','rest','cooldown','repWait'].includes(phase)?`${Math.ceil(remainingMs/1000)}s`:'';
 $('autoIndicator').textContent=phase==='repWait'?'NEXT REP AUTOMATICALLY':phase==='finished'?'✓ FINISHED':paused?'PAUSED':phase==='ready'?'AUTO COUNT READY':'HANDS-FREE MODE';
 $('hint').textContent=phase==='repWait'?'No tapping needed. The next rep counts automatically.':phase==='finished'?`Well done! ${total} reps across ${completed} sets.`:phase==='ready'?'Press START. Reps count automatically after preparation.':phase==='rest'?'The next set starts automatically.':phase==='prep'?'Wait for the START voice announcement.':phase==='cooldown'?'Extra rest before the next rep.':'Keep training — no +1 tapping required.';
 $('setDots').replaceChildren(...Array.from({length:Math.min(c.sets,150)},(_,i)=>{
  const d=document.createElement('span');d.className='set'+(i<completed?' done':i===set-1?' current':'');d.textContent=(i<completed?'✓ ':'')+(i+1);return d;
 }));
 updateClock();
}
function getHistory(){try{return JSON.parse(localStorage.getItem('sgc_history')||'[]')}catch{return []}}
function renderHistory(){
 const list=$('historyList');list.replaceChildren();const h=getHistory();
 if(!h.length){list.textContent='No completed workouts yet.';return}
 h.forEach(w=>{
  const b=document.createElement('button');b.className='historyItem';
  b.textContent=`${new Date(w.date).toLocaleString()}  •  ${w.sets} sets  •  ${w.reps} reps`;
  b.onclick=()=>{$('detailPanel').classList.remove('hidden');$('detail').textContent=
  `Date: ${new Date(w.date).toLocaleDateString()}\nStart: ${new Date(w.date).toLocaleTimeString()}\nCompleted sets: ${w.sets}\nTotal reps: ${w.reps}\nDuration: ${duration(w.duration)}\nRep target: ${w.config.reps}\nSelected sets: ${w.config.sets}\nAuto rep interval: ${w.config.repInterval??'N/A'}s\nExtra rep rest: ${w.config.cooldownOn?w.config.cooldown+'s':'OFF'}\nRest: ${w.config.rest}s\nPreparation: ${w.config.prep}s`};list.append(b);
 });
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{
 document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));
 ['workout','settings','history'].forEach(id=>$(id).classList.toggle('hidden',id!==b.dataset.tab));
 if(b.dataset.tab==='history')renderHistory();
});
$('start').onclick=startWorkout;$('pause').onclick=pauseWorkout;
$('reset').onclick=()=>{if(['ready','finished'].includes(phase)||confirm('Reset current workout? Unsaved progress will be lost.'))resetWorkout()};
$('closeDetail').onclick=()=>$('detailPanel').classList.add('hidden');
setInterval(updateClock,500);
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
render();renderHistory();
