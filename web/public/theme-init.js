// Theme and sky before first paint, so the page never flashes the wrong one (web/src/themeChoice.ts, web/src/daylight.ts).
// A file, not an inline script: the content security policy allows only the app's own scripts. Mirrors daylight.ts phaseAt.
try{var r=document.documentElement,t=localStorage.getItem("onething.theme"),d=new Date(),b={wake:390,bed:1350};try{var c=JSON.parse(localStorage.getItem("onething.day"));if(c&&c.bed>c.wake)b=c}catch(e){}
var m=d.getHours()*60+d.getMinutes(),f=(m-b.wake)/(b.bed-b.wake),ph=m<b.wake||m>=b.bed-60?"night":f<0.3?"morning":f<0.72?"day":"dusk";
r.dataset.sky=ph;if(t==="light"||t==="dark")r.dataset.theme=t;else r.dataset.day=ph==="dusk"||ph==="night"?"dark":"light"}catch(e){}
