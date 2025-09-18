// ==UserScript==
// @name         Vendetta MX Rank Scanner
// @namespace    mx.tools
// @version      1.3.0
// @description  Compare rankings to any saved snapshot (history). Deltas for Training/Buildings/Troops/Total/#Buildings/Rank, name changes. Robust detection + debounced observer. Snapshot picker in the top bar.
// @author       mx
// @match        *://vendettagame.es/public/mob/clasificacion*
// @match        *://www.vendettagame.es/public/mob/clasificacion*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @downloadURL  https://raw.githubusercontent.com/dani-csg/Vendetta-MX-Rank-Scanner/main/rank-scanner.user.js
// @updateURL    https://raw.githubusercontent.com/dani-csg/Vendetta-MX-Rank-Scanner/main/rank-scanner.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- utils ---------- */
  const $  = (s, r=document)=>r.querySelector(s);
  const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

  const hostKey = location.host.replace(/^www\./,'');
  const K_ALL   = `mx_rank_snapshots__${hostKey}`;     // [{id, ts, players:{id:{name,rank,...}}}]
  const K_BASE  = `mx_rank_baseline_id__${hostKey}`;
  const MAX_SNAPSHOTS = 50;

  const GM_Get=(k,d)=>{try{return GM_getValue(k,d);}catch{return d;}};
  const GM_Set=(k,v)=>{try{GM_setValue(k,v);}catch{}};
  const GM_Del=(k)=>{try{GM_deleteValue(k);}catch{}};

  const toInt = t=>{
    if (!t) return 0;
    const clean = String(t).replace(/\[[^\]]*]/g,'').replace(/[^\d-]+/g,'');
    const n = parseInt(clean,10);
    return Number.isFinite(n) ? n : 0;
  };
  const sign = n => n>0?`+${n}`:`${n}`;
  const fmt  = ts=>new Date(ts).toLocaleString();

  const loadAll = ()=>{ const a=GM_Get(K_ALL, []); return Array.isArray(a)?a:[]; };
  const saveAll = a=>GM_Set(K_ALL, a);
  const getBaselineId = ()=>GM_Get(K_BASE, null);
  const setBaselineId = id=>GM_Set(K_BASE, id);
  const getSnapshotById = id => id ? loadAll().find(s=>String(s.id)===String(id))||null : null;

  /* ---------- CSS ---------- */
  (function addCss(){
    if ($('#mx-rank-css')) return;
    const st=document.createElement('style'); st.id='mx-rank-css';
    st.textContent=`
      #mx-rank-bar{
        position:sticky; top:0; z-index:9999; background:#111; color:#eee;
        padding:.35rem .6rem; border-bottom:1px solid #333; font:13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      }
      #mx-rank-bar .mx-wrap{ display:flex; gap:.5rem; align-items:center; flex-wrap:wrap }
      #mx-rank-bar button, #mx-rank-bar select{
        padding:.28rem .55rem; border:1px solid #666; background:#1d1d1d; color:#eee; border-radius:6px; font-size:12px; cursor:pointer;
      }
      #mx-rank-bar button:hover{ filter:brightness(1.1) }
      #mx-rank-bar .mx-meta{ opacity:.8; margin-left:.25rem }

      .mx-diff{ display:block; font-size:11px; margin-top:2px; opacity:.95 }
      th.mx-pos, td.mx-pos{ background:rgba(46,160,67,.18)!important }
      th.mx-zero, td.mx-zero{ background:rgba(255,167,38,.18)!important }
      th.mx-neg, td.mx-neg{ background:rgba(244,67,54,.18)!important }

      .mx-pos .mx-diff{ color:#2ea043 }
      .mx-zero .mx-diff{ color:#ff9800 }
      .mx-neg .mx-diff{ color:#f44336 }

      th.mx-rank-pos, td.mx-rank-pos{ background:rgba(46,160,67,.18)!important }
      th.mx-rank-zero, td.mx-rank-zero{ background:rgba(255,167,38,.18)!important }
      th.mx-rank-neg, td.mx-rank-neg{ background:rgba(244,67,54,.18)!important }

      .mx-rank-pos .mx-diff{ color:#2ea043 }
      .mx-rank-zero .mx-diff{ color:#ff9800 }
      .mx-rank-neg .mx-diff{ color:#f44336 }

      .mx-aka{ display:block; font-size:11px; color:#bbb; margin-top:2px }
      .mx-hide-diffs .mx-diff, .mx-hide-diffs .mx-aka{ display:none!important }
    `;
    document.head.appendChild(st);
  })();

  /* ---------- Top bar with snapshot picker ---------- */
  function ensureTopBar(){
    let bar = $('#mx-rank-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'mx-rank-bar';
    bar.innerHTML = `
      <div class="mx-wrap">
        <strong>Rank Scanner</strong>
        <button id="mx-save">Save Snapshot</button>
        <select id="mx-sel"></select>
        <button id="mx-apply">Apply</button>
        <button id="mx-del">Delete</button>
        <button id="mx-toggle">Toggle Diffs</button>
        <button id="mx-clear">Clear All</button>
        <span class="mx-meta" id="mx-meta"></span>
      </div>
    `;
    document.body.prepend(bar);

    // actions
    $('#mx-save').addEventListener('click', onSaveSnapshot);
    $('#mx-apply').addEventListener('click', ()=>{
      const id = $('#mx-sel').value; if (!id) return;
      setBaselineId(id);
      annotateAgainstBaseline();
      updateTopMeta();
    });
    $('#mx-del').addEventListener('click', ()=>{
      const id = $('#mx-sel').value; if (!id) return;
      const all = loadAll().filter(s=>String(s.id)!==String(id));
      saveAll(all);
      if (String(getBaselineId())===String(id)) setBaselineId(all[0]?.id || null);
      refreshTopSnapshotControls();
      annotateAgainstBaseline();
      updateTopMeta();
    });
    $('#mx-toggle').addEventListener('click', ()=>document.documentElement.classList.toggle('mx-hide-diffs'));
    $('#mx-clear').addEventListener('click', ()=>{
      if (!confirm('Delete ALL snapshots? This cannot be undone.')) return;
      GM_Del(K_ALL); GM_Del(K_BASE);
      cleanupDiffs();
      refreshTopSnapshotControls();
      updateTopMeta();
      alert('All snapshots cleared.');
    });

    refreshTopSnapshotControls();
    updateTopMeta();
    return bar;
  }

  function refreshTopSnapshotControls(){
    const sel = $('#mx-sel'); if (!sel) return;
    const all = loadAll().slice().sort((a,b)=>b.id-a.id); // newest first
    const baseId = getBaselineId();
    sel.innerHTML = '';
    for (const s of all){
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = fmt(s.ts || s.id);
      if (String(baseId)===String(s.id)) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!all.length){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No snapshots yet';
      sel.appendChild(opt);
    }
  }

  function updateTopMeta(){
    const all = loadAll();
    const base = getSnapshotById(getBaselineId());
    const info = base ? `Baseline: ${fmt(base.ts)} — Snapshots: ${all.length}`
                      : (all.length ? `Snapshots: ${all.length} — pick one` : 'No snapshots yet — click "Save Snapshot"');
    $('#mx-meta').textContent = info;
  }

  /* ---------- Table detection ---------- */
  function scoreHeaderTexts(arr){
    const t = arr.join(' ');
    let s=0;
    if (/(^|\s)(#|rank)\b/.test(t)) s+=3;
    if (/\b(name|nombre)\b/.test(t)) s+=3;
    if (/\b(points?|puntos?)\b/.test(t)) s+=2;
    if (/\b(train|entren)/.test(t)) s+=1;
    if (/\b(build|edific)/.test(t)) s+=1;
    if (/\b(troop|tropa)/.test(t)) s+=1;
    if (/\b(total|suma)/.test(t)) s+=1;
    return s;
  }
  function findRankingTable(){
    const candidates = $$('#content table');
    if (!candidates.length) return null;
    let best=null, bestScore=-1;
    for (const t of candidates){
      const row=t.rows[0]; if (!row) continue;
      const head = [...row.cells].map(c=>c.textContent.trim().toLowerCase());
      let sc = scoreHeaderTexts(head);
      if (row.cells.length>=7) sc+=1;
      if (sc>bestScore){ bestScore=sc; best=t; }
    }
    if (best && bestScore>=3) return best;
    candidates.sort((a,b)=>b.rows.length-a.rows.length);
    return candidates[0] || null;
  }

  /* ---------- Extract rows ---------- */
  function extractPlayers(table){
    if (!table || !table.rows || table.rows.length<2) return [];
    const rows = [...table.rows].slice(1);
    const out=[];
    for (const tr of rows){
      const cells = [...tr.cells];
      if (cells.length<7) continue;

      const rankCell      = cells[0];
      const nameCell      = cells[1];
      const trainingCell  = cells[2];
      const buildingsCell = cells[3];
      const troopsCell    = cells[4];
      const totalCell     = cells[5];
      const bcountCell    = cells[6];

      const rank = toInt(rankCell.textContent);
      const link = nameCell.querySelector('a');
      const name = (link?link.textContent:nameCell.textContent||'').trim();

      let id=null;
      const href = link?.getAttribute('href') || '';
      const m = href.match(/jugador\?id=(\d+)/); if (m) id=m[1];
      if (!id) id='name:'+name;

      out.push({
        id, name, row:tr,
        cells:{rank:rankCell,name:nameCell,training:trainingCell,buildings:buildingsCell,troops:troopsCell,total:totalCell,buildingsCount:bcountCell},
        values:{
          rank,
          training: toInt(trainingCell.textContent),
          buildings: toInt(buildingsCell.textContent),
          troops: toInt(troopsCell.textContent),
          total: toInt(totalCell.textContent),
          buildingsCount: toInt(bcountCell.textContent)
        }
      });
    }
    return out;
  }

  /* ---------- Snapshot creation ---------- */
  function currentSnapshotFromDom(){
    const table = findRankingTable();
    if (!table) return null;
    const players = extractPlayers(table);
    if (!players.length) return null;
    const map = {};
    for (const p of players){
      map[p.id] = { name:p.name, ...p.values };
    }
    const ts = Date.now();
    return { id: ts, ts, players: map };
  }

  function onSaveSnapshot(){
    const snap = currentSnapshotFromDom();
    if (!snap){ alert('Snapshot failed: table not found or empty.'); return; }
    const all = loadAll();
    all.push(snap);
    all.sort((a,b)=>a.id-b.id);
    while (all.length>MAX_SNAPSHOTS) all.shift();
    saveAll(all);
    setBaselineId(snap.id);
    refreshTopSnapshotControls();
    updateTopMeta();
    annotateAgainstBaseline();
    alert('Snapshot saved: ' + fmt(snap.ts));
  }

  /* ---------- Diffs ---------- */
  function cleanupDiffs(){
    $$('.mx-diff,.mx-aka').forEach(n=>n.remove());
    const cls=['mx-pos','mx-zero','mx-neg','mx-rank-pos','mx-rank-zero','mx-rank-neg'];
    $$('th,td').forEach(td=>cls.forEach(c=>td.classList.remove(c)));
  }

  function annotate(players, baseline){
    for (const p of players){
      const prev = baseline?.players?.[p.id];

      if (prev && prev.name && prev.name!==p.name){
        const aka=document.createElement('span');
        aka.className='mx-aka';
        aka.textContent='aka: '+prev.name;
        p.cells.name.appendChild(aka);
      }

      const metrics=[ ['rank',true], ['training',false], ['buildings',false], ['troops',false], ['total',false], ['buildingsCount',false] ];
      for (const [key,isRank] of metrics){
        const td=p.cells[key]; if(!td) continue;
        td.querySelectorAll('.mx-diff').forEach(n=>n.remove());
        if (!prev) continue;

        const cur=p.values[key]??0, old=prev[key]??0, diff=cur-old;

        const span=document.createElement('span');
        span.className='mx-diff';
        span.textContent='['+sign(diff)+']';
        td.appendChild(span);

        if (isRank){
          if (diff<0) td.classList.add('mx-rank-pos');
          else if (diff===0) td.classList.add('mx-rank-zero');
          else td.classList.add('mx-rank-neg');
        } else {
          if (diff>0) td.classList.add('mx-pos');
          else if (diff===0) td.classList.add('mx-zero');
          else td.classList.add('mx-neg');
        }
      }
    }
  }

  /* ---------- Stable run ---------- */
  let isUpdating=false, lastSig='';

  const tableSignature = tbl=>{
    if (!tbl) return '';
    const rows = tbl.rows.length;
    const len  = Math.min((tbl.innerText||'').length, 20000);
    return rows+':'+len;
  };

  function annotateAgainstBaseline(){
    if (isUpdating) return;
    const table = findRankingTable();
    const bar = ensureTopBar();

    if (!table){ updateTopMeta(); return; }

    const players = extractPlayers(table);
    if (!players.length){ updateTopMeta(); return; }

    let base = getSnapshotById(getBaselineId());
    if (!base){
      const all=loadAll(); if (all.length) base=all[all.length-1];
    }

    isUpdating=true;
    try{
      cleanupDiffs();
      if (base) annotate(players, base);
      lastSig = tableSignature(table);
    } finally {
      setTimeout(()=>{ isUpdating=false; }, 50);
    }
    updateTopMeta();
  }

  function run(){
    ensureTopBar();          // always visible
    const table = findRankingTable();
    if (!table){ updateTopMeta(); return; }
    annotateAgainstBaseline();
  }

  // initial
  run();

  // observe #content (debounced)
  const content = $('#content') || document.body;
  let pending = null;
  const obs = new MutationObserver(()=>{
    if (pending) return;
    pending = setTimeout(()=>{ pending=null; run(); }, 120);
  });
  obs.observe(content, {childList:true, subtree:true});

})();
