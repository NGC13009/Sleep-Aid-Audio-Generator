'use strict';
/* ================================================================
 * 工具
 * ================================================================ */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function nextPow2(n){ let p=1; while(p<n) p<<=1; return p; }
const sleep20 = () => new Promise(r=>setTimeout(r,20));
let toastTimer=0;
function toast(msg,ms,kind){
  const t=$('#toast'); t.textContent=msg;
  t.classList.toggle('err',kind==='err');
  t.classList.toggle('warn',kind==='warn');
  t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'), ms||2600);
}
let statusMsg='', statusKind='', statusTimer=0;
function renderStatus(){
  const el=$('#status');
  if(statusMsg){
    el.textContent=statusMsg;
    el.className='status '+(statusKind||(state.mode==='sleep'?'sleep':state.mode==='rt'?'rt':'idle'));
  }
  else if(state.mode==='rt'){ el.textContent='实时试听中 · 锁屏将自动切换为整夜循环'; el.className='status rt'; }
  else if(state.mode==='sleep'){ el.textContent='睡眠模式运行中 · 可直接锁屏整夜播放'; el.className='status sleep'; }
  else { el.textContent='空闲 · 选择噪声后点击上方按钮开始播放'; el.className='status idle'; }
}
function setStatus(msg,autoClearMs,kind){
  statusMsg=msg||''; statusKind=kind||'';
  clearTimeout(statusTimer); statusTimer=0;
  renderStatus();
  if(statusMsg&&autoClearMs) statusTimer=setTimeout(()=>{ statusMsg=''; statusKind=''; statusTimer=0; renderStatus(); },autoClearMs);
}
function setError(msg,ms){
  const m=msg||'发生错误';
  setStatus(m, ms||6000, 'err');
  toast(m, ms||6000, 'err');
}
function fmtElapsed(ms){
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor(s%3600/60), ss=s%60;
  const two=x=>(x<10?'0':'')+x;
  return (h?h+':':'')+two(m)+':'+two(ss);
}

/* ================================================================
 * DSP 核心：FFT / 随机相位功率谱合成 / 滤波 / 包络
 * ================================================================ */
const TWID=new Map();
function twid(n){
  let t=TWID.get(n);
  if(t) return t;
  if(TWID.size>2) TWID.clear();
  t={ c:new Float64Array(n/2), s:new Float64Array(n/2) };
  for(let k=0;k<n/2;k++){ t.c[k]=Math.cos(2*Math.PI*k/n); t.s[k]=Math.sin(2*Math.PI*k/n); }
  TWID.set(n,t); return t;
}
function fftCore(re,im,inverse){
  const n=re.length, tw=twid(n);
  for(let i=1,j=0;i<n;i++){
    let b=n>>1;
    for(;j&b;b>>=1) j^=b;
    j|=b;
    if(i<j){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; }
  }
  for(let len=2;len<=n;len<<=1){
    const half=len>>1, step=n/len;
    for(let i=0;i<n;i+=len){
      let ti=0;
      for(let k=0;k<half;k++,ti+=step){
        const wr=tw.c[ti], wi=inverse?tw.s[ti]:-tw.s[ti];
        const a=i+k, b2=a+half;
        const xr=re[b2]*wr-im[b2]*wi, xi=re[b2]*wi+im[b2]*wr;
        re[b2]=re[a]-xr; im[b2]=im[a]-xi;
        re[a]+=xr; im[a]+=xi;
      }
    }
  }
  if(inverse){ const inv=1/n; for(let i=0;i<n;i++){ re[i]*=inv; im[i]*=inv; } }
}
/* 随机相位谱合成：ampFn(f) → 频率 f 处的相对幅值。
   结果是周期 N 的随机过程样本（指定功率谱的近似高斯过程），可无缝循环。 */
function synthPeriodic(N,rate,ampFn){
  const re=new Float64Array(N), im=new Float64Array(N);
  const half=N>>1, df=rate/N;
  for(let k=1;k<half;k++){
    const a=ampFn(k*df);
    if(a>0){
      const ph=Math.random()*6.283185307179586;
      const c=a*Math.cos(ph), s=a*Math.sin(ph);
      re[k]=c; im[k]=s; re[N-k]=c; im[N-k]=-s;
    }
  }
  fftCore(re,im,true);
  return new Float32Array(re);
}
/* 单调三次插值（PCHIP）：在 log 频率域对 [f, db] 控制点做平滑曲线 */
function makeSmoothDb(pts){
  const n=pts.length;
  const xs=pts.map(p=>Math.log(p.f));
  const ys=pts.map(p=>p.db);
  if(n===1) return ()=>ys[0];
  const h=new Array(n-1), d=new Array(n-1);
  for(let i=0;i<n-1;i++){ h[i]=xs[i+1]-xs[i]||1e-9; d[i]=(ys[i+1]-ys[i])/h[i]; }
  const m=new Array(n);
  if(n===2){ m[0]=d[0]; m[1]=d[0]; }
  else{
    m[0]=d[0]; m[n-1]=d[n-2];
    for(let i=1;i<n-1;i++){
      if(d[i-1]*d[i]<=0) m[i]=0;
      else{
        const w1=2*h[i]+h[i-1], w2=h[i]+2*h[i-1];
        m[i]=(w1+w2)/(w1/d[i-1]+w2/d[i]);
      }
    }
  }
  return function(f){
    const x=Math.log(f);
    if(x<=xs[0]) return ys[0];
    if(x>=xs[n-1]) return ys[n-1];
    let i=0;
    while(i<n-2 && x>xs[i+1]) i++;
    const t=(x-xs[i])/h[i];
    const t2=t*t, t3=t2*t;
    const h00=2*t3-3*t2+1, h10=t3-2*t2+t, h01=-2*t3+3*t2, h11=t3-t2;
    return h00*ys[i]+h10*h[i]*m[i]+h01*ys[i+1]+h11*h[i]*m[i+1];
  };
}
function sortedPoints(pts){ return pts.slice().sort((a,b)=>a.f-b.f); }
/* 功率谱控制点 → 幅值函数 */
function pointsToAmp(pts){
  const dbAt=makeSmoothDb(sortedPoints(pts));
  return f=>Math.pow(10, dbAt(f)/20);
}
function randNoise(N){ const x=new Float32Array(N); for(let i=0;i<N;i++) x[i]=Math.random()*2-1; return x; }
function rmsOf(x){ let s=0; for(let i=0;i<x.length;i++) s+=x[i]*x[i]; return Math.sqrt(s/x.length)||1e-9; }
function normalizeRMS(x,target){
  const r=rmsOf(x);
  if(r<1e-6) return x;
  const g=target/r;
  for(let i=0;i<x.length;i++) x[i]*=g;
  return x;
}
function peakOf(x){ let p=0; for(let i=0;i<x.length;i++){ const a=Math.abs(x[i]); if(a>p) p=a; } return p; }
function peakGuard(x,limit){
  const lim=(typeof limit==='number')?limit:4;
  const p=peakOf(x);
  if(p>lim){ const g=lim/p; for(let i=0;i<x.length;i++) x[i]*=g; }
  return x;
}
/* 一阶低通：双遍处理（第一遍预热滤除暂态），使输出在循环边界连续 */
function lp1(x,rate,fc){
  const n=x.length, out=new Float32Array(n);
  const a=Math.exp(-2*Math.PI*fc/rate); let y=0;
  for(let p=0;p<2;p++){
    for(let i=0;i<n;i++){ y=a*y+(1-a)*x[i]; if(p) out[i]=y; }
  }
  return out;
}
function hp1(x,rate,fc){
  const lp=lp1(x,rate,fc), n=x.length, out=new Float32Array(n);
  for(let i=0;i<n;i++) out[i]=x[i]-lp[i];
  return out;
}
/* 时变截止频率低通（截止由 fcArr 逐样本给出），同样双遍预热 */
function lp1mod(x,rate,fcArr){
  const n=x.length, out=new Float32Array(n); let y=0;
  for(let p=0;p<2;p++){
    for(let i=0;i<n;i++){
      const a=Math.exp(-2*Math.PI*fcArr[i]/rate);
      y=a*y+(1-a)*x[i];
      if(p) out[i]=y;
    }
  }
  return out;
}
/* 低频带限周期随机信号（慢包络 / 阵风用）。 */
function slowNoise(N,rate,lo,hi){
  const df=rate/N;
  let kLo=Math.max(1,Math.floor(lo/df)), kHi=Math.max(kLo,Math.ceil(hi/df));
  if(kHi-kLo>64) kHi=kLo+64;
  const out=new Float32Array(N);
  let acc=0;
  for(let k=kLo;k<=kHi;k++){
    const w=2*Math.PI*k/N;
    const amp=Math.sqrt(-2*Math.log(Math.max(1e-12,Math.random())))*0.7071;
    const ph=Math.random()*2*Math.PI;
    let c=Math.cos(ph), s=Math.sin(ph);
    const dc=Math.cos(w), ds=Math.sin(w);
    for(let i=0;i<N;i++){
      out[i]+=amp*s;
      const nc=c*dc-s*ds; s=c*ds+s*dc; c=nc;
    }
    acc+=amp*amp/2;
  }
  const g=1/Math.sqrt(acc||1);
  for(let i=0;i<N;i++) out[i]*=g;
  return out;
}
/* 加正弦分量（频率对齐到 FFT bin，保证循环无缝） */
function addSin(out,N,binIndex,amp){
  const w=2*Math.PI*binIndex/N, ph=Math.random()*2*Math.PI;
  let c=Math.cos(ph), s=Math.sin(ph);
  const dc=Math.cos(w), ds=Math.sin(w);
  for(let i=0;i<N;i++){
    out[i]+=amp*s;
    const nc=c*dc-s*ds; s=c*ds+s*dc; c=nc;
  }
}
function humTones(N,rate,tones){
  const out=new Float32Array(N);
  for(const t of tones){
    const k=Math.max(1,Math.round(t[0]*N/rate));
    addSin(out,N,k,t[1]);
  }
  return out;
}
/* 随机脉冲簇（雨滴、雷声等） */
function addBursts(x,rate,count,o){
  const n=x.length, margin=Math.floor(rate*(o.edge||0.5));
  const span=Math.max(1,n-2*margin);
  for(let c=0;c<count;c++){
    const pos=margin+Math.floor(Math.random()*span);
    const len=Math.max(4,Math.floor((o.durMin+Math.random()*(o.durMax-o.durMin))*rate));
    let b=new Float32Array(len);
    for(let i=0;i<len;i++) b[i]=Math.random()*2-1;
    if(o.hp) b=hp1(b,rate,o.hp);
    b=lp1(b,rate,o.fcMin+Math.random()*(o.fcMax-o.fcMin));
    const tau=o.tauMin+Math.random()*(o.tauMax-o.tauMin);
    const atk=o.atk||0.001, amp=o.ampMin+Math.random()*(o.ampMax-o.ampMin);
    for(let i=0;i<len;i++){
      const t=i/rate;
      b[i]*=amp*Math.exp(-t/tau)*(1-Math.exp(-t/atk));
    }
    for(let i=0;i<len&&pos+i<n;i++) x[pos+i]+=b[i];
  }
}
function clamp01(v){ return v<0?0:(v>1?1:v); }
function shapeFromPoints(pts){
  return function(f){
    const first=pts[0], last=pts[pts.length-1];
    if(f<=first[0]) return first[1];
    if(f>=last[0]) return last[1];
    for(let i=1;i<pts.length;i++){
      if(f<=pts[i][0]){
        const a=pts[i-1], b=pts[i];
        const t=(Math.log(f)-Math.log(a[0]))/(Math.log(b[0])-Math.log(a[0]));
        return a[1]+(b[1]-a[1])*t;
      }
    }
    return last[1];
  };
}

