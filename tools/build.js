const fs=require('fs');
const t=fs.readFileSync(__dirname + '/../src/template.html','utf8'), e=fs.readFileSync(__dirname + '/../src/engine.js','utf8');
const out=t.replace('/*ENGINE*/', ()=>e);
fs.writeFileSync(__dirname + '/../grazing-control-sim.html', out); fs.writeFileSync(__dirname + '/../index.html', out);
const bad=[0x2013,0x2014,0x2018,0x2019,0x201C,0x201D,0x2026,0x2022,0x2192,0x2212,0x00A7,0x25CB,0x25CF];
const hits=[...out].map((c,i)=>[c.codePointAt(0),i]).filter(x=>bad.includes(x[0]));
console.log('bytes',out.length,'forbidden',hits.length);
// list any non-ASCII for review
const na={}; for (const c of out){const cp=c.codePointAt(0); if(cp>127) na[c]=(na[c]||0)+1;} console.log(JSON.stringify(na));
// JS syntax check of the inline scripts
const scripts=[...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i)=>{ try{ new Function(s); console.log('script',i,'syntax ok'); }catch(err){ console.log('script',i,'SYNTAX ERROR',err.message); } });