/* ================================================================
 * 噪声类型注册表（含自定义谱生成器）
 * ================================================================ */
const NOISES={
  white:  {label:'白噪声',   icon:'▪', cat:'基础噪声', defVol:.55, gen(p){ return randNoise(p.N); }},
  pink:   {label:'粉红噪声', icon:'◐', cat:'基础噪声', defVol:.6,
           gen(p){ return synthPeriodic(p.N,p.rate,f=>1/Math.sqrt(f)); }},
  brown:  {label:'布朗噪声', icon:'●', cat:'基础噪声', defVol:.7,
           gen(p){ return lp1(randNoise(p.N),p.rate,8); }},
  custom: {label:'自定义谱', icon:'🎚', cat:'自定义', defVol:.6,
           gen(p,preset){ return synthPeriodic(p.N,p.rate,pointsToAmp(preset.psd)); }},
  rainL:  {label:'小雨',     icon:'🌦', cat:'自然声音', defVol:.6,
           gen(p){
             const x=synthPeriodic(p.N,p.rate,shapeFromPoints([[80,.12],[400,.5],[1800,1],[5000,.5],[11000,.15]]));
             addBursts(x,p.rate,Math.round(p.T*50),{durMin:.004,durMax:.02,fcMin:1800,fcMax:7000,ampMin:.15,ampMax:.6,tauMin:.004,tauMax:.02,hp:900,edge:.4});
             return x;
           }},
  rainH:  {label:'大雨',     icon:'🌧', cat:'自然声音', defVol:.55,
           gen(p){
             const x=synthPeriodic(p.N,p.rate,shapeFromPoints([[50,.45],[250,.8],[1200,1],[4000,.7],[9000,.3]]));
             addBursts(x,p.rate,Math.round(p.T*160),{durMin:.003,durMax:.015,fcMin:1500,fcMax:6000,ampMin:.25,ampMax:.8,tauMin:.003,tauMax:.012,hp:700,edge:.4});
             return x;
           }},
  storm:  {label:'远雷雨',   icon:'⛈', cat:'自然声音', defVol:.6,
           gen(p){
             const x=synthPeriodic(p.N,p.rate,shapeFromPoints([[100,.15],[500,.5],[1800,1],[4500,.4],[10000,.1]]));
             addBursts(x,p.rate,Math.round(p.T*45),{durMin:.004,durMax:.018,fcMin:1600,fcMax:6500,ampMin:.12,ampMax:.5,tauMin:.004,tauMax:.016,hp:800,edge:.4});
             addBursts(x,p.rate,Math.max(2,Math.round(p.T/14)),{durMin:2.5,durMax:7,fcMin:70,fcMax:160,ampMin:.6,ampMax:1.1,tauMin:1.8,tauMax:4.5,atk:.6,edge:7});
             return x;
           }},
  waves:  {label:'海浪',     icon:'🌊', cat:'自然声音', defVol:.65,
           gen(p){
             const N=p.N, rate=p.rate;
             const g=slowNoise(N,rate,.05,.16);
             const tide=slowNoise(N,rate,.008,.04);
             const low=lp1(randNoise(N),rate,420);
             const hiss=hp1(randNoise(N),rate,700);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++){
               const e=Math.pow(clamp01(g[i]*.55+.6),1.7);
               const t2=.55+.5*clamp01(tide[i]*.6+.5);
               out[i]=(low[i]*e*1.1+hiss[i]*e*e*.9)*t2;
             }
             return out;
           }},
  wind:   {label:'风声',     icon:'🌬', cat:'自然声音', defVol:.6,
           gen(p){
             const N=p.N, rate=p.rate;
             const g=slowNoise(N,rate,.02,.28);
             const gust=new Float32Array(N), fc=new Float32Array(N);
             for(let i=0;i<N;i++){
               const q=Math.pow(clamp01(g[i]*.5+.55),1.4);
               gust[i]=q; fc[i]=180+2600*q*q;
             }
             const base=lp1mod(synthPeriodic(N,rate,f=>1/Math.pow(f,.85)),rate,fc);
             const hiss=hp1(randNoise(N),rate,900);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++) out[i]=base[i]*1.15+hiss[i]*gust[i]*gust[i]*gust[i]*.8;
             return out;
           }},
  leaves: {label:'树叶沙沙', icon:'🍂', cat:'自然声音', defVol:.55,
           gen(p){
             const N=p.N, rate=p.rate;
             const g=slowNoise(N,rate,.06,.5);
             const cr=slowNoise(N,rate,1.5,8);
             const base=hp1(randNoise(N),rate,1400);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++){
               const q=clamp01(g[i]*.5+.55);
               const c=Math.pow(clamp01(cr[i]*.5+.55),2.2);
               out[i]=base[i]*(.12+.88*q)*(.25+.75*c);
             }
             return out;
           }},
  fan:    {label:'风扇',     icon:'🌀', cat:'环境声音', defVol:.5,
           gen(p){
             const N=p.N, rate=p.rate;
             const body=lp1(randNoise(N),rate,520);
             const hiss=lp1(randNoise(N),rate,2500);
             const hum=humTones(N,rate,[[100,.35],[200,.12],[50,.15]]);
             const fl=slowNoise(N,rate,12,30), wob=slowNoise(N,rate,.08,.6);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++) out[i]=(body[i]*1.3+hiss[i]*.25+hum[i])*(1+.14*fl[i]+.08*wob[i]);
             return out;
           }},
  ac:     {label:'空调',     icon:'❄', cat:'环境声音', defVol:.5,
           gen(p){
             const N=p.N, rate=p.rate;
             const body=lp1(randNoise(N),rate,330);
             const hiss=lp1(randNoise(N),rate,1600);
             const hum=humTones(N,rate,[[50,.30],[100,.10],[150,.05]]);
             const fl=slowNoise(N,rate,5,14);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++) out[i]=(body[i]*1.4+hiss[i]*.15+hum[i])*(1+.07*fl[i]);
             return out;
           }},
  dryer:  {label:'吹风机',   icon:'💨', cat:'环境声音', defVol:.45,
           gen(p){
             const N=p.N, rate=p.rate;
             const body=synthPeriodic(N,rate,shapeFromPoints([[60,.5],[300,.9],[1200,1],[3500,.6],[7000,.25]]));
             const rumble=lp1(randNoise(N),rate,200);
             const hum=humTones(N,rate,[[100,.3],[200,.1]]);
             const fl=slowNoise(N,rate,8,20);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++) out[i]=(body[i]*.9+rumble[i]*.8+hum[i])*(1+.15*fl[i]);
             return out;
           }},
  cabin:  {label:'机舱',     icon:'✈', cat:'环境声音', defVol:.5,
           gen(p){
             const N=p.N, rate=p.rate;
             const body=lp1(randNoise(N),rate,380);
             const hiss=lp1(randNoise(N),rate,3000);
             const hum=humTones(N,rate,[[80,.18],[160,.06]]);
             const fl=slowNoise(N,rate,3,10);
             const out=new Float32Array(N);
             for(let i=0;i<N;i++) out[i]=(body[i]*1.5+hiss[i]*.2+hum[i])*(1+.05*fl[i]);
             return out;
           }},
};
const BUILTIN_ORDER=['white','pink','brown','rainL','rainH','storm','waves','wind','leaves','fan','ac','dryer','cabin'];

/* ================================================================
 * 状态：预设列表 + 播放状态
 * ================================================================ */
const DEFAULT_PSD=()=>[{f:20,db:0},{f:20000,db:-30}];
const state={
  rate:44100, loopSec:30,
  mode:'idle',            /* idle | rt | sleep */
  presets:[],
  focusId:null,           /* 功率谱卡片当前绑定的预设 */
  draft:null,             /* 自定义预设的编辑草稿（log 域控制点） */
  masterVol:.8,
  timerEnd:0,
  startedAt:0,
  sleepDirty:true,
};
let customSeq=0;
const player=$('#player');

function findPreset(id){ return state.presets.find(p=>p.id===id)||null; }
function getFocus(){ return findPreset(state.focusId); }
function activePresets(){ return state.presets.filter(p=>p.active); }
function presetRowEl(id){ return document.querySelector('.preset-row[data-id="'+id+'"]'); }

function initPresets(){
  for(const key of BUILTIN_ORDER){
    const d=NOISES[key];
    state.presets.push({ id:key, type:key, label:d.label, icon:d.icon, cat:d.cat, active:key==='pink', vol:d.defVol });
  }
  state.presets.push(newCustomPreset());   /* 默认自带一个自定义预设 */
  renumberCustom();
  state.focusId='pink';   /* 默认选中粉红噪声，只读显示 */
  state.draft=null;
}
function renumberCustom(){
  let n=0;
  for(const p of state.presets){ if(p.type==='custom'){ n++; p.label='自定义'+n; } }
}
function newCustomPreset(){
  customSeq++;
  return { id:'c'+customSeq+'_'+Date.now().toString(36), type:'custom', icon:'🎚', cat:'自定义',
           label:'', active:false, vol:NOISES.custom.defVol, psd:DEFAULT_PSD() };
}
function addCustomPreset(){
  const p=newCustomPreset();
  state.presets.push(p);
  renumberCustom();
  renderPresets(); updateAll(); drawPsd();
  scheduleSave();
  return p;
}
function deleteCustomPreset(id){
  const p=findPreset(id);
  if(!p||p.type!=='custom') return;
  removeRtNode(id);
  state.presets=state.presets.filter(x=>x!==p);
  invalidatePreset(id);
  if(state.focusId===id){ state.focusId=null; state.draft=null; }
  renumberCustom();
  renderPresets(); updateAll(); drawPsd();
  scheduleSave();
}
function setFocus(id){
  if(state.focusId===id) return;
  state.focusId=id;
  const f=getFocus();
  state.draft=(f&&f.type==='custom')? f.psd.map(q=>({...q})) : null;
}
function togglePreset(id){
  const p=findPreset(id);
  if(!p) return;
  p.active=!p.active;
  setFocus(id);   /* 点击查看的那个 → 蓝色高亮 */
  state.sleepDirty=true;
  if(state.mode==='rt'){ if(p.active) refreshPreset(id); else removeRtNode(id); }
  else if(state.mode==='sleep'){ toast('睡眠模式播放中：改动将在下次启动时生效',2600,'warn'); }
  updateAll(); drawPsd();
  scheduleSave();
}

/* ================================================================
 * 设置持久化：页面上的按钮 / 选项 / 设定全部写入 Cookie（保留 90 天）
 * ================================================================ */
const COOKIE_NAME='limitless_cfg';
const COOKIE_DAYS=90;
function writeCookie(name,val){
  const d=new Date(Date.now()+COOKIE_DAYS*864e5);
  document.cookie=name+'='+encodeURIComponent(val)+';expires='+d.toUTCString()+';path=/;SameSite=Lax';
}
function readCookie(name){
  const key=name+'=';
  const parts=document.cookie?document.cookie.split(/;\s*/):[];
  for(const c of parts){ if(c.lastIndexOf(key,0)===0) return decodeURIComponent(c.slice(key.length)); }
  return '';
}
function collectSettings(){
  return {
    night: document.documentElement.classList.contains('night')?1:0,
    rate: state.rate,
    loop: state.loopSec,
    vol: Math.round(state.masterVol*100),
    timer: $('#timerSel').value,
    focus: state.focusId||'',
    ps: state.presets.map(p=>p.type==='custom'
      ? {t:'c', id:p.id, a:p.active?1:0, v:Math.round(p.vol*100), psd:p.psd.map(q=>[+q.f.toFixed(1),Math.round(q.db)])}
      : {t:p.type, a:p.active?1:0, v:Math.round(p.vol*100)}),
    fold: $$('.card').map(c=>c.classList.contains('collapsed')?1:0),
    det: $$('details').map(d=>d.open?1:0),
  };
}
let saveTimer=0;
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(saveSettings,250);
}
function saveSettings(){
  saveTimer=0;
  try{ writeCookie(COOKIE_NAME,JSON.stringify(collectSettings())); }catch(e){}
}
function loadSettings(){
  try{ const raw=readCookie(COOKIE_NAME); return raw?JSON.parse(raw):null; }catch(e){ return null; }
}
let persisted=null;
function volFromSaved(v,def){
  const n=+v;
  return Number.isFinite(n)?clamp01(n/100):def;
}
function restorePresets(list){
  const out=[];
  for(const sp of list){
    if(!sp||typeof sp!=='object') continue;
    if(sp.t==='c'){
      if(!Array.isArray(sp.psd)) continue;
      const psd=sp.psd.filter(q=>Array.isArray(q)&&q.length>=2&&isFinite(+q[0])&&isFinite(+q[1]))
                     .map(q=>({f:Math.max(FMIN,Math.min(FMAX,+q[0])),db:Math.max(DBMIN,Math.min(DBMAX,Math.round(+q[1])))}));
      if(psd.length<2) continue;
      out.push({ id:sp.id||('c0_'+out.length), type:'custom', icon:NOISES.custom.icon, cat:'自定义',
                 label:'', active:!!sp.a, vol:volFromSaved(sp.v,NOISES.custom.defVol), psd });
    }else if(NOISES[sp.t]){
      const d=NOISES[sp.t];
      out.push({ id:sp.t, type:sp.t, label:d.label, icon:d.icon, cat:d.cat,
                 active:!!sp.a, vol:volFromSaved(sp.v,d.defVol) });
    }
  }
  for(const key of BUILTIN_ORDER){
    if(!out.some(p=>p.type===key)){
      const d=NOISES[key];
      out.push({ id:key, type:key, label:d.label, icon:d.icon, cat:d.cat, active:false, vol:d.defVol });
    }
  }
  if(!out.some(p=>p.type==='custom')) out.push(newCustomPreset());
  let n=0;
  for(const p of out){ if(p.type==='custom'){ n++; p.label='自定义'+n; } }
  return out;
}
function applySettings(s){
  if(!s||typeof s!=='object') return;
  const on=!!s.night;
  document.documentElement.classList.toggle('night',on);
  $('#nightBtn').textContent=on?'☀ 日间':'🌙 夜间';
  if(+s.rate) state.rate=+s.rate;
  if(+s.loop) state.loopSec=+s.loop;
  if(Number.isFinite(+s.vol)) state.masterVol=clamp01(+s.vol/100);
  if(typeof s.timer==='string') $('#timerSel').value=s.timer;
  if(Array.isArray(s.ps)&&s.ps.length) state.presets=restorePresets(s.ps);
  state.focusId=(s.focus&&findPreset(s.focus))?s.focus:((state.presets.find(p=>p.active)||state.presets[0]||{id:null}).id);
  const f=getFocus();
  state.draft=(f&&f.type==='custom')?f.psd.map(q=>({...q})):null;
  $('#rateSel').value=String(state.rate);
  $('#loopSel').value=String(state.loopSec);
  $('#masterVol').value=Math.round(state.masterVol*100);
  $('#masterVolVal').textContent=Math.round(state.masterVol*100);
}
/* 每次启动播放时，睡眠定时都从 0 秒重新计时 */
function armTimerFromSelect(){
  const v=$('#timerSel').value;
  state.timerEnd=(v&&v!=='off')?Date.now()+(+v)*60000:0;
}

/* ================================================================
 * 渲染参数 / 缓存
 * ================================================================ */
function renderParams(){
  const N=nextPow2(state.loopSec*state.rate);
  return { N, rate:state.rate, T:N/state.rate };
}
const layerCache=new Map();
function layerBuffer(preset){
  const p=renderParams();
  let key=preset.id+'|'+p.N+'|'+p.rate;
  if(preset.type==='custom') key+='|'+sortedPoints(preset.psd).map(q=>q.f.toFixed(1)+','+q.db.toFixed(1)).join(';');
  if(layerCache.has(key)) return layerCache.get(key);
  const buf=NOISES[preset.type].gen(p,preset);
  normalizeRMS(buf,1);
  peakGuard(buf,3.5);
  layerCache.set(key,buf);
  return buf;
}
function invalidatePreset(id){
  for(const k of Array.from(layerCache.keys())){
    if(k.startsWith(id+'|')) layerCache.delete(k);
  }
}

/* ================================================================
 * 混音渲染（睡眠模式 / 导出 WAV 用）
 * ================================================================ */
let sleepBlob=null, sleepURL=null, renderingSleep=false;
let sleepRenderPromise=null;        /* 渲染进行中的共享 Promise，避免并发重复渲染 */
let sleepPCM=null;                  /* 睡眠混音原始采样（Web Audio 无缝循环用） */
let sleepSrc=null, sleepGain=null;  /* Web Audio 睡眠循环节点 */
let anchorEl=null, anchorURL=null, anchorSrcNode=null;  /* 媒体会话锚点（静音，仅注册系统控件） */
let usingFallback=false;            /* 是否已回退到原生 <audio> 管线 */
let userPaused=false;               /* 用户主动暂停（避免误触后台回退） */
async function prerenderSleep(){
  if(renderingSleep) return sleepRenderPromise;
  const act=activePresets();
  if(!act.length) return;
  renderingSleep=true;
  sleepRenderPromise=(async()=>{
    try{
      const p=renderParams();
      const out=new Float32Array(p.N);
      for(const preset of act){
        setStatus('正在渲染 '+preset.label+' …');
        await sleep20();
        const data=layerBuffer(preset);
        for(let i=0;i<p.N;i++) out[i]+=data[i]*preset.vol;
      }
      const g0=.22/rmsOf(out);
      const pk=peakOf(out);
      const g=(g0*pk>.97)?.97/pk:g0;
      for(let i=0;i<p.N;i++) out[i]*=g;
      sleepBlob=encodeWav(out,state.rate);
      sleepPCM=out;
      state.sleepDirty=false;
      setStatus('混音渲染完成（'+p.T.toFixed(0)+' 秒无缝循环）',3500);
    }catch(e){
      setError('渲染失败：'+e.message);
    }
  })();
  try{ await sleepRenderPromise; }finally{ renderingSleep=false; sleepRenderPromise=null; }
}
function encodeWav(f32,rate){
  const n=f32.length;
  const buf=new ArrayBuffer(44+n*2);
  const dv=new DataView(buf);
  const wstr=(off,s)=>{ for(let i=0;i<s.length;i++) dv.setUint8(off+i,s.charCodeAt(i)); };
  wstr(0,'RIFF'); dv.setUint32(4,36+n*2,true); wstr(8,'WAVE');
  wstr(12,'fmt '); dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,rate,true); dv.setUint32(28,rate*2,true); dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  wstr(36,'data'); dv.setUint32(40,n*2,true);
  let o=44;
  for(let i=0;i<n;i++){
    let v=f32[i];
    if(v>1) v=1; else if(v<-1) v=-1;
    dv.setInt16(o, v<0? v*32768 : v*32767, true);
    o+=2;
  }
  return new Blob([buf],{type:'audio/wav'});
}

/* ================================================================
 * 实时引擎（Web Audio 音频线程，支持任意数量预设叠加）
 * ================================================================ */
let AC=null, masterGain=null, analyser=null;
const rtNodes=new Map();
function ensureAC(){
  if(!AC){
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx) throw new Error('当前浏览器不支持 Web Audio');
    AC=new Ctx();
    masterGain=AC.createGain();
    analyser=AC.createAnalyser();
    analyser.fftSize=4096; analyser.smoothingTimeConstant=0; /* 实时：无声音时立即归零 */
    masterGain.connect(analyser);
    analyser.connect(AC.destination);
    try{ AC.onstatechange=onACStateChange; }catch(e){}
  }
  if(AC.state==='suspended') AC.resume();
}
function removeRtNode(id){
  const node=rtNodes.get(id);
  if(node){ try{ node.src.stop(); }catch(e){} rtNodes.delete(id); }
}
function stopRT(){
  for(const id of Array.from(rtNodes.keys())) removeRtNode(id);
}

/* ---- 睡眠模式的 Web Audio 无缝循环（样本级无缝，桌面后台/锁屏可续播） ---- */
function stopWebAudioSleep(){
  if(sleepSrc){
    try{ sleepSrc.stop(); }catch(e){}
    try{ sleepSrc.disconnect(); }catch(e){}
    sleepSrc=null;
  }
}
function startWebAudioSleep(){
  if(!sleepPCM) return false;
  try{ ensureAC(); }catch(e){ return false; }
  if(masterGain&&masterGain.gain.value!==1) masterGain.gain.value=1;
  stopWebAudioSleep();
  if(!sleepGain){ sleepGain=AC.createGain(); sleepGain.connect(masterGain); }
  const ab=AC.createBuffer(1,sleepPCM.length,state.rate);
  ab.getChannelData(0).set(sleepPCM);
  sleepSrc=AC.createBufferSource();
  sleepSrc.buffer=ab; sleepSrc.loop=true;
  sleepSrc.connect(sleepGain);
  sleepGain.gain.value=state.masterVol;
  sleepSrc.start();
  usingFallback=false;
  return true;
}
/* 媒体会话锚点：隐藏媒体元素播放整段 WAV，经 Web Audio 以 0 增益接入（静音），
   仅用于注册系统媒体会话 / 锁屏控件，并让浏览器把标签视为“正在播放”。
   真正的无缝声音由 startWebAudioSleep 的 AudioBufferSourceNode 输出。 */
function ensureAnchor(){
  if(!sleepBlob) return false;
  try{ ensureAC(); }catch(e){ return false; }
  if(!anchorEl){
    anchorEl=document.createElement('audio');
    anchorEl.loop=true; anchorEl.preload='auto';
    anchorEl.setAttribute('playsinline','');
    document.body.appendChild(anchorEl);
  }
  if(anchorURL) URL.revokeObjectURL(anchorURL);
  anchorURL=URL.createObjectURL(sleepBlob);
  anchorEl.src=anchorURL;
  try{
    if(!anchorSrcNode){
      anchorSrcNode=AC.createMediaElementSource(anchorEl);
      const z=AC.createGain(); z.gain.value=0;   /* 静音：锚点只登记会话，不发声 */
      anchorSrcNode.connect(z); z.connect(AC.destination);
    }
  }catch(e){}
  const p=anchorEl.play();
  if(p&&p.catch) p.catch(()=>{});
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState='playing'; }catch(e){}
  return true;
}
function stopAnchor(){
  if(anchorEl){ try{ anchorEl.pause(); }catch(e){} }
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState='none'; }catch(e){}
}
/* 回退：系统挂起 AudioContext 时改用原生 <audio loop>（可出声，但循环点有缝隙） */
function startMediaFallback(){
  if(!sleepBlob) return false;
  stopAnchor();
  if(sleepURL) URL.revokeObjectURL(sleepURL);
  sleepURL=URL.createObjectURL(sleepBlob);
  player.loop=true;
  player.src=sleepURL;
  player.volume=state.masterVol;
  const p=player.play();
  if(p&&p.catch) p.catch(()=>{});
  usingFallback=true;
  stopWebAudioSleep();
  try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState='playing'; }catch(e){}
  return true;
}
function onACStateChange(){
  updateChips();
  if(state.mode==='sleep'&&!usingFallback&&!userPaused&&document.hidden&&AC&&AC.state!=='running'){
    if(startMediaFallback()) updateAll();
  }
}
async function refreshPreset(id){
  removeRtNode(id);
  const p=findPreset(id);
  if(!p||!p.active||!AC) return;
  setStatus('正在渲染 '+p.label+' …');
  await sleep20();
  const data=layerBuffer(p);
  const ab=AC.createBuffer(1,data.length,renderParams().rate);
  ab.getChannelData(0).set(data);
  const src=AC.createBufferSource();
  src.buffer=ab; src.loop=true;
  const g=AC.createGain(); g.gain.value=p.vol;
  src.connect(g); g.connect(masterGain);
  src.start();
  rtNodes.set(id,{src,g});
  setStatus('');
}
async function startRT(){
  if(!activePresets().length){ setError('请先选择至少一种噪声'); return; }
  const freshStart=state.mode!=='rt';   /* 由空闲/睡眠启动才算新一次计时 */
  unlockMedia();
  ensureAC();
  stopSleep(true);
  stopRT();
  usingFallback=false;
  userPaused=false;
  state.mode='rt';
  state.startedAt=Date.now();
  for(const p of activePresets()) await refreshPreset(p.id);
  masterGain.gain.value=state.masterVol*.4;
  requestWakeLock();
  if(freshStart) armTimerFromSelect();
  startTicker();
  startPsdLoop();
  updateAll();
  prerenderSleep(); /* 后台预渲染睡眠混音，锁屏时无缝切换 */
}

/* ================================================================
 * 睡眠引擎（Web Audio 无缝循环；系统挂起时回退原生 <audio> 循环）
 * ================================================================ */
let mediaUnlocked=false, unlockURL=null;
function unlockMedia(){
  if(mediaUnlocked||state.mode==='sleep') return;
  try{
    const r=8000, L=Math.floor(r*.25);
    unlockURL=URL.createObjectURL(encodeWav(new Float32Array(L),r));
    const oldLoop=player.loop;
    player.loop=false;
    player.src=unlockURL;
    const p=player.play();
    if(p&&p.then){
      p.then(()=>{ player.pause(); mediaUnlocked=true; player.loop=oldLoop; })
       .catch(()=>{});
    } else { mediaUnlocked=true; }
  }catch(e){}
}
async function startSleep(auto){
  if(!activePresets().length){ if(!auto) setError('请先选择至少一种噪声'); return false; }
  unlockMedia();
  try{ ensureAC(); }catch(e){}
  if(state.sleepDirty||!sleepBlob||!sleepPCM){
    setStatus('正在合成整夜无缝循环 …');
    await sleep20();
    await prerenderSleep();
    if(!sleepPCM){ if(!auto) setError('渲染失败，请重试'); return false; }
  }
  usingFallback=false;
  userPaused=false;
  let ok=false;
  try{ ok=startWebAudioSleep(); }catch(e){ ok=false; }
  if(!ok&&!startMediaFallback()){
    if(!auto) setError('播放被浏览器拦截，请再点一次「进入睡眠模式」');
    return false;
  }
  if(!usingFallback){ try{ ensureAnchor(); }catch(e){} }
  stopRT();
  state.mode='sleep';
  state.startedAt=Date.now();
  setMediaSession();
  requestWakeLock();
  armTimerFromSelect();
  startTicker();
  updateAll();
  drawPsd();   /* 立即重绘频谱：显示琥珀色 INOP 提示 */
  if(!auto) toast('睡眠模式已启动：现在可以直接锁屏，声音会持续整夜');
  return true;
}
function stopSleep(keepMode){
  stopWebAudioSleep();
  stopAnchor();
  try{ player.pause(); }catch(e){}
  if(!keepMode){
    try{ player.removeAttribute('src'); player.load(); }catch(e){}
    if(sleepURL){ URL.revokeObjectURL(sleepURL); sleepURL=null; }
    if(anchorURL){ URL.revokeObjectURL(anchorURL); anchorURL=null; }
  }
  usingFallback=false;
}
/* 锁屏/切后台时：确保 Web Audio 无缝睡眠循环持续，并挂上媒体会话锚点 */
async function autoSwitchToSleep(){
  if(state.mode!=='rt') return;
  try{
    if(state.sleepDirty||!sleepPCM) await prerenderSleep();
    if(!sleepPCM){
      startMediaFallback();
    }else{
      usingFallback=false;
      try{ if(!startWebAudioSleep()) startMediaFallback(); }catch(e){ startMediaFallback(); }
      if(!usingFallback){ try{ ensureAnchor(); }catch(e){} }
    }
    stopRT();
    state.mode='sleep';
    setMediaSession();
    updateAll();
  }catch(e){ /* 保持实时引擎 */ }
}
function stopAll(){
  stopRT();
  stopSleep(false);
  userPaused=false;
  releaseWakeLock();
  stopTicker();
  state.mode='idle';
  state.startedAt=0;
  setStatus('');
  updateAll();
  drawPsd();   /* 清除 INOP 提示，恢复频谱预览 */
}

/* ================================================================
 * Wake Lock / MediaSession / 定时器
 * ================================================================ */
let wakeLock=null;
async function requestWakeLock(){
  if(!('wakeLock' in navigator)){ updateChips(); return; }
  try{
    if(wakeLock&&!wakeLock.released) return;
    wakeLock=await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release',updateChips);
    updateChips();
  }catch(e){ updateChips(); }
}
function releaseWakeLock(){
  if(wakeLock&&!wakeLock.released){ try{ wakeLock.release(); }catch(e){} }
  wakeLock=null;
  updateChips();
}
let iconURL=null;
function makeIcon(){
  const c=document.createElement('canvas'); c.width=c.height=192;
  const g=c.getContext('2d');
  g.fillStyle='#1e1e1e'; g.fillRect(0,0,192,192);
  g.fillStyle='#efefef'; g.font='110px serif'; g.textAlign='center'; g.textBaseline='middle';
  g.fillText('🌙',96,104);
  return c.toDataURL('image/png');
}
function setMediaSession(){
  if(!('mediaSession' in navigator)){ updateChips(); return; }
  try{
    if(!iconURL) iconURL=makeIcon();
    navigator.mediaSession.metadata=new MediaMetadata({
      title:'助眠噪声 · 循环播放中',
      artist:'limitless 噪声模拟器',
      album:'睡眠模式',
      artwork:[{src:iconURL,sizes:'192x192',type:'image/png'}]
    });
    navigator.mediaSession.playbackState='playing';
    updateChips();
  }catch(e){ updateChips(); }
}
function resumePlayback(){
  userPaused=false;
  if(state.mode==='sleep'&&usingFallback){ const p=player.play(); if(p&&p.catch) p.catch(()=>{}); return; }
  if(AC&&state.mode!=='idle'){ try{ AC.resume(); }catch(e){} }
  if(anchorEl&&state.mode==='sleep'){
    const p=anchorEl.play(); if(p&&p.catch) p.catch(()=>{});
    try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState='playing'; }catch(e){}
  }
}
function pausePlayback(){
  userPaused=true;
  if(state.mode==='sleep'&&usingFallback){ try{ player.pause(); }catch(e){} ; return; }
  if(AC&&state.mode==='sleep'){ try{ AC.suspend(); }catch(e){} }
  if(anchorEl&&state.mode==='sleep'){
    try{ anchorEl.pause(); }catch(e){}
    try{ if('mediaSession' in navigator) navigator.mediaSession.playbackState='paused'; }catch(e){}
  }
}
try{
  if('mediaSession' in navigator){
    navigator.mediaSession.setActionHandler('play',()=>{ resumePlayback(); });
    navigator.mediaSession.setActionHandler('pause',()=>{ pausePlayback(); });
    navigator.mediaSession.setActionHandler('stop',()=>stopAll());
  }
}catch(e){}

let ticker=null;
function startTicker(){
  if(ticker) return;
  ticker=setInterval(tick,1000);
}
function stopTicker(){ clearInterval(ticker); ticker=null; }
function tick(){
  if(!state.startedAt) return;
  const now=Date.now();
  $('#cTime').textContent=fmtElapsed(now-state.startedAt);
  if(state.timerEnd){
    const rem=state.timerEnd-now;
    if(rem<=0){
      stopAll();
      toast('定时结束，播放已停止');
      state.timerEnd=0;
      return;
    }
    if(rem<60000){ /* 最后 1 分钟淡出 */
      const f=rem/60000;
      if(state.mode==='sleep'){
        if(usingFallback){ try{ player.volume=Math.min(state.masterVol,state.masterVol*f); }catch(e){} }
        else if(sleepGain){ sleepGain.gain.value=state.masterVol*f; }
      }
      if(state.mode==='rt'&&masterGain){ masterGain.gain.value=state.masterVol*.4*f; }
    }
  }
}

/* ================================================================
 * 可视化：功率谱（平滑曲线 + 实时均衡器柱状叠加）
 * ================================================================ */
const psdCanvas=$('#psd');
const FMIN=20, FMAX=20000, DBMAX=10, DBMIN=-60;
const PSD_BARS=56;
const peakBars=new Float32Array(PSD_BARS);
const peakHold=new Float32Array(PSD_BARS);
const PEAK_HOLD=0.3;        /* 顶端峰值保持时间（秒） */
const PEAK_FALL=0.45;       /* 峰值下落速度（可视区域高度/秒） */
let psdRaf=0, psdLastTs=0;
function psdX(f,W,pad){ return pad+(Math.log(f/FMIN)/Math.log(FMAX/FMIN))*(W-2*pad); }
function psdInvX(x,W,pad){
  const t=(x-pad)/(W-2*pad);
  const f=FMIN*Math.pow(FMAX/FMIN,Math.max(0,Math.min(1,t)));
  return Math.max(FMIN,Math.min(FMAX,f));
}
function psdY(db,H,pad){ return pad+((DBMAX-db)/(DBMAX-DBMIN))*(H-2*pad); }
function psdInvY(y,H,pad){
  return Math.max(DBMIN,Math.min(DBMAX,DBMAX-((y-pad)/(H-2*pad))*(DBMAX-DBMIN)));
}
function sizeCanvas(cv){
  const dpr=window.devicePixelRatio||1;
  const w=cv.clientWidth, h=cv.clientHeight;
  if(cv.width!==Math.round(w*dpr)||cv.height!==Math.round(h*dpr)){
    cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr);
  }
  return {W:cv.width,H:cv.height,dpr};
}
function cssVar(name,fb){
  const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v||fb;
}
function drawBars(g,W,H,dpr,pad){
  const bottom=H-pad, top=pad, areaH=Math.max(1,bottom-top);
  const now=performance.now()/1000;
  const dt=psdLastTs?Math.min(0.1,now-psdLastTs):0;
  psdLastTs=now;
  const bw=(W-2*pad)/PSD_BARS;
  const mags=new Float32Array(PSD_BARS);
  const live=state.mode==='rt'&&analyser&&!document.hidden;
  if(live){
    const bins=analyser.frequencyBinCount;
    const data=new Uint8Array(bins);
    analyser.getByteFrequencyData(data);
    const nyq=AC?AC.sampleRate/2:24000;
    for(let b=0;b<PSD_BARS;b++){
      const f0=30*Math.pow(nyq/30,b/PSD_BARS);
      const f1=30*Math.pow(nyq/30,(b+1)/PSD_BARS);
      const i0=Math.min(bins-1,Math.round(f0/nyq*bins));
      const i1=Math.min(bins,Math.max(i0+1,Math.round(f1/nyq*bins)));
      let m=0;
      for(let i=i0;i<i1;i++) if(data[i]>m) m=data[i];
      mags[b]=m/255;
    }
  }
  for(let b=0;b<PSD_BARS;b++){
    const h=mags[b]*areaH;
    if(h>=peakBars[b]){ peakBars[b]=h; peakHold[b]=PEAK_HOLD; }
    else if(peakHold[b]>0) peakHold[b]=Math.max(0,peakHold[b]-dt);
    else peakBars[b]=Math.max(h,peakBars[b]-areaH*PEAK_FALL*dt);
  }
  const grad=g.createLinearGradient(0,bottom,0,top);
  grad.addColorStop(0.00,'#2ecc40');
  grad.addColorStop(0.45,'#b6e021');
  grad.addColorStop(0.68,'#ffdc00');
  grad.addColorStop(0.85,'#ff851b');
  grad.addColorStop(1.00,'#ff4136');
  g.fillStyle=grad;
  for(let b=0;b<PSD_BARS;b++){
    const h=mags[b]*areaH;
    if(h>0.5) g.fillRect(pad+b*bw+1,bottom-h,Math.max(1,bw-2),h);
  }
  g.fillStyle=cssVar('--ink','#1e1e1e');
  for(let b=0;b<PSD_BARS;b++){
    if(peakBars[b]<=1) continue;
    g.fillRect(pad+b*bw+1,bottom-peakBars[b]-Math.max(1,2*dpr),Math.max(1,bw-2),Math.max(1,2*dpr));
  }
}
/* 睡眠模式：频谱仪不可用，居中打印琥珀色 INOP 提示（覆盖绘图区，数据被压暗） */
function drawInop(g,W,H,dpr,amber,bg){
  const pad=14*dpr;
  const cx=W/2, cy=H/2;
  g.save();
  g.globalAlpha=0.88; g.fillStyle=bg;
  g.fillRect(pad,pad,W-2*pad,H-2*pad);
  g.globalAlpha=1;
  g.textAlign='center'; g.textBaseline='middle'; g.fillStyle=amber;
  g.font='700 '+Math.round(34*dpr)+'px monospace, "DejaVu Sans Mono", sans-serif';
  g.fillText('INOP',cx,cy-Math.round(16*dpr));
  g.font='500 '+Math.round(14*dpr)+'px sans-serif';
  g.fillText('睡眠模式下频谱仪不可用',cx,cy+Math.round(22*dpr));
  g.restore();
}
function currentPoints(){
  const f=getFocus();
  return (f&&f.type==='custom'&&state.draft)? state.draft : null;
}
function isEditable(){
  const f=getFocus();
  return !!(f&&f.type==='custom'&&state.draft);
}
function drawPsd(){
  const {W,H,dpr}=sizeCanvas(psdCanvas);
  const g=psdCanvas.getContext('2d');
  const pad=14*dpr;
  const ink=cssVar('--ink','#1e1e1e');
  const ink3=cssVar('--ink3','#888');
  const line2=cssVar('--line2','#ccc');
  const accent=cssVar('--accent','#2563eb');
  const amber=cssVar('--status-rt','#b26a00');
  const bg=cssVar('--soft','#efefef');
  g.fillStyle=bg; g.fillRect(0,0,W,H);
  /* 网格与刻度 */
  g.strokeStyle=line2; g.lineWidth=1*dpr;
  g.font=(10*dpr)+'px sans-serif'; g.fillStyle=ink3;
  const freqs=[20,50,100,200,500,1000,2000,5000,10000,20000];
  for(const f of freqs){
    const x=psdX(f,W,pad);
    g.beginPath(); g.moveTo(x,pad); g.lineTo(x,H-pad); g.stroke();
    const lab=f>=1000?(f/1000)+'k':f+'';
    g.fillText(lab,Math.max(2,x-12*dpr),H-pad+13*dpr);
  }
  for(let db=DBMAX;db>=DBMIN;db-=10){
    const y=psdY(db,H,pad);
    g.beginPath(); g.moveTo(pad,y); g.lineTo(W-pad,y); g.stroke();
    g.fillText(db+'',4*dpr,y+3*dpr);
  }
  /* 实时均衡器柱状（叠加在网格之上、曲线之下） */
  drawBars(g,W,H,dpr,pad);
  /* 奈奎斯特线 */
  const nyq=state.rate/2;
  if(nyq<FMAX-1){
    const x=psdX(Math.min(nyq,FMAX),W,pad);
    g.save(); g.setLineDash([5*dpr,4*dpr]); g.strokeStyle=amber;
    g.beginPath(); g.moveTo(x,pad); g.lineTo(x,H-pad); g.stroke();
    g.fillStyle=amber;
    g.fillText('奈奎斯特 '+(nyq/1000)+'k',Math.min(x+4*dpr,W-74*dpr),pad+12*dpr);
    g.restore();
  }
  /* 平滑功率谱曲线 + 控制点 */
  const pts=currentPoints();
  if(pts&&pts.length){
    const sorted=sortedPoints(pts);
    const dbAt=makeSmoothDb(sorted);
    g.strokeStyle=ink; g.lineWidth=2*dpr;
    g.beginPath();
    const SEG=200;
    for(let i=0;i<=SEG;i++){
      const x=pad+(W-2*pad)*i/SEG;
      const y=psdY(dbAt(psdInvX(x,W,pad)),H,pad);
      if(i===0) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.stroke();
    for(const p of sorted){
      g.fillStyle=accent;
      g.beginPath(); g.arc(psdX(p.f,W,pad),psdY(p.db,H,pad),4.5*dpr,0,6.2832);
      g.fill();
      g.strokeStyle=bg; g.lineWidth=1.5*dpr; g.stroke();
    }
  }
  /* 睡眠模式下频谱仪不可用：居中打印琥珀色 INOP 提示 */
  if(state.mode==='sleep') drawInop(g,W,H,dpr,amber,bg);
}
function startPsdLoop(){
  if(psdRaf) return;
  const step=()=>{ drawPsd(); psdRaf=requestAnimationFrame(step); };
  psdRaf=requestAnimationFrame(step);
}
function stopPsdLoop(){
  if(psdRaf){ cancelAnimationFrame(psdRaf); psdRaf=0; }
  peakBars.fill(0);
  peakHold.fill(0);
  psdLastTs=0;
  drawPsd();
}
let dragIdx=-1, dragObj=null;
function psdPointer(e){
  const r=psdCanvas.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const x=(e.clientX-r.left)*dpr, y=(e.clientY-r.top)*dpr;
  const {W,H}=sizeCanvas(psdCanvas);
  const pad=14*dpr;
  return {x,y,W,H,pad,dpr};
}
function nearestPt(x,y,W,H,pad,dpr,pts){
  let best=-1,bd=1e9;
  pts.forEach((p,i)=>{
    const dx=psdX(p.f,W,pad)-x, dy=psdY(p.db,H,pad)-y;
    const d=dx*dx+dy*dy;
    if(d<bd){ bd=d; best=i; }
  });
  return (bd<(18*dpr)*(18*dpr))?best:-1;
}
function afterPsdEdit(){ drawPsd(); updatePsdUI(); }
psdCanvas.addEventListener('pointerdown',e=>{
  if(!isEditable()) return;
  e.preventDefault();
  try{ psdCanvas.setPointerCapture(e.pointerId); }catch(err){}
  const {x,y,W,H,pad,dpr}=psdPointer(e);
  const near=nearestPt(x,y,W,H,pad,dpr,state.draft);
  if(near>=0){ dragObj=state.draft[near]; }
  else{
    dragObj={f:psdInvX(x,W,pad),db:Math.round(psdInvY(y,H,pad))};
    state.draft.push(dragObj);
  }
  dragIdx=state.draft.indexOf(dragObj);
  afterPsdEdit();
});
psdCanvas.addEventListener('pointermove',e=>{
  if(!isEditable()||dragIdx<0||!dragObj) return;
  const {x,y,W,H,pad}=psdPointer(e);
  dragObj.f=psdInvX(x,W,pad);
  dragObj.db=Math.round(psdInvY(y,H,pad));
  afterPsdEdit();
});
psdCanvas.addEventListener('pointerup',()=>{
  if(dragIdx>=0) afterPsdEdit();
  dragIdx=-1; dragObj=null;
});
psdCanvas.addEventListener('dblclick',e=>{
  if(!isEditable()) return;
  const {x,y,W,H,pad,dpr}=psdPointer(e);
  const near=nearestPt(x,y,W,H,pad,dpr,state.draft);
  if(near>=0&&state.draft.length>2){
    state.draft.splice(near,1);
    afterPsdEdit();
  }
});
$$('.small-btn[data-psd]').forEach(b=>{
  b.addEventListener('click',()=>{
    if(!isEditable()) return;
    const m=b.getAttribute('data-psd');
    if(m==='white') state.draft=[{f:20,db:0},{f:20000,db:0}];
    if(m==='pink')  state.draft=[{f:20,db:0},{f:20000,db:-30}];
    if(m==='brown') state.draft=[{f:20,db:0},{f:20000,db:-60}];
    afterPsdEdit();
  });
});
function psdIsDirty(){
  const f=getFocus();
  if(!f||f.type!=='custom'||!state.draft) return false;
  const a=state.draft, b=f.psd;
  if(a.length!==b.length) return true;
  for(let i=0;i<a.length;i++){
    if(Math.abs(a[i].f-b[i].f)>1e-6||Math.round(a[i].db)!==Math.round(b[i].db)) return true;
  }
  return false;
}
function applyPsd(){
  const f=getFocus();
  if(!f||f.type!=='custom'||!state.draft) return;
  f.psd=state.draft.map(q=>({...q}));
  invalidatePreset(f.id);
  state.sleepDirty=true;
  if(f.active&&state.mode==='rt') refreshPreset(f.id);
  state.focusId=f.id;
  state.draft=f.psd.map(q=>({...q}));
  updatePsdUI(); drawPsd();
  toast('已应用频谱修改');
  scheduleSave();
}
$('#psdApply').addEventListener('click',applyPsd);
function updatePsdUI(){
  const f=getFocus();
  $('#psdPresetName').textContent=f?f.label:'（未选择预设）';
  const editable=isEditable();
  $$('.small-btn[data-psd]').forEach(b=>{ b.disabled=!editable; });
  const applyBtn=$('#psdApply');
  applyBtn.disabled=!(editable&&psdIsDirty());
  applyBtn.textContent=editable?'生效编辑':'预设项无法编辑';
  const note=$('#psdNote');
  if(!f) note.textContent='请先在上方「预设噪声选项」中选择一个噪声预设。';
  else if(f.type!=='custom') note.textContent='内置预设的频谱不可编辑；此处叠加显示的是实时频谱柱状图。若要自定义频谱，请添加并选择一个自定义预设。试听模式可用，睡眠模式频谱功能不可用。';
  else note.textContent='拖动圆点编辑平滑曲线，双击圆点删除；曲线与当前保存的频谱不同后，点击「生效编辑」保存修改。试听模式可用，睡眠模式频谱功能不可用。';
  psdCanvas.classList.toggle('readonly',!editable);
  if(!editable){ dragIdx=-1; dragObj=null; }
}
window.addEventListener('resize',()=>{ drawPsd(); });

/* ================================================================
 * UI：预设行构建 / 状态刷新
 * ================================================================ */
function applyVol(p,pct){
  pct=Math.max(0,Math.min(100,Math.round(pct)));
  p.vol=pct/100;
  state.sleepDirty=true;
  const node=rtNodes.get(p.id);
  if(node) node.g.gain.value=p.vol;
  const row=presetRowEl(p.id);
  if(row){
    const r=row.querySelector('.vol'); if(+r.value!==pct) r.value=pct;
    const n=row.querySelector('.volNum'); if(+n.value!==pct) n.value=pct;
  }
  scheduleSave();
}
function buildPresetRow(p){
  const row=document.createElement('div');
  row.className='preset-row'+(p.active?' active':'')+(p.id===state.focusId?' focus':'');
  row.dataset.id=p.id;

  const btn=document.createElement('button');
  btn.type='button'; btn.className='preset-toggle';
  btn.innerHTML='<span class="pi">'+p.icon+'</span>'+p.label;
  btn.addEventListener('click',()=>togglePreset(p.id));
  row.appendChild(btn);

  const vol=document.createElement('div');
  vol.className='preset-vol';
  const r=document.createElement('input');
  r.type='range'; r.className='vol'; r.min=0; r.max=100; r.value=Math.round(p.vol*100);
  r.title='拖动调节音量，鼠标滚轮也可微调';
  const num=document.createElement('input');
  num.type='number'; num.className='volNum'; num.min=0; num.max=100; num.value=Math.round(p.vol*100);
  num.title='精确输入音量（0-100）';
  r.disabled=!p.active; num.disabled=!p.active;   /* 未使能时不可编辑 */
  const unit=document.createElement('span');
  unit.className='volUnit'; unit.textContent='%';
  r.addEventListener('input',()=>applyVol(p,+r.value));
  num.addEventListener('input',()=>{ const v=parseInt(num.value,10); if(!isNaN(v)) applyVol(p,v); });
  num.addEventListener('change',()=>{ const v=parseInt(num.value,10); applyVol(p,isNaN(v)?0:v); });
  r.addEventListener('wheel',e=>{
    e.preventDefault();
    const step=e.shiftKey?5:1;
    applyVol(p,(parseInt(r.value,10)||0)+(e.deltaY<0?step:-step));
  },{passive:false});
  num.addEventListener('wheel',e=>{
    e.preventDefault();
    const step=e.shiftKey?5:1;
    applyVol(p,(parseInt(num.value,10)||0)+(e.deltaY<0?step:-step));
  },{passive:false});
  vol.appendChild(r); vol.appendChild(num); vol.appendChild(unit);
  row.appendChild(vol);

  if(p.type==='custom'){
    const del=document.createElement('button');
    del.type='button'; del.className='mini preset-del'; del.textContent='删除';
    del.addEventListener('click',()=>deleteCustomPreset(p.id));
    row.appendChild(del);
  }
  /* 未使能时：点击行的任意位置（含禁用的音量控件区域）都使能该预设 */
  row.addEventListener('click',e=>{
    if(p.active) return;                                  /* 使能后交给各控件正常处理 */
    if(e.target.closest('.preset-toggle')) return;         /* 名称按钮自身处理 */
    if(e.target.closest('.mini')) return;                  /* 删除按钮 */
    togglePreset(p.id);
  });
  return row;
}
function renderPresets(){
  const box=$('#presetList');
  box.innerHTML='';
  for(const cat of ['基础噪声','自然声音','环境声音','自定义']){
    const h=document.createElement('div');
    h.className='preset-cat'; h.textContent=cat;
    box.appendChild(h);
    for(const p of state.presets){
      if(p.cat!==cat) continue;
      box.appendChild(buildPresetRow(p));
    }
    if(cat==='自定义'){
      const add=document.createElement('button');
      add.type='button'; add.className='preset-add'; add.textContent='➕ 添加自定义预设';
      add.addEventListener('click',()=>addCustomPreset());
      box.appendChild(add);
    }
  }
}
function syncPresets(){
  for(const p of state.presets){
    const row=presetRowEl(p.id);
    if(!row) continue;
    row.classList.toggle('active',!!p.active);
    row.classList.toggle('focus',p.id===state.focusId);
    const pct=Math.round(p.vol*100);
    const r=row.querySelector('.vol'); if(+r.value!==pct) r.value=pct;
    const n=row.querySelector('.volNum'); if(+n.value!==pct) n.value=pct;
    r.disabled=!p.active; n.disabled=!p.active;
  }
}
function updateAll(){
  syncPresets();
  const p=renderParams();
  $('#loopInfo').textContent='实际循环 '+(p.T<60?p.T.toFixed(0)+' 秒':(p.T/60).toFixed(1)+' 分钟')+' · 频率分辨率 '+(p.rate/p.N).toFixed(3)+' Hz';
  $('#playBtn').textContent=(state.mode==='rt')?'⏸ 试听中':'▶ 实时试听';
  $('#sleepBtn').textContent=(state.mode==='sleep')?'🛏 睡眠模式运行':'🌙 进入睡眠模式';
  updatePsdUI();
  updateChips();
  renderStatus();
  if(!state.startedAt) $('#cTime').textContent='0:00';
}
function updateChips(){
  const e=$('#cEngine');
  if(state.mode==='idle'){ e.textContent='空闲'; e.className='off'; }
  else if(state.mode==='rt'){ e.textContent='实时（音频线程）'; e.className='ok'; }
  else if(!usingFallback){ e.textContent='Web Audio 无缝循环'; e.className='ok'; }
  else { e.textContent='原生循环（回退，有缝隙）'; e.className='warn'; }
  const w=$('#cWake');
  if(!('wakeLock' in navigator)){ w.textContent='浏览器不支持'; w.className='off'; }
  else if(wakeLock&&!wakeLock.released){ w.textContent='已持有'; w.className='ok'; }
  else if(state.mode!=='idle'){ w.textContent='未持有'; w.className='warn'; }
  else { w.textContent='—'; w.className='off'; }
  const v=$('#cVis');
  v.textContent=document.hidden?'后台/锁屏':'可见';
  v.className=document.hidden?'warn':'ok';
  const m=$('#cMedia');
  if(state.mode==='sleep'&&('mediaSession' in navigator)){ m.textContent='锁屏可控'; m.className='ok'; }
  else if('mediaSession' in navigator){ m.textContent='待机'; m.className='off'; }
  else { m.textContent='不支持'; m.className='off'; }
}

/* ================================================================
 * 事件绑定
 * ================================================================ */
$('#playBtn').addEventListener('click',()=>{
  if(state.mode==='rt'){ stopAll(); return; }
  startRT();
});
$('#sleepBtn').addEventListener('click',()=>{
  if(state.mode==='sleep'){ stopAll(); toast('睡眠模式已停止'); return; }
  startSleep(false);
});
$('#masterVol').addEventListener('input',e=>{
  state.masterVol=+e.target.value/100;
  $('#masterVolVal').textContent=e.target.value;
  if(state.mode==='rt'&&masterGain) masterGain.gain.value=state.masterVol*.4;
  if(state.mode==='sleep'){
    if(usingFallback){ try{ player.volume=state.masterVol; }catch(err){} }
    else if(sleepGain){ sleepGain.gain.value=state.masterVol; }
  }
  scheduleSave();
});
$('#rateSel').addEventListener('change',e=>{
  state.rate=+e.target.value;
  layerCache.clear();
  state.sleepDirty=true;
  drawPsd(); updateAll();
  if(state.mode==='rt') startRT();
  else if(state.mode==='sleep') toast('睡眠模式播放中：采样率将在下次启动时生效',2600,'warn');
  scheduleSave();
});
$('#loopSel').addEventListener('change',e=>{
  state.loopSec=+e.target.value;
  layerCache.clear();
  state.sleepDirty=true;
  updateAll();
  if(state.mode==='rt') startRT();
  else if(state.mode==='sleep') toast('睡眠模式播放中：循环长度将在下次启动时生效',2600,'warn');
  scheduleSave();
});
$('#timerSel').addEventListener('change',e=>{
  const v=e.target.value;
  if(v==='off'){ state.timerEnd=0; toast('睡眠定时已关闭，将整夜播放'); }
  else{
    state.timerEnd=Date.now()+(+v)*60000;
    toast('已设置 '+(+v>=60?((+v)/60)+' 小时':v+' 分钟')+'后停止');
  }
  scheduleSave();
});
$('#dlBtn').addEventListener('click',async()=>{
  if(!activePresets().length){ setError('没有可导出的混音，请先选择噪声'); return; }
  if(state.sleepDirty||!sleepBlob){
    setStatus('正在合成导出文件 …');
    await sleep20();
    await prerenderSleep();
  }
  if(!sleepBlob){ setError('导出失败'); return; }
  const a=document.createElement('a');
  a.href=URL.createObjectURL(sleepBlob);
  a.download='limitless-噪声混音.wav';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },3000);
  setStatus('');
});
$('#nightBtn').addEventListener('click',()=>{
  document.documentElement.classList.toggle('night');
  const on=document.documentElement.classList.contains('night');
  $('#nightBtn').textContent=on?'☀ 日间':'🌙 夜间';
  drawPsd();
  scheduleSave();
});
document.addEventListener('visibilitychange',()=>{
  updateChips();
  if(document.visibilityState==='hidden'){
    autoSwitchToSleep();
    stopPsdLoop();                 /* 切到后台才停刷新以省电 */
  }else{
    if(state.mode!=='idle') requestWakeLock();
    startPsdLoop();                /* 只要页面可见就持续刷新，与播放状态解耦 */
  }
});
player.addEventListener('play',updateChips);
player.addEventListener('pause',updateChips);

/* ================================================================
 * 卡片折叠：点击标题栏收起/展开；小屏幕默认收起次要卡片以节省空间
 * ================================================================ */
function setupCollapsible(){
  $$('.card').forEach((card,i)=>{
    const head=card.querySelector(':scope > h2');
    if(!head) return;
    head.classList.add('card-head');
    const chev=document.createElement('span');
    chev.className='chev'; chev.textContent='▾'; chev.setAttribute('aria-hidden','true');
    head.appendChild(chev);
    const body=document.createElement('div');
    body.className='card-body';
    let node=head.nextSibling;
    while(node){ const next=node.nextSibling; body.appendChild(node); node=next; }
    card.appendChild(body);
    head.setAttribute('role','button');
    head.setAttribute('tabindex','0');
    /* 折叠时把操作按钮移到标题栏，保证折叠后仍可操作 */
    const controls=body.querySelector('.controls');
    if(controls){
      controls.addEventListener('click',e=>e.stopPropagation());
      controls.addEventListener('keydown',e=>e.stopPropagation());
    }
    const setCollapsed=on=>{
      card.classList.toggle('collapsed',on);
      head.setAttribute('aria-expanded',on?'false':'true');
      if(controls){
        if(on) head.insertBefore(controls,chev);
        else body.insertBefore(controls,body.firstChild);
      }
      if(!on&&card.querySelector('#psd')) drawPsd();
      scheduleSave();
    };
    const toggle=()=>setCollapsed(!card.classList.contains('collapsed'));
    head.addEventListener('click',toggle);
    head.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); }
    });
    const savedFold=(persisted&&Array.isArray(persisted.fold))?persisted.fold[i]:undefined;
    if(typeof savedFold==='number') setCollapsed(!!savedFold);
    else setCollapsed(window.matchMedia('(max-width:600px)').matches&&i>0);
  });
}

/* ================================================================
 * 初始化
 * ================================================================ */
initPresets();
persisted=loadSettings();
if(persisted) applySettings(persisted);
else{
  try{
    if(localStorage.getItem('noise-night')==='1'){
      document.documentElement.classList.add('night');
      $('#nightBtn').textContent='☀ 日间';
    }
  }catch(e){}
}
renderPresets();
updateAll();
drawPsd();
setupCollapsible();
if(persisted&&Array.isArray(persisted.det)) $$('details').forEach((d,i)=>{ if(typeof persisted.det[i]==='number') d.open=!!persisted.det[i]; });
$$('details').forEach(d=>d.addEventListener('toggle',scheduleSave));
scheduleSave();
