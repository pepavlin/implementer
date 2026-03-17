import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type express from "express";
import yaml from "js-yaml";
import {
    TaskManager,
    TaskActiveError
} from "./task-manager/task-manager.js";
import { extractLastAssistantMessage } from "./executor.js";
import type { Config } from "./config/config.js";
import { ConfigSchema } from "./config/config-types.js";
import type { ProjectId, TaskId } from "./types.js";
import { fetchSubscriptionUsage } from "./subscription-api.js";

// ── Auth helpers ─────────────────────────────────────────────────────────────

export function parseCookies(
    header: string | undefined
): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim();
        if (key) out[key] = part.slice(idx + 1).trim();
    }
    return out;
}

export function dashboardToken(password: string): string {
    return createHash("sha256").update(`impl:${password}`).digest("hex");
}

export function isDashboardAuthenticated(
    req: express.Request,
    adminPassword: string
): boolean {
    const cookies = parseCookies(req.headers.cookie);
    return cookies["impl_dash"] === dashboardToken(adminPassword);
}

// ── Data helpers ─────────────────────────────────────────────────────────────

export function buildDashboardData(
    taskManager: TaskManager,
    config: Config
): {
    tasks: object[];
    stats: Record<string, number | boolean>;
    projects: Record<string, Record<string, number>>;
    paused: boolean;
} {
    const allTasks = taskManager.listAllTasks();
    // Sort: active tasks first by status priority, then by newest createdAt within each group
    // Status priority: running (0) > starting (1) > queued (2) > retrying (3) > waiting_for_pipeline (4) > rest (5)
    const statusPriority: Record<string, number> = {
        running: 0,
        starting: 1,
        queued: 2,
        retrying: 3,
        waiting_for_pipeline: 4
    };
    const getStatusPriority = (status: string): number =>
        statusPriority[status] ?? 5;
    const sortedTasks = allTasks.slice().sort((a, b) => {
        const aPriority = getStatusPriority(a.data.status);
        const bPriority = getStatusPriority(b.data.status);
        if (aPriority !== bPriority) return aPriority - bPriority;
        return (
            new Date(b.data.createdAt).getTime() -
            new Date(a.data.createdAt).getTime()
        );
    });
    const tasks = sortedTasks.slice(0, 200).map((task) => ({
        taskId: task.id,
        projectId: task.data.projectId,
        title: task.title ?? null,
        prompt: task.data.prompt,
        status: task.data.status,
        chainId: task.data.chainId,
        parentTaskId: task.data.parentTaskId ?? null,
        createdAt: task.data.createdAt,
        startedAt: task.data.startedAt ?? null,
        completedAt: task.data.completedAt,
        durationSeconds:
            task.data.status === "queued"
                ? null
                : Math.round(
                      ((task.data.completedAt
                          ? new Date(task.data.completedAt).getTime()
                          : Date.now()) -
                          new Date(
                              task.data.startedAt ?? task.data.createdAt
                          ).getTime()) /
                          1000
                  ),
        estimatedDurationSeconds: task.data.estimatedDurationSeconds ?? null,
        // Include minimal PR info for table-level indicators
        pullRequests:
            task.data.pullRequests?.map((pr) => ({
                repo: pr.repo,
                url: pr.url,
                state: pr.state ?? null
            })) ?? null,
        readAt: task.data.readAt ?? null,
        priority: task.data.priority ?? "normal",
        repoUrl: task.data.repoUrl ?? null
    }));

    // Count unique PRs by URL and state (deduplicate across tasks sharing the same PR)
    const openPrUrls = new Set<string>();
    const draftPrUrls = new Set<string>();
    for (const task of allTasks) {
        for (const pr of task.data.pullRequests ?? []) {
            if (pr.url) {
                if (pr.state === "open") openPrUrls.add(pr.url);
                else if (pr.state === "draft") draftPrUrls.add(pr.url);
            }
        }
    }
    const openPrCount = openPrUrls.size;
    const draftPrCount = draftPrUrls.size;

    const stats = {
        running: allTasks.filter((t) => t.data.status === "running").length,
        starting: allTasks.filter((t) => t.data.status === "starting").length,
        queued: allTasks.filter((t) => t.data.status === "queued").length,
        retrying: allTasks.filter((t) => t.data.status === "retrying").length,
        waiting_for_pipeline: allTasks.filter(
            (t) => t.data.status === "waiting_for_pipeline"
        ).length,
        completed: allTasks.filter((t) => t.data.status === "completed").length,
        failed: allTasks.filter((t) => t.data.status === "failed").length,
        interrupted: allTasks.filter(
            (t) => t.data.status === "interrupted"
        ).length,
        cancelled: allTasks.filter((t) => t.data.status === "cancelled").length,
        total: allTasks.length,
        openPrs: openPrCount,
        draftPrs: draftPrCount
    };

    const projects: Record<string, Record<string, number>> = {};
    for (const projectId of Object.keys(config.projects)) {
        projects[projectId] = {
            running: 0,
            starting: 0,
            queued: 0,
            retrying: 0,
            waiting_for_pipeline: 0,
            completed: 0,
            failed: 0,
            interrupted: 0,
            cancelled: 0
        };
    }
    for (const task of allTasks) {
        const pid = task.data.projectId as string;
        if (!projects[pid]) {
            projects[pid] = {
                running: 0,
                starting: 0,
                queued: 0,
                retrying: 0,
                waiting_for_pipeline: 0,
                completed: 0,
                failed: 0,
                interrupted: 0,
                cancelled: 0
            };
        }
        const s = task.data.status as string;
        if (s in projects[pid]) {
            projects[pid][s]++;
        }
    }

    return { tasks, stats, projects, paused: taskManager.isPaused() };
}

// ── HTML templates ────────────────────────────────────────────────────────────

const THEME_FOUC_SCRIPT = `<script>try{if(localStorage.getItem('impl-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}</script>`;

const THEME_TOGGLE_JS = `
    function toggleTheme(){
      var html=document.documentElement,isLight=html.getAttribute('data-theme')==='light';
      if(isLight){html.removeAttribute('data-theme');try{localStorage.removeItem('impl-theme')}catch(e){}}
      else{html.setAttribute('data-theme','light');try{localStorage.setItem('impl-theme','light')}catch(e){}}
      updateThemeBtn();
    }
    function updateThemeBtn(){
      var btn=document.getElementById('theme-toggle'),isLight=document.documentElement.getAttribute('data-theme')==='light';
      if(btn)btn.textContent=isLight?'\u263E':'\u2600';
    }
    updateThemeBtn();`;

const VOICE_MODE_JS = `
    function toggleVoiceMode(){
      voiceMode=!voiceMode;
      var btn=document.getElementById('voice-btn');
      var panel=document.getElementById('voice-panel');
      if(voiceMode){
        if(selectionMode)exitSelectionMode();
        btn.classList.add('voice-btn-active');
        panel.style.display='';
        updateVoicePanel();
      }else{
        stopVoiceRecognition();
        voiceTarget=null;
        voiceTranscript='';
        voiceSubmittedLog=[];
        btn.classList.remove('voice-btn-active');
        panel.style.display='none';
      }
      updateProjHint();
      if(lastData)renderProjects(lastData.projects);
    }
    function voiceSelectProject(id){
      if(voiceTarget===id){
        stopVoiceRecognition();
        voiceTarget=null;
        voiceTranscript='';
        updateVoicePanel();
        updateProjHint();
        if(lastData)renderProjects(lastData.projects);
        return;
      }
      voiceTarget=id;
      voiceTranscript='';
      updateVoicePanel();
      updateProjHint();
      if(lastData)renderProjects(lastData.projects);
      startVoiceRecognition();
    }
    function startVoiceRecognition(){
      stopVoiceRecognition();
      var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!SR){alert('Speech recognition is not supported in this browser. Please use Chrome.');return;}
      voiceRecognition=new SR();
      voiceRecognition.continuous=true;
      voiceRecognition.interimResults=true;
      voiceRecognition.lang=voiceLang;
      voiceRecognition.onresult=function(event){
        var transcript='';
        for(var i=0;i<event.results.length;i++){
          transcript+=event.results[i][0].transcript;
        }
        voiceTranscript=transcript;
        var el=document.getElementById('voice-transcript-text');
        if(el)el.textContent=transcript;
        updateVoicePanel();
        if(transcript.trim())resetSilenceTimer();
      };
      voiceRecognition.onerror=function(event){
        if(event.error==='no-speech'||event.error==='aborted')return;
        console.warn('Speech recognition error:',event.error);
      };
      voiceRecognition.onend=function(){
        if(voiceMode&&voiceTarget){
          try{voiceRecognition.start();}catch(e){}
        }
      };
      try{voiceRecognition.start();}catch(e){console.warn('Failed to start speech recognition:',e);}
    }
    function stopVoiceRecognition(){
      clearSilenceTimer();
      if(voiceRecognition){try{voiceRecognition.abort();}catch(e){}voiceRecognition=null;}
    }
    function startSilenceTimer(){
      clearSilenceTimer();
      voiceSilenceStart=Date.now();
      var duration=4000;
      var fill=document.getElementById('voice-silence-fill');
      voiceSilenceTimer=setInterval(function(){
        var elapsed=Date.now()-voiceSilenceStart;
        var pct=Math.min(100,Math.round((elapsed/duration)*100));
        if(fill)fill.style.width=pct+'%';
        if(elapsed>=duration){
          clearSilenceTimer();
          voiceAutoSubmit();
        }
      },100);
    }
    function resetSilenceTimer(){
      if(voiceTranscript.trim())startSilenceTimer();
    }
    function clearSilenceTimer(){
      if(voiceSilenceTimer){clearInterval(voiceSilenceTimer);voiceSilenceTimer=null;}
      var fill=document.getElementById('voice-silence-fill');
      if(fill)fill.style.width='0%';
    }
    function voiceAutoSubmit(){
      var transcript=voiceTranscript.trim();
      if(!transcript){return;}
      if(!voiceTarget){showVoiceWarning('Select a project first');return;}
      stopVoiceRecognition();
      var projectId=voiceTarget;
      var body={projectId:projectId,prompt:transcript};
      fetch('/dashboard/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.error){showVoiceWarning('Error: '+d.error);return;}
          voiceSubmittedLog.unshift({project:projectId,prompt:transcript,taskId:d.taskId,time:new Date().toLocaleTimeString()});
          renderVoiceSubmitted();
          showVoiceFlash('\\u2713 Submitted to '+projectId);
          voiceTranscript='';
          voiceTarget=null;
          updateVoicePanel();
          updateProjHint();
          if(lastData)renderProjects(lastData.projects);
        })
        .catch(function(e){showVoiceWarning('Failed to submit task: '+e.message);});
    }
    function voiceCancel(){
      stopVoiceRecognition();
      voiceTranscript='';
      voiceTarget=null;
      updateVoicePanel();
      updateProjHint();
      if(lastData)renderProjects(lastData.projects);
    }
    function voiceSendNow(){
      if(!voiceTranscript.trim()){return;}
      clearSilenceTimer();
      voiceAutoSubmit();
    }
    function toggleVoiceLang(){
      voiceLang=voiceLang==='cs-CZ'?'en-US':'cs-CZ';
      var btn=document.getElementById('voice-lang-btn');
      if(btn)btn.textContent=voiceLang;
      if(voiceRecognition&&voiceTarget){
        startVoiceRecognition();
      }
    }
    function updateVoicePanel(){
      var statusEl=document.getElementById('voice-status-text');
      var transcriptArea=document.getElementById('voice-transcript-area');
      var cancelBtn=document.getElementById('voice-cancel-btn');
      var sendBtn=document.getElementById('voice-send-btn');
      var transcriptText=document.getElementById('voice-transcript-text');
      if(voiceTarget){
        statusEl.textContent='\\uD83C\\uDFA4 Listening \\u2014 '+voiceTarget;
        transcriptArea.style.display='';
        cancelBtn.style.display='';
        if(transcriptText)transcriptText.textContent=voiceTranscript||'Listening\\u2026';
        if(sendBtn)sendBtn.style.display=voiceTranscript.trim()?'':'none';
      }else{
        statusEl.textContent='\\uD83C\\uDFA4 Voice Mode \\u2014 Select a project to begin';
        transcriptArea.style.display='none';
        cancelBtn.style.display='none';
        if(sendBtn)sendBtn.style.display='none';
      }
      hideVoiceWarning();
    }
    function renderVoiceSubmitted(){
      var el=document.getElementById('voice-submitted');
      if(!el||!voiceSubmittedLog.length){if(el)el.innerHTML='';return;}
      el.innerHTML=voiceSubmittedLog.slice(0,5).map(function(item){
        return '<div class="voice-submitted-item">\\u2713 '+esc(item.time)+' \\u2014 <strong>'+esc(item.project)+'</strong>: '+esc(item.prompt.length>60?item.prompt.slice(0,60)+'\\u2026':item.prompt)+'</div>';
      }).join('');
    }
    function showVoiceFlash(msg){
      var el=document.createElement('div');
      el.className='voice-flash';
      el.textContent=msg;
      document.body.appendChild(el);
      setTimeout(function(){el.classList.add('fade');},1200);
      setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},1600);
    }
    function showVoiceWarning(msg){
      var el=document.getElementById('voice-warning');
      if(el){el.textContent=msg;el.style.display='block';}
    }
    function hideVoiceWarning(){
      var el=document.getElementById('voice-warning');
      if(el)el.style.display='none';
    }`;

export function loginHtml(error = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer — Dashboard</title>
  ${THEME_FOUC_SCRIPT}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0f1117;--bg-card:#1e2130;--border:#2a2f42;--text:#e2e8f0;--text2:#94a3b8;--bg-inp:#0f1117}
    [data-theme=light]{--bg:#f8fafc;--bg-card:#ffffff;--border:#cbd5e1;--text:#0f172a;--text2:#475569;--bg-inp:#ffffff}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:var(--bg-card);border-radius:12px;padding:40px;width:360px}
    h2{font-size:1.2rem;font-weight:600;margin-bottom:24px}
    label{display:block;font-size:.78rem;color:var(--text2);margin-bottom:6px}
    input{width:100%;background:var(--bg-inp);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-size:.875rem;outline:none}
    input:focus{border-color:#3b82f6}
    button[type=submit]{width:100%;margin-top:12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:10px;font-size:.875rem;font-weight:600;cursor:pointer}
    button[type=submit]:hover{background:#2563eb}
    .err{color:#f87171;font-size:.78rem;margin-top:10px}
    .theme-btn{position:fixed;top:16px;right:16px;background:var(--bg-card);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;transition:color .15s,background .15s;line-height:1}
    .theme-btn:hover{color:var(--text)}
  </style>
</head>
<body>
  <button class="theme-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#x2600;</button>
  <div class="card">
    <h2>Implementer Dashboard</h2>
    <form method="POST" action="/dashboard">
      <label for="pw">Admin password</label>
      <input type="password" id="pw" name="password" autofocus placeholder="Enter password">
      <button type="submit">Sign in</button>
      ${error ? '<p class="err">Incorrect password.</p>' : ""}
    </form>
  </div>
  <script>${THEME_TOGGLE_JS}
  </script>
</body>
</html>`;
}

export function dashboardHtml(hasPassword: boolean): string {
    const signOutLink = hasPassword
        ? '<a href="/dashboard/logout" class="out">Sign out</a>'
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Implementer Dashboard</title>
  ${THEME_FOUC_SCRIPT}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0f1117;--bg-card:#1e2130;--bg-head:#161925;--bg-code:#0f1117;--bg-inp:#0f1117;
      --border:#252a3a;--border2:#2a2f42;--hover-bg:#252a3a;--hover-border:#3b4256;--proj-sel:#1a2035;
      --text:#e2e8f0;--text2:#94a3b8;--text3:#64748b;--text4:#4a5568;--text5:#f1f5f9;--text-code:#cbd5e1;
      --overlay:rgba(0,0,0,.75);--shadow:0 20px 60px rgba(0,0,0,.5);--tag-bg:#252a3a;
      --b-run-bg:#14532d;--b-run-fg:#22c55e;--b-start-bg:#0d3b4f;--b-start-fg:#22d3ee;--b-q-bg:#451a03;--b-q-fg:#f59e0b;
      --b-ret-bg:#1e3a5f;--b-ret-fg:#60a5fa;--b-done-bg:#0a2e1e;--b-done-fg:#34d399;
      --b-fail-bg:#3b0f0f;--b-fail-fg:#ef4444;--b-int-bg:#2a1f3a;--b-int-fg:#a78bfa;
      --b-can-bg:#1e2130;--b-can-fg:#475569;
      --b-pr-open-bg:#14532d;--b-pr-open-fg:#4ade80;
      --b-pr-draft-bg:#1e2130;--b-pr-draft-fg:#94a3b8;
      --b-pr-merged-bg:#2e1065;--b-pr-merged-fg:#c084fc;
      --b-pr-closed-bg:#3b0f0f;--b-pr-closed-fg:#ef4444;
      --btn-sec-bg:#252a3a;--btn-sec-fg:#94a3b8;--btn-sec-h:#2a2f42;--btn-ret-h:#78350f;
      --btn-cancel-bg:#3b0f0f;--btn-cancel-fg:#ef4444;--btn-cancel-h:#7f1d1d;
      --btn-edit-bg:#1e3a5f;--btn-edit-fg:#60a5fa;--btn-edit-h:#1e40af;
      --btn-cont-bg:#064e3b;--btn-cont-fg:#34d399;--btn-cont-h:#065f46;
      --link:#60a5fa;
      --voice-bg:#0d2818;--voice-border:#22c55e;--voice-fg:#22c55e;
      --voice-panel-bg:#111a14;--voice-warn-bg:#451a03;--voice-warn-fg:#f59e0b}
    [data-theme=light]{
      --bg:#f8fafc;--bg-card:#ffffff;--bg-head:#f1f5f9;--bg-code:#f1f5f9;--bg-inp:#ffffff;
      --border:#e2e8f0;--border2:#cbd5e1;--hover-bg:#f1f5f9;--hover-border:#94a3b8;--proj-sel:#eff6ff;
      --text:#0f172a;--text2:#475569;--text3:#64748b;--text4:#94a3b8;--text5:#1e293b;--text-code:#374151;
      --overlay:rgba(0,0,0,.5);--shadow:0 20px 60px rgba(0,0,0,.15);--tag-bg:#f1f5f9;
      --b-run-bg:#dcfce7;--b-run-fg:#16a34a;--b-start-bg:#cffafe;--b-start-fg:#0891b2;--b-q-bg:#fef3c7;--b-q-fg:#d97706;
      --b-ret-bg:#dbeafe;--b-ret-fg:#2563eb;--b-done-bg:#d1fae5;--b-done-fg:#059669;
      --b-fail-bg:#fee2e2;--b-fail-fg:#dc2626;--b-int-bg:#ede9fe;--b-int-fg:#7c3aed;
      --b-can-bg:#f1f5f9;--b-can-fg:#64748b;
      --b-pr-open-bg:#dcfce7;--b-pr-open-fg:#16a34a;
      --b-pr-draft-bg:#f1f5f9;--b-pr-draft-fg:#64748b;
      --b-pr-merged-bg:#f3e8ff;--b-pr-merged-fg:#7c3aed;
      --b-pr-closed-bg:#fee2e2;--b-pr-closed-fg:#dc2626;
      --btn-sec-bg:#f1f5f9;--btn-sec-fg:#475569;--btn-sec-h:#e2e8f0;--btn-ret-h:#fbbf24;
      --btn-cancel-bg:#fee2e2;--btn-cancel-fg:#dc2626;--btn-cancel-h:#fca5a5;
      --btn-edit-bg:#dbeafe;--btn-edit-fg:#2563eb;--btn-edit-h:#93c5fd;
      --btn-cont-bg:#d1fae5;--btn-cont-fg:#059669;--btn-cont-h:#a7f3d0;
      --link:#2563eb;
      --voice-bg:#dcfce7;--voice-border:#16a34a;--voice-fg:#16a34a;
      --voice-panel-bg:#f0fdf4;--voice-warn-bg:#fef3c7;--voice-warn-fg:#d97706}
    html{background:var(--bg)}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
    h1{font-size:1.4rem;font-weight:600}
    .live{display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--text2)}
    .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite;flex-shrink:0}
    .dot.err{background:#ef4444;animation:none}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes badge-run-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}50%{box-shadow:0 0 0 5px rgba(34,197,94,0)}}
    @keyframes badge-q-pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.45)}50%{box-shadow:0 0 0 5px rgba(245,158,11,0)}}
    @keyframes badge-ret-pulse{0%,100%{box-shadow:0 0 0 0 rgba(96,165,250,.45)}50%{box-shadow:0 0 0 5px rgba(96,165,250,0)}}
    @keyframes dot-bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-3px)}}
    @keyframes run-row-glow{0%,100%{background:transparent}50%{background:rgba(34,197,94,.04)}}
    @keyframes queued-row-pulse{0%,100%{background:transparent}50%{background:rgba(245,158,11,.04)}}
    @keyframes starting-row-pulse{0%,100%{background:transparent}50%{background:rgba(34,211,238,.04)}}
    @keyframes retrying-row-pulse{0%,100%{background:transparent}50%{background:rgba(96,165,250,.04)}}
    @keyframes pipeline-row-pulse{0%,100%{background:transparent}50%{background:rgba(45,212,191,.04)}}
    @keyframes badge-pipe-pulse{0%,100%{box-shadow:0 0 0 0 rgba(45,212,191,.4)}50%{box-shadow:0 0 0 4px rgba(45,212,191,0)}}
    .badge-spin{display:inline-block;width:9px;height:9px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;margin-right:5px;vertical-align:middle;flex-shrink:0}
    .badge-clock-ico{width:10px;height:10px;margin-right:5px;vertical-align:middle;flex-shrink:0;display:inline-block}
    .badge-dots{display:inline-flex;gap:2px;margin-left:5px;align-items:center}
    .badge-dots span{display:inline-block;width:3px;height:3px;border-radius:50%;background:currentColor;animation:dot-bounce 1.2s ease-in-out infinite}
    .badge-dots span:nth-child(2){animation-delay:.16s}
    .badge-dots span:nth-child(3){animation-delay:.32s}
    .badge-new-dot{display:inline-block;width:5px;height:5px;background:currentColor;border-radius:50%;margin-left:5px;flex-shrink:0;animation:pulse 1.5s ease-in-out infinite}
    .b-running{animation:badge-run-pulse 2s ease-in-out infinite}
    .b-queued{animation:badge-q-pulse 1.6s ease-in-out infinite}
    .b-retrying{animation:badge-ret-pulse 1.8s ease-in-out infinite}
    .b-pipeline{background:var(--b-pipe-bg);color:var(--b-pipe-fg);animation:badge-pipe-pulse 1.8s ease-in-out infinite}
    .b-completed-new{background:var(--b-done-bg);color:var(--b-done-fg);animation:badge-new-glow 2s ease-in-out infinite}
    @keyframes badge-new-glow{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}50%{box-shadow:0 0 0 6px rgba(52,211,153,0)}}
    @keyframes completed-new-row{0%,100%{background:transparent}50%{background:rgba(52,211,153,.05)}}
    .tr-running td{animation:run-row-glow 2.5s ease-in-out infinite}
    .tr-running td:first-child{border-left:3px solid #22c55e80}
    .tr-queued td{animation:queued-row-pulse 2s ease-in-out infinite}
    .tr-queued td:first-child{border-left:3px solid #f59e0b80}
    .tr-starting td{animation:starting-row-pulse 1.5s ease-in-out infinite}
    .tr-starting td:first-child{border-left:3px solid #22d3ee80}
    .tr-retrying td{animation:retrying-row-pulse 2s ease-in-out infinite}
    .tr-retrying td:first-child{border-left:3px solid #60a5fa80}
    .tr-waiting_for_pipeline td{animation:pipeline-row-pulse 2s ease-in-out infinite}
    .tr-waiting_for_pipeline td:first-child{border-left:3px solid #2dd4bf80}
    .tr-completed td:first-child{border-left:3px solid #34d39960}
    .tr-completed-old td:first-child{border-left:3px solid #47556930}
    .tr-completed-new td{animation:completed-new-row 2.5s ease-in-out infinite}
    .tr-completed-new td:first-child{border-left:3px solid #34d399!important}
    .tr-cancelled td:first-child{border-left:3px solid #47556940}
    .ps .badge-clock-ico{width:8px;height:8px;margin-right:2px}
    .stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .stat{background:var(--bg-card);border-radius:8px;padding:14px 20px;min-width:110px;transition:box-shadow .3s,border-color .2s,background .2s;border:2px solid transparent}
    .stat-filter{cursor:pointer;user-select:none}
    .stat-filter:hover{border-color:var(--border2)}
    .stat-filter.stat-selected{border-color:#3b82f6!important;background:var(--proj-sel)!important;box-shadow:0 0 0 1px rgba(59,130,246,.15),0 0 12px rgba(59,130,246,.1)!important}
    .stat.stat-has-running{box-shadow:0 0 0 1px rgba(34,197,94,.3),0 0 12px rgba(34,197,94,.1)}
    .stat.stat-has-queued{box-shadow:0 0 0 1px rgba(245,158,11,.3),0 0 12px rgba(245,158,11,.08)}
    .stat.stat-has-pipeline{box-shadow:0 0 0 1px rgba(45,212,191,.3),0 0 12px rgba(45,212,191,.08)}
    .stat.stat-has-open-prs{box-shadow:0 0 0 1px rgba(74,222,128,.3),0 0 12px rgba(74,222,128,.1)}
    .stat.stat-has-draft-prs{box-shadow:0 0 0 1px rgba(148,163,184,.3),0 0 10px rgba(148,163,184,.07)}
    .stat-label{font-size:.68rem;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;gap:5px}
    .stat-active-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.5s ease-in-out infinite;flex-shrink:0}
    .stat-val{font-size:1.8rem;font-weight:700;margin-top:2px}
    .cr{color:#22c55e}.cq{color:#f59e0b}.ct{color:#60a5fa}.cp{color:#2dd4bf}.cc{color:var(--b-done-fg)}.cf{color:#ef4444}
    .section-title{font-size:.8rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
    .projects{display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap}
    .proj-card{background:var(--bg-card);border-radius:8px;padding:14px 18px;min-width:160px;border:1px solid var(--border);cursor:pointer;user-select:none;transition:border-color .3s,background .3s,box-shadow .3s}
    .proj-card:hover{border-color:var(--hover-border)}
    .proj-card.selected{border-color:#3b82f6;background:var(--proj-sel)}
    .proj-card.proj-active{border-color:rgba(34,197,94,.4);box-shadow:0 0 10px rgba(34,197,94,.1)}
    .proj-card.proj-queued{border-color:rgba(245,158,11,.35);box-shadow:0 0 8px rgba(245,158,11,.08)}
    .proj-name{font-size:.82rem;font-weight:600;color:var(--text);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .proj-stats{display:flex;gap:8px;font-size:.72rem;flex-wrap:wrap}
    .ps{padding:1px 7px;border-radius:4px;font-weight:600;display:inline-flex;align-items:center;gap:3px}
    .ps .badge-spin{width:7px;height:7px;border-width:1.5px;margin-right:0}
    .ps .badge-dots{margin-left:3px}
    .ps .badge-dots span{width:2px;height:2px}
    .ps-running{background:var(--b-run-bg);color:var(--b-run-fg)}
    .ps-starting{background:var(--b-start-bg);color:var(--b-start-fg)}
    .ps-queued{background:var(--b-q-bg);color:var(--b-q-fg)}
    .ps-retrying{background:var(--b-ret-bg);color:var(--b-ret-fg)}
    .ps-completed{background:var(--b-done-bg);color:var(--b-done-fg)}
    .ps-failed{background:var(--b-fail-bg);color:var(--b-fail-fg)}
    .proj-hint{font-size:.72rem;color:var(--text4);margin-bottom:18px;min-height:16px}
    .muted{color:var(--text4)}
    .btn-clear-filters{padding:4px 10px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--text3);font-size:.72rem;cursor:pointer;transition:background .15s,color .15s}
    .btn-clear-filters:hover{background:rgba(239,68,68,.1);color:#ef4444;border-color:#ef444480}
    table{width:100%;border-collapse:collapse;background:var(--bg-card);border-radius:12px;overflow:hidden}
    th{background:var(--bg-head);color:var(--text3);font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;padding:10px 16px;text-align:left;font-weight:600}
    td{padding:12px 16px;border-top:1px solid var(--border);font-size:.85rem;vertical-align:middle}
    tr.clickable{cursor:pointer}
    tr.clickable:hover td{background:var(--hover-bg)}
    .badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}
    .b-running{background:var(--b-run-bg);color:var(--b-run-fg)}
    .b-starting{background:var(--b-start-bg);color:var(--b-start-fg)}
    .b-queued{background:var(--b-q-bg);color:var(--b-q-fg)}
    .b-retrying{background:var(--b-ret-bg);color:var(--b-ret-fg)}
    .b-completed{background:var(--b-done-bg);color:var(--b-done-fg)}
    .b-completed-old{background:transparent;color:var(--text3);font-weight:400}
    .b-failed{background:var(--b-fail-bg);color:var(--b-fail-fg)}
    .b-interrupted{background:var(--b-int-bg);color:var(--b-int-fg)}
    .b-cancelled{background:var(--b-can-bg);color:var(--b-can-fg)}
    .pr-state{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:.65rem;font-weight:600;white-space:nowrap;gap:3px}
    .pr-open{background:var(--b-pr-open-bg);color:var(--b-pr-open-fg)}
    .pr-draft{background:var(--b-pr-draft-bg);color:var(--b-pr-draft-fg)}
    .pr-merged{background:var(--b-pr-merged-bg);color:var(--b-pr-merged-fg)}
    .pr-closed{background:var(--b-pr-closed-bg);color:var(--b-pr-closed-fg)}
    .open-pr-row td:first-child{border-left:3px solid #4ade8070!important}
    .tasks-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .tasks-header .section-title{margin-bottom:0}
    .open-prs-panel{display:flex;flex-direction:column;align-items:flex-end;cursor:pointer;padding:8px 16px;border-radius:10px;background:var(--bg-card);border:1px solid var(--border2);transition:border-color .2s,box-shadow .2s}
    .open-prs-panel:hover{border-color:var(--b-pr-open-fg);box-shadow:0 0 0 1px rgba(74,222,128,.3),0 0 10px rgba(74,222,128,.1)}
    .open-prs-label{font-size:.65rem;color:var(--b-pr-open-fg);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
    .open-prs-count{font-size:2.4rem;font-weight:800;line-height:1;color:var(--b-pr-open-fg)}
    .th-pr{width:90px;text-align:center}
    .td-pr{text-align:center;white-space:nowrap}
    .pr-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:4px;font-size:.72rem;font-weight:700;text-decoration:none;white-space:nowrap;transition:filter .15s,box-shadow .15s;border:1px solid transparent}
    .pr-btn+.pr-btn{margin-left:4px}
    .pr-btn:hover{filter:brightness(1.15);box-shadow:0 0 6px rgba(74,222,128,.3)}
    .pr-btn-open{background:var(--b-pr-open-bg);color:var(--b-pr-open-fg);border-color:rgba(74,222,128,.25)}
    .pr-btn-draft{background:var(--b-pr-draft-bg);color:var(--b-pr-draft-fg);border-color:rgba(148,163,184,.2)}
    .proj-tag{background:var(--tag-bg);padding:2px 8px;border-radius:4px;font-size:.73rem;color:var(--text2)}
    .mono{font-family:ui-monospace,'SF Mono',monospace;font-size:.76rem;color:var(--text2)}
    .ttitle{font-weight:500;color:var(--text5)}
    .tprompt{color:var(--text3);font-size:.76rem;margin-top:2px}
    .empty{text-align:center;color:var(--text4);padding:48px}
    a.out{font-size:.76rem;color:var(--text3);text-decoration:none}
    a.out:hover{color:var(--text2)}
    .btn-new{padding:6px 14px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-new:hover{background:#2563eb}
    .btn-ref-ico{background:none;border:none;color:var(--text2);font-size:.95rem;cursor:pointer;padding:0 0 0 4px;line-height:1;opacity:.7;transition:opacity .15s,color .15s}
    .btn-ref-ico:hover:not(:disabled){opacity:1;color:var(--text)}
    .btn-ref-ico:disabled{opacity:.35;cursor:not-allowed}
    .theme-btn{background:var(--bg-card);border:1px solid var(--border2);color:var(--text2);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;transition:color .15s,background .15s;line-height:1}
    .theme-btn:hover{color:var(--text)}
    /* Modals */
    .overlay{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
    .modal{background:var(--bg-card);border-radius:12px;width:100%;max-width:700px;max-height:90vh;display:flex;flex-direction:column;border:1px solid var(--border2);box-shadow:var(--shadow)}
    .modal-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;gap:12px}
    .modal-ttl{font-size:1rem;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .modal-x{background:transparent;border:none;color:var(--text3);font-size:1.1rem;cursor:pointer;padding:4px 8px;border-radius:4px;flex-shrink:0;line-height:1}
    .modal-x:hover{background:var(--hover-bg);color:var(--text)}
    .modal-bd{padding:20px;overflow-y:auto;flex:1}
    .modal-ft{padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
    .det-row{margin-bottom:14px}
    .det-lbl{font-size:.7rem;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;font-weight:600}
    .det-val{font-size:.875rem;color:var(--text);word-break:break-word}
    .det-pre{white-space:pre-wrap;word-break:break-word;background:var(--bg-code);padding:12px;border-radius:6px;font-family:ui-monospace,'SF Mono',monospace;font-size:.78rem;color:var(--text-code);max-height:220px;overflow-y:auto;line-height:1.5}
    .det-err{background:var(--b-fail-bg);color:var(--b-fail-fg);padding:10px 14px;border-radius:6px;font-size:.82rem;word-break:break-word}
    .pr-link{color:var(--link);text-decoration:none;font-size:.82rem}
    .pr-link:hover{text-decoration:underline}
    .btn{padding:8px 16px;border-radius:6px;border:none;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .15s}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-sec{background:var(--btn-sec-bg);color:var(--btn-sec-fg)}
    .btn-sec:hover:not(:disabled){background:var(--btn-sec-h)}
    .btn-ret{background:var(--b-q-bg);color:var(--b-q-fg)}
    .btn-ret:hover:not(:disabled){background:var(--btn-ret-h)}
    .btn-cancel{background:var(--btn-cancel-bg);color:var(--btn-cancel-fg)}
    .btn-cancel:hover:not(:disabled){background:var(--btn-cancel-h)}
    .btn-edit{background:var(--btn-edit-bg);color:var(--btn-edit-fg)}
    .btn-edit:hover:not(:disabled){background:var(--btn-edit-h)}
    .btn-cont{background:var(--btn-cont-bg);color:var(--btn-cont-fg)}
    .btn-cont:hover:not(:disabled){background:var(--btn-cont-h)}
    .btn-pri{background:#f59e0b;color:#000;border:none}
    .btn-pri:hover:not(:disabled){background:#d97706}
    .btn-depri{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.4)}
    .btn-depri:hover:not(:disabled){background:rgba(245,158,11,.25)}
    /* ── Pause button ─────────────────────────────────────────────────────── */
    .btn-pause{padding:6px 14px;background:var(--b-q-bg);color:var(--b-q-fg);border:1px solid rgba(245,158,11,.3);border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
    .btn-pause:hover{background:var(--btn-ret-h);color:#fff}
    .btn-pause.paused{background:#14532d;color:#22c55e;border-color:rgba(34,197,94,.3)}
    .btn-pause.paused:hover{background:#166534}
    .paused-banner{background:var(--b-q-bg);border:1px solid rgba(245,158,11,.35);color:var(--b-q-fg);padding:8px 16px;border-radius:8px;font-size:.8rem;font-weight:600;margin-bottom:16px;display:none;align-items:center;gap:8px}
    .paused-banner.visible{display:flex}
    /* ── Priority badges ─────────────────────────────────────────────────── */
    .prio{display:inline-block;padding:1px 6px;border-radius:4px;font-size:.62rem;font-weight:700;letter-spacing:.03em;white-space:nowrap;vertical-align:middle;margin-left:4px}
    .prio-low{background:var(--tag-bg);color:var(--text4)}
    .prio-normal{display:none}
    .prio-high{background:#1e3a5f;color:#60a5fa}
    .prio-critical{background:#450a0a;color:#f87171}
    [data-theme=light] .prio-high{background:#dbeafe;color:#1d4ed8}
    [data-theme=light] .prio-critical{background:#fee2e2;color:#b91c1c}
    /* ── Prioritized task row highlight ─────────────────────────────────── */
    tr.tr-prioritized{box-shadow:inset 3px 0 0 #f59e0b}
    tr.tr-prioritized td:first-child{border-left:3px solid #f59e0b}
    .prio-star{display:inline-block;color:#f59e0b;font-size:.8rem;margin-right:2px;vertical-align:middle;line-height:1}
    .form-g{margin-bottom:16px}
    .form-lbl{display:block;font-size:.78rem;color:var(--text2);margin-bottom:6px}
    .form-inp{width:100%;background:var(--bg-inp);border:1px solid var(--border2);border-radius:6px;padding:10px 14px;color:var(--text);font-size:.875rem;outline:none;font-family:inherit}
    .form-inp:focus{border-color:#3b82f6}
    textarea.form-inp{resize:vertical}
    select.form-inp option{background:var(--bg-card)}
    .form-err{background:var(--b-fail-bg);color:var(--b-fail-fg);padding:10px 14px;border-radius:6px;font-size:.8rem;margin-top:8px}
    /* ── Progress bar ──────────────────────────────────────────────────────── */
    .task-progress{margin-top:5px;display:flex;align-items:center;gap:6px}
    .progress-track{flex:1;height:4px;background:var(--border2);border-radius:2px;overflow:hidden;min-width:60px}
    .progress-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,#22c55e,#16a34a);transition:width .5s ease}
    .progress-fill.overrun{background:linear-gradient(90deg,#f59e0b,#d97706)}
    .progress-pct{font-size:.65rem;color:var(--text3);white-space:nowrap;min-width:28px;text-align:right}
    .progress-est{font-size:.65rem;color:var(--text4);white-space:nowrap}
    /* ── Chain grouping ─────────────────────────────────────────────────────── */
    .chain-badge{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;font-size:.65rem;font-weight:700;background:var(--tag-bg);color:var(--text3);margin-left:6px;vertical-align:middle;white-space:nowrap;border:1px solid var(--border2);cursor:default}
    .chain-badge:hover{background:var(--hover-bg);color:var(--text2)}
    .tr-chain-grouped td:first-child{border-left-style:dashed!important}
    /* ── Bulk selection ─────────────────────────────────────────────────────── */
    .th-cb,.td-cb{width:36px;padding-left:12px;padding-right:4px;display:none}
    table.selection-mode .th-cb,table.selection-mode .td-cb{display:table-cell}
    .task-cb{width:15px;height:15px;cursor:pointer;accent-color:#3b82f6}
    table.selection-mode tbody tr.clickable{cursor:default}
    table.selection-mode tbody tr.clickable:hover{background:rgba(59,130,246,.06)}
    tr.tr-sel{background:rgba(59,130,246,.12)!important}
    tr.tr-sel:hover{background:rgba(59,130,246,.18)!important}
    .btn-sel-mode{background:var(--btn-sec-bg);color:var(--btn-sec-fg);padding:4px 12px;border-radius:6px;border:1px solid var(--border2);font-size:.78rem;font-weight:600;cursor:pointer;line-height:1.6;transition:background .15s,color .15s,border-color .15s}
    .btn-sel-mode:hover{background:var(--btn-sec-h)}
    .btn-sel-mode.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
    .sel-hint{font-size:.72rem;color:var(--text3);margin-left:6px;opacity:.7}
    .bulk-bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg-card);border-top:2px solid #3b82f6;padding:12px 24px;display:flex;align-items:center;gap:12px;z-index:200;box-shadow:0 -4px 24px rgba(0,0,0,.35)}
    .bulk-count{font-size:.82rem;font-weight:600;color:var(--text2);margin-right:4px}
    .btn-bulk-retry{background:var(--b-q-bg);color:var(--b-q-fg);padding:7px 16px;border-radius:6px;border:none;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-bulk-retry:hover{background:var(--btn-ret-h)}
    .btn-bulk-cancel{background:var(--btn-cancel-bg);color:var(--btn-cancel-fg);padding:7px 16px;border-radius:6px;border:none;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-bulk-cancel:hover{background:var(--btn-cancel-h)}
    .btn-bulk-clear{background:var(--btn-sec-bg);color:var(--btn-sec-fg);padding:7px 16px;border-radius:6px;border:none;font-size:.78rem;font-weight:600;cursor:pointer}
    .btn-bulk-clear:hover{background:var(--btn-sec-h)}
    /* ── Voice mode ────────────────────────────────────────────────────────── */
    @keyframes voice-pulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}50%{box-shadow:0 0 0 6px rgba(34,197,94,0)}}
    @keyframes voice-glow{0%,100%{box-shadow:0 0 8px rgba(34,197,94,.3),0 0 0 1px rgba(34,197,94,.5)}50%{box-shadow:0 0 16px rgba(34,197,94,.5),0 0 0 2px rgba(34,197,94,.7)}}
    @keyframes voice-flash-in{0%{opacity:0;transform:translate(-50%,-50%) scale(.9)}100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}
    @keyframes voice-flash-out{0%{opacity:1}100%{opacity:0}}
    .voice-btn-active{background:var(--voice-bg)!important;border-color:var(--voice-border)!important;color:var(--voice-fg)!important;animation:voice-pulse 2s ease-in-out infinite}
    .proj-card.voice-target{border-color:var(--voice-border)!important;background:var(--voice-bg)!important;animation:voice-glow 2s ease-in-out infinite;position:relative}
    .proj-card.voice-target .proj-name::before{content:'\uD83C\uDFA4 ';font-size:.9em}
    .voice-panel{position:fixed;bottom:0;left:0;right:0;background:var(--voice-panel-bg);border-top:2px solid var(--voice-border);padding:14px 24px;z-index:200;box-shadow:0 -4px 24px rgba(0,0,0,.35)}
    .voice-panel-inner{max-width:900px;margin:0 auto}
    .voice-status{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:.82rem;color:var(--voice-fg);font-weight:600}
    .voice-controls{display:flex;align-items:center;gap:6px}
    .voice-lang-btn{background:var(--btn-sec-bg);color:var(--btn-sec-fg);border:1px solid var(--border2);border-radius:6px;padding:4px 10px;font-size:.72rem;font-weight:600;cursor:pointer;transition:background .15s}
    .voice-lang-btn:hover{background:var(--btn-sec-h)}
    .voice-cancel-btn{background:var(--btn-cancel-bg);color:var(--btn-cancel-fg);border:none;border-radius:6px;padding:4px 10px;font-size:.72rem;font-weight:600;cursor:pointer;transition:background .15s}
    .voice-cancel-btn:hover{background:var(--btn-cancel-h)}
    .voice-send-btn{background:var(--voice-bg);color:var(--voice-fg);border:1px solid var(--voice-border);border-radius:6px;padding:4px 12px;font-size:.72rem;font-weight:700;cursor:pointer;transition:background .15s,box-shadow .15s}
    .voice-send-btn:hover{box-shadow:0 0 0 2px var(--voice-border);background:var(--voice-border)}
    .voice-transcript{background:var(--bg-code);border-radius:6px;padding:10px 14px;margin-top:8px;font-size:.82rem;color:var(--text);min-height:40px;font-family:ui-monospace,'SF Mono',monospace;word-break:break-word;white-space:pre-wrap}
    .voice-silence-bar{height:4px;background:var(--border2);border-radius:2px;margin-top:6px;overflow:hidden}
    .voice-silence-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--voice-fg),#f59e0b);width:0%;transition:width .1s linear}
    .voice-warning{background:var(--voice-warn-bg);color:var(--voice-warn-fg);padding:8px 14px;border-radius:6px;font-size:.78rem;margin-top:8px;display:none}
    .voice-submitted{margin-top:8px}
    .voice-submitted-item{font-size:.75rem;color:var(--text2);padding:2px 0}
    .voice-flash{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--voice-bg);border:2px solid var(--voice-border);color:var(--voice-fg);padding:16px 28px;border-radius:12px;font-size:1rem;font-weight:700;z-index:9999;pointer-events:none;animation:voice-flash-in .2s ease-out}
    .voice-flash.fade{animation:voice-flash-out .4s ease-in forwards}
    /* ── Responsive ────────────────────────────────────────────────────────── */
    .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
    @media(max-width:767px){
      body{padding:16px}
      .stat{flex:1 1 calc(33% - 8px)}
    }
    @media(max-width:540px){
      body{padding:10px}
      header{flex-direction:column;align-items:stretch;gap:8px;margin-bottom:14px}
      h1{font-size:1.15rem}
      .header-actions{justify-content:space-between;flex-wrap:wrap;gap:6px}
      .stats{gap:6px;margin-bottom:16px}
      .stat{flex:1 1 calc(50% - 3px);padding:10px 12px}
      .stat-val{font-size:1.4rem}
      .proj-card{flex:1 1 calc(50% - 5px);min-width:130px}
      .proj-name{font-size:.78rem}
      th,td{padding:8px 10px}
      table{font-size:.8rem}
      .th-taskid,.td-taskid,.th-dur,.td-dur,.th-started,.td-started{display:none}
      .tprompt{white-space:normal}
      .overlay{padding:6px}
      .modal{max-height:96vh}
      .modal-hd{padding:12px 14px}
      .modal-bd{padding:14px}
      .modal-ft{padding:10px 14px;flex-wrap:wrap;gap:6px}
      .modal-ft .btn{flex:1 1 auto;text-align:center;justify-content:center}
      .btn{padding:7px 12px}
      .btn-new{padding:7px 12px;font-size:.76rem}
      .filters{gap:5px}
      .filter-btn{padding:4px 10px;font-size:.72rem}
      .section-title{font-size:.75rem}
      .voice-panel{padding:10px 14px}
      .voice-status{flex-wrap:wrap;gap:6px}
    }
    /* ── Subscription limits dialog ──────────────────────────────────────── */
    .sub-loading{text-align:center;color:var(--text3);padding:40px 20px;font-size:.85rem}
    .sub-no-token{background:var(--bg-code);color:var(--text2);padding:24px;border-radius:8px;font-size:.82rem;text-align:center;line-height:1.6}
    .sub-no-token code{background:var(--tag-bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,'SF Mono',monospace;font-size:.78rem}
    /* ── Subscription limits ─────────────────────────────────────────────── */
    .sub-section{background:var(--bg-code);border-radius:10px;padding:16px 18px;margin-bottom:18px}
    .sub-header{font-size:.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;display:flex;align-items:center;gap:6px}
    .sub-header .sub-fetched{font-weight:400;text-transform:none;letter-spacing:0;margin-left:auto;font-size:.65rem;color:var(--text4)}
    .sub-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .sub-row:last-child{margin-bottom:0}
    .sub-lbl{font-size:.75rem;color:var(--text2);width:90px;flex-shrink:0}
    .sub-bar-wrap{flex:1;display:flex;align-items:center;gap:8px}
    .sub-bar{flex:1;height:10px;background:var(--border);border-radius:5px;overflow:hidden}
    .sub-bar-fill{height:100%;border-radius:5px;transition:width .3s ease}
    .sub-pct{font-size:.78rem;font-weight:600;min-width:42px;text-align:right;font-family:ui-monospace,'SF Mono',monospace}
    .sub-reset{font-size:.65rem;color:var(--text4);margin-left:4px}
    .sub-not-configured{font-size:.78rem;color:var(--text3);text-align:center;padding:12px}
    .sub-not-configured code{background:var(--tag-bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,'SF Mono',monospace;font-size:.74rem}
    .sub-error{font-size:.78rem;color:var(--b-fail-fg);text-align:center;padding:8px}
    @media(max-width:540px){
      .sub-lbl{width:70px;font-size:.68rem}
      .sub-pct{font-size:.72rem;min-width:36px}
    }
  </style>
</head>
<body>
  <header>
    <h1>Implementer Dashboard</h1>
    <div class="header-actions" style="display:flex;align-items:center;gap:12px">
      <button class="btn-new" onclick="openNewTask()">+ New Task</button>
      <button class="btn-pause" id="pause-btn" onclick="togglePause()" title="Pause/resume queue processing">&#x23F8; Pause</button>
      <button class="theme-btn" id="settings-btn" onclick="openSettings()" title="Settings">&#x2699;</button>
      <button class="theme-btn" id="usage-btn" onclick="openUsageDialog()" title="Subscription Limits">&#x1F4CA;</button>
      <button class="theme-btn" id="voice-btn" onclick="toggleVoiceMode()" title="Voice Mode">&#x1F3A4;</button>
      <button class="theme-btn" id="fullscreen-btn" onclick="toggleFullscreen()" title="Enter fullscreen">&#x26F6;</button>
      <button class="theme-btn" id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#x2600;</button>
      <div class="live"><span class="dot" id="dot"></span><span id="upd">Connecting\u2026</span><button class="btn-ref-ico" id="refresh-btn" onclick="refreshData()" title="Refresh">\u21bb</button></div>
      ${signOutLink}
    </div>
  </header>
  <div class="stats" id="stat-bar">
    <div class="stat stat-filter" id="stat-running" data-filter="running" onclick="toggleStatus('running')" title="Click to filter by Running tasks"><div class="stat-label cr" id="sr-lbl">Running</div><div class="stat-val cr" id="sr">\u2014</div></div>

    <div class="stat stat-filter" id="stat-queued" data-filter="queued" onclick="toggleStatus('queued')" title="Click to filter by Queued tasks"><div class="stat-label cq" id="sq-lbl">Queued</div><div class="stat-val cq" id="sq">\u2014</div></div>
    <div class="stat stat-filter" id="stat-retrying" data-filter="retrying" onclick="toggleStatus('retrying')" title="Click to filter by Retrying tasks"><div class="stat-label ct">Retrying</div><div class="stat-val ct" id="st">\u2014</div></div>
    <div class="stat stat-filter" id="stat-waiting-for-pipeline" data-filter="waiting_for_pipeline" onclick="toggleStatus('waiting_for_pipeline')" title="Click to filter by tasks waiting for pipeline"><div class="stat-label cp" id="swfp-lbl">Pipeline</div><div class="stat-val cp" id="swfp">\u2014</div></div>
    <div class="stat stat-filter" id="stat-completed" data-filter="completed" onclick="toggleStatus('completed')" title="Click to filter by Completed tasks"><div class="stat-label">Completed</div><div class="stat-val cc" id="sc">\u2014</div></div>
    <div class="stat stat-filter" id="stat-failed" data-filter="failed" onclick="toggleStatus('failed')" title="Click to filter by Failed tasks"><div class="stat-label">Failed</div><div class="stat-val cf" id="sf">\u2014</div></div>

    <div class="stat stat-filter" id="stat-cancelled" data-filter="cancelled" onclick="toggleStatus('cancelled')" title="Click to filter by Cancelled tasks"><div class="stat-label" style="color:var(--text3)">Cancelled</div><div class="stat-val" style="color:var(--text3)" id="scan">\u2014</div></div>
    <div class="stat stat-filter" id="stat-open-prs" data-filter="open-prs" onclick="toggleStatus('open-prs')" title="Click to filter tasks with open PRs"><div class="stat-label" style="color:var(--b-pr-open-fg)" id="spr-lbl">Open PRs</div><div class="stat-val" style="color:var(--b-pr-open-fg)" id="spr">\u2014</div></div>

  </div>
  <div id="paused-banner" class="paused-banner">&#x23F8; Queue is paused &mdash; running tasks will finish but no new tasks will start. <button class="btn" style="background:#22c55e;color:#fff;padding:4px 12px;font-size:.75rem;margin-left:auto" onclick="togglePause()">Resume Queue</button></div>
  <div class="section-title">Projects</div>
  <div class="projects" id="projects"><div class="muted" style="font-size:.82rem">Loading\u2026</div></div>
  <div class="proj-hint" id="proj-hint">Click a project card to filter tasks by project.</div>
  <div class="tasks-header" style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
    <div class="section-title" style="flex:1;margin-bottom:0">Tasks</div>
    <button id="btn-clear-filters" class="btn-clear-filters" onclick="clearStatusFilters()" style="display:none" title="Clear all status filters">&#x2715; Clear filters</button>
    <span class="sel-hint" id="sel-hint" style="display:none">Shift+click for range</span>
    <button id="btn-chain-group" class="btn-sel-mode active" onclick="toggleChainGroup()" title="Group tasks from the same chain together (show only the most active task per chain)">\u26D3 Group chains</button>
    <button id="btn-sel-mode" class="btn-sel-mode" onclick="toggleSelectionMode()" title="Enable multi-select mode (tip: hold Shift and click any row to select)">Select</button>
  </div>
  <div class="table-wrap">
  <table id="task-table">
    <thead><tr>
      <th class="th-cb"><input type="checkbox" id="cb-all" title="Select all visible tasks" onchange="toggleSelectAll(this.checked)"></th><th>Status</th><th>Project</th><th class="th-taskid">Task ID</th><th>Title / Prompt</th><th class="th-dur">Duration</th><th class="th-started">Started</th><th class="th-pr">PR</th>
    </tr></thead>
    <tbody id="tb"><tr><td colspan="8" class="empty">Connecting\u2026</td></tr></tbody>
  </table>
  </div>

  <!-- Bulk action bar -->
  <div id="bulk-bar" class="bulk-bar" style="display:none">
    <span class="bulk-count" id="bulk-count">0 selected</span>
    <button class="btn-bulk-retry" onclick="bulkRetry()">Retry Selected</button>
    <button class="btn-bulk-cancel" onclick="bulkCancel()">Cancel Selected</button>
    <button class="btn-bulk-clear" onclick="clearSelection()">Clear</button>
  </div>

  <!-- Voice Mode Panel -->
  <div id="voice-panel" class="voice-panel" style="display:none">
    <div class="voice-panel-inner">
      <div class="voice-status">
        <span id="voice-status-text">\uD83C\uDFA4 Voice Mode \u2014 Select a project to begin</span>
        <div class="voice-controls">
          <button id="voice-lang-btn" class="voice-lang-btn" onclick="toggleVoiceLang()">cs-CZ</button>
          <button id="voice-send-btn" class="voice-send-btn" onclick="voiceSendNow()" style="display:none">\u2713 Send</button>
          <button id="voice-cancel-btn" class="voice-cancel-btn" onclick="voiceCancel()" style="display:none">\u2715 Cancel</button>
        </div>
      </div>
      <div id="voice-transcript-area" style="display:none">
        <div class="voice-transcript">
          <div id="voice-transcript-text" class="voice-transcript-text"></div>
        </div>
        <div class="voice-silence-bar"><div class="voice-silence-fill" id="voice-silence-fill"></div></div>
      </div>
      <div id="voice-warning" class="voice-warning"></div>
      <div id="voice-submitted" class="voice-submitted"></div>
    </div>
  </div>

  <!-- Subscription Limits Dialog -->
  <div id="usage-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeUsageDialog()">
    <div class="modal" style="max-width:600px">
      <div class="modal-hd">
        <span class="modal-ttl">Subscription Limits</span>
        <button class="modal-x" onclick="closeUsageDialog()">&times;</button>
      </div>
      <div class="modal-bd" id="sub-container">
        <div class="sub-loading">Loading subscription data&hellip;</div>
      </div>
    </div>
  </div>

  <!-- Settings Modal -->
  <div id="settings-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeSettings()">
    <div class="modal" style="max-width:800px">
      <div class="modal-hd">
        <span class="modal-ttl">Settings &mdash; config.yaml</span>
        <button class="modal-x" onclick="closeSettings()">&times;</button>
      </div>
      <div class="modal-bd" style="padding:12px 20px">
        <div id="settings-error" style="display:none;background:var(--b-fail-bg);color:var(--b-fail-fg);padding:10px 14px;border-radius:8px;margin-bottom:10px;font-size:.82rem;white-space:pre-wrap"></div>
        <div id="settings-success" style="display:none;background:var(--b-done-bg);color:var(--b-done-fg);padding:10px 14px;border-radius:8px;margin-bottom:10px;font-size:.82rem"></div>
        <div class="cfg-editor-wrap">
          <div class="cfg-line-nums" id="settings-line-nums"></div>
          <div class="cfg-editor-inner" id="settings-editor-inner">
            <div class="cfg-editor-content">
              <pre class="cfg-highlight" id="settings-highlight" aria-hidden="true"></pre>
              <textarea id="settings-editor" class="cfg-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeSettings()">Cancel</button>
        <button class="btn btn-pri" id="settings-save" onclick="saveConfig(false)">Save</button>
        <button class="btn" id="settings-restart" onclick="saveConfig(true)" style="background:#f59e0b;color:#000;font-weight:600">Save &amp; Restart</button>
      </div>
    </div>
  </div>

  <!-- Task Detail Modal -->
  <div id="task-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeTask()">
    <div class="modal">
      <div class="modal-hd">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
          <span class="modal-ttl" id="task-ttl">Task Details</span>
          <span id="task-badge"></span>
        </div>
        <button class="modal-x" onclick="closeTask()">&#x2715;</button>
      </div>
      <div class="modal-bd" id="task-bd"><div class="muted" style="text-align:center;padding:32px">Loading\u2026</div></div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeTask()">Close</button>
        <button class="btn btn-pri" id="task-prioritize" onclick="toggleTaskPriority()" style="display:none">&#x2605; Prioritize</button>
        <button class="btn btn-edit" id="task-edit" onclick="openEditTask()" style="display:none">Edit Task</button>
        <button class="btn btn-cancel" id="task-cancel" onclick="cancelTask()" style="display:none">Cancel Task</button>
        <button class="btn btn-ret" id="task-retry" onclick="retryTask()" style="display:none">Retry Task</button>
        <button class="btn btn-ret" id="task-retry-now" onclick="retryNow()" style="display:none">Retry Now</button>
        <button class="btn btn-cont" id="task-continue" onclick="openContinueTask()" style="display:none">Continue Task</button>
      </div>
    </div>
  </div>

  <!-- Edit Task Modal -->
  <div id="et-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeEditTask()">
    <div class="modal">
      <div class="modal-hd">
        <span class="modal-ttl">Edit Task</span>
        <button class="modal-x" onclick="closeEditTask()">&#x2715;</button>
      </div>
      <div class="modal-bd">
        <div class="form-g">
          <label class="form-lbl" for="et-prompt">Prompt</label>
          <textarea id="et-prompt" class="form-inp" rows="10" placeholder="Describe what to implement\u2026"></textarea>
        </div>
        <div id="et-err" class="form-err" style="display:none"></div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeEditTask()">Cancel</button>
        <button class="btn btn-pri" id="et-submit" onclick="submitEditTask()">Save Changes</button>
      </div>
    </div>
  </div>

  <!-- Continue Task Modal -->
  <div id="ct-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeContinueTask()">
    <div class="modal">
      <div class="modal-hd">
        <span class="modal-ttl">Continue Task</span>
        <button class="modal-x" onclick="closeContinueTask()">&#x2715;</button>
      </div>
      <div class="modal-bd">
        <div class="form-g">
          <label class="form-lbl">Continuing task</label>
          <div class="mono" id="ct-taskid" style="font-size:.82rem;padding:6px 0;color:var(--text2)"></div>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="ct-prompt">What should be done next?</label>
          <textarea id="ct-prompt" class="form-inp" rows="8" placeholder="Describe what to implement next\u2026"></textarea>
        </div>
        <div id="ct-err" class="form-err" style="display:none"></div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeContinueTask()">Cancel</button>
        <button class="btn btn-cont" id="ct-submit" onclick="submitContinueTask()">Continue Task</button>
      </div>
    </div>
  </div>

  <!-- New Task Modal -->
  <div id="nt-overlay" class="overlay" style="display:none" onclick="if(event.target===this)closeNewTask()">
    <div class="modal">
      <div class="modal-hd">
        <span class="modal-ttl">New Task</span>
        <button class="modal-x" onclick="closeNewTask()">&#x2715;</button>
      </div>
      <div class="modal-bd">
        <div class="form-g">
          <label class="form-lbl" for="nt-proj">Project</label>
          <select id="nt-proj" class="form-inp"></select>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="nt-prompt">Prompt</label>
          <textarea id="nt-prompt" class="form-inp" rows="8" placeholder="Describe what to implement\u2026"></textarea>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="nt-priority">Priority</label>
          <select id="nt-priority" class="form-inp">
            <option value="low">Low</option>
            <option value="normal" selected>Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="form-g">
          <label class="form-lbl" for="nt-continue">Continue Task ID <span class="muted" style="font-weight:400">(optional)</span></label>
          <input type="text" id="nt-continue" class="form-inp" placeholder="TVchAThD">
        </div>
        <div id="nt-err" class="form-err" style="display:none"></div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-sec" onclick="closeNewTask()">Cancel</button>
        <button class="btn btn-pri" id="nt-submit" onclick="submitNewTask()">Create Task</button>
      </div>
    </div>
  </div>

  <script>
    var selectedStatuses=new Set(),selectedProjects=new Set(),lastData=null,currentTaskId=null,currentTaskData=null,retryCountdownInterval=null,selectedTaskIds=new Set(),selectionMode=false,lastSelectedIdx=-1,voiceMode=false,voiceTarget=null,voiceRecognition=null,voiceTranscript='',voiceSilenceTimer=null,voiceSilenceStart=0,voiceLang='cs-CZ',voiceSubmittedLog=[],queuePaused=false;
    function escapeHtml(s){if(!s)return '';var d=document.createElement('div');d.appendChild(document.createTextNode(s));return d.innerHTML;}
    var chainGroupMode=true;try{var _cgStored=localStorage.getItem('impl-chain-group');if(_cgStored!==null)chainGroupMode=_cgStored!=='false';}catch(e){}
    (function(){var btn=document.getElementById('btn-chain-group');if(btn)btn.classList.toggle('active',chainGroupMode);})();
    function applyChainGrouping(tasks){
      if(!chainGroupMode)return tasks;
      var chains={};
      tasks.forEach(function(t){var cid=t.chainId||t.taskId;if(!chains[cid])chains[cid]=[];chains[cid].push(t);});
      var statusPri={running:0,starting:1,queued:2,retrying:3,completed:4,failed:5,interrupted:6,cancelled:7};
      var getP=function(s){return statusPri[s]!==undefined?statusPri[s]:8;};
      var seen=new Set();
      var result=[];
      tasks.forEach(function(t){
        var cid=t.chainId||t.taskId;
        if(seen.has(cid))return;
        seen.add(cid);
        var chain=chains[cid].slice().sort(function(a,b){
          var pa=getP(a.status),pb=getP(b.status);
          if(pa!==pb)return pa-pb;
          return new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime();
        });
        var rep=chain[0];
        result.push(Object.assign({},rep,{_chainSize:chain.length,_chainId:cid}));
      });
      return result;
    }
    function getVisibleTasks(tasks){
      var filtered=tasks.filter(taskMatchesFilters);
      return applyChainGrouping(filtered);
    }
    function toggleChainGroup(){
      chainGroupMode=!chainGroupMode;
      try{localStorage.setItem('impl-chain-group',chainGroupMode?'true':'false');}catch(e){}
      var btn=document.getElementById('btn-chain-group');
      if(btn)btn.classList.toggle('active',chainGroupMode);
      if(lastData)renderTasks(lastData.tasks);
    }
    function hasOpenPrs(t){return!!(t.pullRequests&&t.pullRequests.some(function(pr){return pr.state==='open'||pr.state==='draft'||!pr.state;}));}
    function hasDraftPrs(t){return!!(t.pullRequests&&t.pullRequests.some(function(pr){return pr.state==='draft';}));}
    function prStateBadge(state){
      var map={open:['pr-open','\u25CF Open'],draft:['pr-draft','\u25CB Draft'],merged:['pr-merged','\u2A2F Merged'],closed:['pr-closed','\u2715 Closed']};
      var s=state||'open';var r=map[s]||map['open'];
      return '<span class="pr-state '+r[0]+'">'+r[1]+'</span>';
    }
    function fmtCountdown(ms){if(ms<=0)return 'now';var s=Math.ceil(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60),r=s%60;return m+'m '+r+'s';}
    function startRetryCountdown(nextRetryAt){
      if(retryCountdownInterval)clearInterval(retryCountdownInterval);
      var el=document.getElementById('retry-countdown');
      if(!el||!nextRetryAt)return;
      var target=new Date(nextRetryAt).getTime();
      function tick(){var rem=target-Date.now();if(el)el.textContent=fmtCountdown(rem);}
      tick();
      retryCountdownInterval=setInterval(tick,1000);
    }
    function stopRetryCountdown(){if(retryCountdownInterval){clearInterval(retryCountdownInterval);retryCountdownInterval=null;}}
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function priorityBadge(p){var labels={low:'Low',high:'High',critical:'Critical'};if(!p||p==='normal')return '';return '<span class="prio prio-'+esc(p)+'">'+esc(labels[p]||p)+'</span>';}
    function updatePauseUI(paused){
      queuePaused=paused;
      var btn=document.getElementById('pause-btn');
      var banner=document.getElementById('paused-banner');
      if(btn){btn.textContent=paused?'\u25B6\uFE0F Resume':'\u23F8 Pause';btn.className=paused?'btn-pause paused':'btn-pause';btn.title=paused?'Resume queue processing':'Pause queue processing';}
      if(banner){banner.className=paused?'paused-banner visible':'paused-banner';}
    }
    function togglePause(){
      var endpoint=queuePaused?'/dashboard/api/resume':'/dashboard/api/pause';
      fetch(endpoint,{method:'POST'})
        .then(function(r){return r.json();})
        .then(function(d){updatePauseUI(d.paused);})
        .catch(function(){alert('Failed to '+(queuePaused?'resume':'pause')+' queue');});
    }
    var _spin='<span class="badge-spin"></span>';
    var _dots='<span class="badge-dots"><span></span><span></span><span></span></span>';
    var _clock='<svg class="badge-clock-ico" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="5"/><path stroke-linecap="round" d="M6 3v3l2 1"/></svg>';
    function isRecentCompleted(ca){return!!ca&&(Date.now()-new Date(ca).getTime())<1200000;}
    function badge(s,completedAt,isUnread){var isNew=s==='completed'&&!!isUnread;var cc=isNew?'b-completed-new':(isRecentCompleted(completedAt)?'b-completed':'b-completed-old');var newDot=isNew?'<span class="badge-new-dot"></span>':'';var m={running:['b-running',_spin+'Running'],starting:['b-starting',_spin+'Starting'],queued:['b-queued','Queued'+_dots],retrying:['b-retrying',_clock+'Scheduled Retry'],waiting_for_pipeline:['b-pipeline',_clock+'Waiting for Pipeline'],completed:[cc,'&#10003; Completed'+newDot],failed:['b-failed','Failed'],interrupted:['b-interrupted','Interrupted'],cancelled:['b-cancelled','&#215; Cancelled']};var r=m[s]||['','Unknown'];return '<span class="badge '+r[0]+'">'+r[1]+'</span>';}
    function dur(s){if(s==null)return '—';if(s<60)return s+'s';var m=Math.floor(s/60),r=s%60;if(m<60)return m+'m '+r+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
    function fmtDate(d){if(d==null)return '—';try{var dt=new Date(d);return isNaN(dt.getTime())?'—':dt.toLocaleString();}catch(e){return String(d);}}
    function taskMatchesFilters(t){
      var statusOk=selectedStatuses.size===0||selectedStatuses.has(t.status)||(selectedStatuses.has('running')&&t.status==='starting')||(selectedStatuses.has('open-prs')&&taskHasOpenPr(t));
      var projOk=selectedProjects.size===0||selectedProjects.has(t.projectId);
      return statusOk&&projOk;
    }
    function toggleStatus(status){
      if(selectedStatuses.has(status)){selectedStatuses.delete(status);}else{selectedStatuses.add(status);}
      document.querySelectorAll('.stat-filter').forEach(function(card){card.classList.toggle('stat-selected',selectedStatuses.has(card.dataset.filter));});
      var clearBtn=document.getElementById('btn-clear-filters');
      if(clearBtn)clearBtn.style.display=selectedStatuses.size>0?'':'none';
      if(lastData)renderTasks(lastData.tasks);
    }
    function clearStatusFilters(){
      selectedStatuses.clear();
      document.querySelectorAll('.stat-filter').forEach(function(card){card.classList.remove('stat-selected');});
      var clearBtn=document.getElementById('btn-clear-filters');
      if(clearBtn)clearBtn.style.display='none';
      if(lastData)renderTasks(lastData.tasks);
    }
    function taskHasOpenPr(t){return hasOpenPrs(t);}
    function taskHasDraftPr(t){return hasDraftPrs(t);}
    function toggleProject(id){
      if(voiceMode){voiceSelectProject(id);return;}
      if(selectedProjects.has(id)){selectedProjects.delete(id);}else{selectedProjects.add(id);}
      updateProjHint();
      if(lastData){renderProjects(lastData.projects);renderTasks(lastData.tasks);}
    }
    function updateProjHint(){
      var el=document.getElementById('proj-hint');
      if(voiceMode){el.textContent=voiceTarget?'Voice target: '+voiceTarget+'. Speak now, or click another project.':'Voice mode active. Click a project card to start dictating.';return;}
      if(selectedProjects.size===0){el.textContent='Click a project card to filter tasks by project.';}
      else{var names=Array.from(selectedProjects).join(', ');el.textContent='Filtering by: '+names+'. Click again to deselect.';}
    }
    function renderProjects(projects){
      var el=document.getElementById('projects');
      var ids=Object.keys(projects);
      if(!ids.length){el.innerHTML='<div class="muted" style="font-size:.82rem">No projects</div>';return;}
      el.innerHTML=ids.map(function(id){
        var p=projects[id],sel=selectedProjects.has(id);
        var isVoiceTarget=voiceMode&&voiceTarget===id;
        var hasActive=(p.running||0)+(p.starting||0)+(p.retrying||0)+(p.waiting_for_pipeline||0)>0;
        var hasQueued=(p.queued||0)>0;
        var parts=[];
        if(p.running)parts.push('<span class="ps ps-running">'+_spin+p.running+' running</span>');
        if(p.starting)parts.push('<span class="ps ps-starting">'+_spin+p.starting+' starting</span>');
        if(p.queued)parts.push('<span class="ps ps-queued">'+p.queued+' queued'+_dots+'</span>');
        if(p.retrying)parts.push('<span class="ps ps-retrying">'+_clock+p.retrying+' scheduled</span>');
        if(p.waiting_for_pipeline)parts.push('<span class="ps ps-pipeline">'+_clock+p.waiting_for_pipeline+' pipeline</span>');
        if(p.completed)parts.push('<span class="ps ps-completed">'+p.completed+' done</span>');
        if(p.failed)parts.push('<span class="ps ps-failed">'+p.failed+' failed</span>');
        if(!parts.length)parts.push('<span class="muted" style="font-size:.72rem">No tasks</span>');
        var extraClass=hasActive?' proj-active':hasQueued?' proj-queued':'';
        var cardClass='proj-card'+(isVoiceTarget?' voice-target':(sel?' selected':''))+extraClass;
        var namePrefix=isVoiceTarget?'':(sel?'\u2714 ':'');
        return '<div class="'+cardClass+'" data-proj="'+esc(id)+'">'
          +'<div class="proj-name" title="'+esc(id)+'">'+namePrefix+esc(id)+'</div>'
          +'<div class="proj-stats">'+parts.join('')+'</div>'
          +'</div>';
      }).join('');
      el.querySelectorAll('.proj-card').forEach(function(card){
        card.addEventListener('click',function(){toggleProject(this.dataset.proj);});
      });
    }
    function recomputeFilteredStats(){
      // Use backend-provided stats (computed from ALL tasks, not the 200-limited tasks array).
      // When project filter is active, sum per-project counts from backend projects data.
      if(!lastData)return;
      var counts;
      if(selectedProjects.size===0){
        // No project filter — use global stats from backend (accurate across all tasks)
        counts={
          running:lastData.stats.running||0,
          starting:lastData.stats.starting||0,
          queued:lastData.stats.queued||0,
          retrying:lastData.stats.retrying||0,
          waiting_for_pipeline:lastData.stats.waiting_for_pipeline||0,
          completed:lastData.stats.completed||0,
          failed:lastData.stats.failed||0,
          interrupted:lastData.stats.interrupted||0,
          cancelled:lastData.stats.cancelled||0
        };
      }else{
        // Project filter active — sum per-project stats from backend projects data
        counts={running:0,starting:0,queued:0,retrying:0,waiting_for_pipeline:0,completed:0,failed:0,interrupted:0,cancelled:0};
        selectedProjects.forEach(function(pid){
          var p=lastData.projects[pid];
          if(!p)return;
          counts.running+=(p.running||0);
          counts.starting+=(p.starting||0);
          counts.queued+=(p.queued||0);
          counts.retrying+=(p.retrying||0);
          counts.waiting_for_pipeline+=(p.waiting_for_pipeline||0);
          counts.completed+=(p.completed||0);
          counts.failed+=(p.failed||0);
          counts.interrupted+=(p.interrupted||0);
          counts.cancelled+=(p.cancelled||0);
        });
      }
      // Update status count DOM elements
      // Merge starting count into running for the stat bar display
      var runningCombined=counts.running+counts.starting;
      document.getElementById('sr').textContent=runningCombined;
      document.getElementById('sq').textContent=counts.queued;
      document.getElementById('st').textContent=counts.retrying;
      document.getElementById('swfp').textContent=counts.waiting_for_pipeline;
      document.getElementById('sc').textContent=counts.completed;
      document.getElementById('sf').textContent=counts.failed;
      document.getElementById('scan').textContent=counts.cancelled;
      // Compute unique PR counts across filtered tasks (use tasks array for PR dedup)
      var tasks=lastData.tasks||[];
      var projTasks=selectedProjects.size===0?tasks:tasks.filter(function(t){return selectedProjects.has(t.projectId);});
      var openUrls={};
      projTasks.forEach(function(t){
        (t.pullRequests||[]).forEach(function(pr){
          if(pr.url){
            if(pr.state==='open')openUrls[pr.url]=true;
          }
        });
      });
      var openPrs=Object.keys(openUrls).length;
      document.getElementById('spr').textContent=openPrs;
      // Update visual state indicators
      var sprCard=document.getElementById('stat-open-prs');
      if(sprCard)sprCard.classList.toggle('stat-has-open-prs',openPrs>0);
      var srCard=document.getElementById('stat-running');
      var sqCard=document.getElementById('stat-queued');
      var swfpCard=document.getElementById('stat-waiting-for-pipeline');
      var srLbl=document.getElementById('sr-lbl');
      var sqLbl=document.getElementById('sq-lbl');
      var swfpLbl=document.getElementById('swfp-lbl');
      if(srCard){srCard.classList.toggle('stat-has-running',runningCombined>0);}
      if(srLbl){srLbl.innerHTML=runningCombined>0?'<span class="stat-active-dot cr"></span>Running':'Running';}
      if(sqCard){sqCard.classList.toggle('stat-has-queued',counts.queued>0);}
      if(sqLbl){sqLbl.innerHTML=counts.queued>0?'<span class="stat-active-dot cq"></span>Queued':'Queued';}
      var wfpCount=counts.waiting_for_pipeline||0;
      if(swfpCard){swfpCard.classList.toggle('stat-has-pipeline',wfpCount>0);}
      if(swfpLbl){swfpLbl.innerHTML=wfpCount>0?'<span class="stat-active-dot cp"></span>Pipeline':'Pipeline';}
    }
    function renderTasks(tasks){
      recomputeFilteredStats();
      var filtered=getVisibleTasks(tasks);
      var tb=document.getElementById('tb');
      if(!filtered.length){
        var msg='No tasks';
        if(selectedStatuses.size===1&&selectedStatuses.has('open-prs'))msg='No tasks with open pull requests';
        else if(selectedStatuses.size===1&&selectedStatuses.has('draft-prs'))msg='No tasks with draft pull requests';
        else if(selectedStatuses.size>0)msg+=' matching selected status filter'+(selectedStatuses.size>1?'s':'');
        if(selectedProjects.size>0)msg+=' in selected project'+(selectedProjects.size>1?'s':'');
        tb.innerHTML='<tr><td colspan="8" class="empty">'+msg+'</td></tr>';return;
      }
      tb.innerHTML=filtered.map(function(t,idx){
        var isChecked=selectedTaskIds.has(t.taskId);
        var rowClass='clickable tr-'+esc(t.status)+(selectionMode&&isChecked?' tr-sel':'');
        if(t.status==='completed'&&!isRecentCompleted(t.completedAt))rowClass+=' tr-completed-old';
        if(t.status==='completed'&&!t.readAt)rowClass+=' tr-completed-new';
        var activePrs=t.pullRequests?t.pullRequests.filter(function(pr){return pr.state==='open'||pr.state==='draft';}):[];
        if(activePrs.length>0)rowClass+=' open-pr-row';
        if(t.priority==='high'||t.priority==='critical')rowClass+=' tr-prioritized';
        var prBtns='';
        if(activePrs.length){
          prBtns=activePrs.map(function(pr){
            var num=pr.url?pr.url.split('/').pop():'PR';
            var isDraft=pr.state==='draft';
            var stateClass=isDraft?'pr-btn-draft':'pr-btn-open';
            var label=isDraft?'\u25CB Draft':'\u25CF';
            return '<a class="pr-btn '+stateClass+'" href="'+esc(pr.url)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="'+(isDraft?'Draft':'Open')+' PR #'+esc(num)+' \u2014 '+esc(pr.repo||'')+'">'+label+'&nbsp;#'+esc(num)+'</a>';
          }).join('');
        }
        var progressHtml='';
        if((t.status==='running'||t.status==='starting')&&t.estimatedDurationSeconds&&t.durationSeconds!==null){
          var pct=Math.min(100,Math.round((t.durationSeconds/t.estimatedDurationSeconds)*100));
          var isOverrun=pct>=100;
          var fillClass='progress-fill'+(isOverrun?' overrun':'');
          var estLabel=dur(t.estimatedDurationSeconds);
          progressHtml='<div class="task-progress"><div class="progress-track"><div class="'+fillClass+'" style="width:'+pct+'%"></div></div><span class="progress-pct">'+pct+'%</span><span class="progress-est">/ '+estLabel+'</span></div>';
        }
        var prioBadge=priorityBadge(t.priority);
        var prioStar=(t.priority==='high'||t.priority==='critical')?'<span class="prio-star" title="Prioritized">\u2605</span>':'';
        var chainBadge=t._chainSize>1?'<span class="chain-badge" title="Chain: '+esc(t._chainId)+' ('+t._chainSize+' tasks)">\u26D3 '+t._chainSize+'</span>':'';
        if(t._chainSize>1)rowClass+=' tr-chain-grouped';
        return '<tr class="'+rowClass+'" data-id="'+esc(t.taskId)+'" data-proj="'+esc(t.projectId)+'" data-idx="'+idx+'">'
          +'<td class="td-cb" onclick="event.stopPropagation()"><input type="checkbox" class="task-cb" data-id="'+esc(t.taskId)+'" '+(isChecked?'checked':'')+' onchange="toggleTaskSelection(this.dataset.id,this.checked)" onclick="event.stopPropagation()"></td>'
          +'<td>'+badge(t.status,t.completedAt,!t.readAt)+'</td>'
          +'<td>'+(t.repoUrl?'<span class="proj-tag">'+esc(t.repoUrl.replace(/\\.git$/,"").split("/").slice(-2).join("/"))+'</span>':'<span class="proj-tag">'+esc(t.projectId)+'</span>')+'</td>'
          +'<td class="td-taskid"><span class="mono">'+esc(t.taskId)+'</span></td>'
          +'<td>'+(t.title?'<div class="ttitle">'+prioStar+esc(t.title)+prioBadge+chainBadge+'</div>':'')+'<div class="tprompt">'+prioStar+esc(t.prompt.length>90?t.prompt.slice(0,90)+'\u2026':t.prompt)+(t.title?'':prioBadge+chainBadge)+'</div>'+progressHtml+'</td>'
          +'<td class="td-dur mono">'+dur(t.durationSeconds)+'</td>'
          +'<td class="td-started mono">'+fmtDate(t.createdAt)+'</td>'
          +'<td class="td-pr">'+(prBtns||'')+'</td>'
          +'</tr>';
      }).join('');
      tb.querySelectorAll('tr.clickable').forEach(function(row){
        row.addEventListener('click',function(e){handleRowClick(e,this.dataset.id,parseInt(this.dataset.idx,10),this.dataset.proj);});
      });
      // Sync select-all checkbox
      var cbAll=document.getElementById('cb-all');
      if(cbAll){var total=filtered.length,checked=filtered.filter(function(t){return selectedTaskIds.has(t.taskId);}).length;cbAll.checked=total>0&&checked===total;cbAll.indeterminate=checked>0&&checked<total;}
    }
    function toggleTaskSelection(taskId,checked){
      if(checked)selectedTaskIds.add(taskId);
      else selectedTaskIds.delete(taskId);
      updateBulkBar();
      // Sync select-all checkbox
      var cbAll=document.getElementById('cb-all');
      if(cbAll&&lastData){var visible=document.querySelectorAll('.task-cb');var total=visible.length,ch=Array.from(visible).filter(function(c){return c.checked;}).length;cbAll.checked=total>0&&ch===total;cbAll.indeterminate=ch>0&&ch<total;}
    }
    function toggleSelectAll(checked){
      document.querySelectorAll('.task-cb').forEach(function(cb){
        cb.checked=checked;
        if(checked)selectedTaskIds.add(cb.dataset.id);
        else selectedTaskIds.delete(cb.dataset.id);
      });
      updateBulkBar();
    }
    function updateBulkBar(){
      var bar=document.getElementById('bulk-bar');
      var count=selectedTaskIds.size;
      if(!count){bar.style.display='none';return;}
      bar.style.display='flex';
      document.getElementById('bulk-count').textContent=count+' task'+(count>1?'s':'')+' selected';
    }
    function clearSelection(){
      exitSelectionMode();
    }
    function bulkRetry(){
      var ids=Array.from(selectedTaskIds);
      if(!ids.length)return;
      if(!confirm('Retry '+ids.length+' task'+(ids.length>1?'s':'')+'?'))return;
      fetch('/dashboard/api/tasks/bulk-retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskIds:ids})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.error){alert('Error: '+d.error);return;}
          clearSelection();
        })
        .catch(function(){alert('Failed to retry tasks');});
    }
    function bulkCancel(){
      var ids=Array.from(selectedTaskIds);
      if(!ids.length)return;
      if(!confirm('Cancel '+ids.length+' task'+(ids.length>1?'s':'')+'?'))return;
      fetch('/dashboard/api/tasks/bulk-cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskIds:ids})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.error){alert('Error: '+d.error);return;}
          clearSelection();
        })
        .catch(function(){alert('Failed to cancel tasks');});
    }
    function enterSelectionMode(){
      if(voiceMode)toggleVoiceMode();
      selectionMode=true;
      var t=document.getElementById('task-table');if(t)t.classList.add('selection-mode');
      var btn=document.getElementById('btn-sel-mode');if(btn){btn.classList.add('active');btn.textContent='Cancel';}
      var hint=document.getElementById('sel-hint');if(hint)hint.style.display='';
      if(lastData)renderTasks(lastData.tasks);
    }
    function exitSelectionMode(){
      selectionMode=false;
      selectedTaskIds.clear();
      lastSelectedIdx=-1;
      var t=document.getElementById('task-table');if(t)t.classList.remove('selection-mode');
      var btn=document.getElementById('btn-sel-mode');if(btn){btn.classList.remove('active');btn.textContent='Select';}
      var hint=document.getElementById('sel-hint');if(hint)hint.style.display='none';
      updateBulkBar();
      if(lastData)renderTasks(lastData.tasks);
    }
    function toggleSelectionMode(){if(selectionMode)exitSelectionMode();else enterSelectionMode();}
    function rangeSelect(toIdx){
      if(!lastData)return;
      var visible=getVisibleTasks(lastData.tasks);
      var from=Math.min(lastSelectedIdx,toIdx),to=Math.max(lastSelectedIdx,toIdx);
      for(var i=from;i<=to&&i<visible.length;i++)selectedTaskIds.add(visible[i].taskId);
      lastSelectedIdx=toIdx;
      updateBulkBar();
      renderTasks(lastData.tasks);
    }
    function handleRowClick(event,taskId,rowIdx,projId){
      if(event.target.closest('a,button,.task-cb'))return;
      if(!selectionMode){
        if(event.shiftKey){
          event.preventDefault();
          enterSelectionMode();
          toggleTaskSelection(taskId,true);
          lastSelectedIdx=rowIdx;
        }else{
          openTask(taskId,projId||'');
        }
        return;
      }
      event.preventDefault();
      if(event.shiftKey&&lastSelectedIdx!==-1){
        rangeSelect(rowIdx);
      }else{
        var isChecked=selectedTaskIds.has(taskId);
        toggleTaskSelection(taskId,!isChecked);
        lastSelectedIdx=rowIdx;
        if(lastData)renderTasks(lastData.tasks);
      }
    }
    function openTask(taskId,projectId){
      currentTaskId=taskId;
      currentTaskData=null;
      fetch('/dashboard/api/task/'+encodeURIComponent(taskId)+'/read',{method:'POST'}).catch(function(){});
      document.getElementById('task-ttl').textContent='Task '+taskId;
      document.getElementById('task-badge').innerHTML='';
      document.getElementById('task-bd').innerHTML='<div class="muted" style="text-align:center;padding:32px">Loading\u2026</div>';
      document.getElementById('task-retry').style.display='none';
      document.getElementById('task-retry-now').style.display='none';
      document.getElementById('task-cancel').style.display='none';
      document.getElementById('task-edit').style.display='none';
      document.getElementById('task-continue').style.display='none';
      document.getElementById('task-prioritize').style.display='none';
      document.getElementById('task-overlay').style.display='flex';
      fetch('/dashboard/api/task/'+encodeURIComponent(taskId))
        .then(function(r){return r.json();})
        .then(function(t){
          currentTaskData=t;
          document.getElementById('task-badge').innerHTML=badge(t.status,t.completedAt);
          var active=['queued','starting','running','retrying','waiting_for_pipeline'];
          document.getElementById('task-retry').style.display=active.includes(t.status)?'none':'';
          document.getElementById('task-retry-now').style.display=(t.status==='retrying')?'':'none';
          document.getElementById('task-cancel').style.display=active.includes(t.status)?'':'none';
          document.getElementById('task-edit').style.display=(t.status==='queued'||t.status==='starting')?'':'none';
          document.getElementById('task-continue').style.display=(t.status==='completed')?'':'none';
          var priBtn=document.getElementById('task-prioritize');
          var isPrioritized=t.priority==='high'||t.priority==='critical';
          priBtn.style.display='';
          priBtn.className='btn '+(isPrioritized?'btn-depri':'btn-pri');
          priBtn.innerHTML=isPrioritized?'&#x2605; Prioritized':'&#x2605; Prioritize';
          var prsHtml='None';
          if(t.pullRequests&&t.pullRequests.length){
            prsHtml=t.pullRequests.map(function(pr){
              var num=pr.url.split('/').pop();
              var stateHtml=prStateBadge(pr.state);
              var checkedHtml=pr.lastCheckedAt?' <span class="muted" style="font-size:.72em">(checked '+fmtDate(pr.lastCheckedAt)+')</span>':'';
              return '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px">'
                +stateHtml
                +'<a href="'+esc(pr.url)+'" target="_blank" rel="noopener" class="pr-link">'+esc(pr.repo)+' #'+esc(num)+'</a>'
                +checkedHtml
                +'</span>';
            }).join('<br>');
          }
          stopRetryCountdown();
          var html='';
          html+='<div class="det-row"><div class="det-lbl">Prompt</div><div class="det-pre">'+esc(t.prompt)+'</div></div>';
          if(t.title)html+='<div class="det-row"><div class="det-lbl">Title</div><div class="det-val">'+esc(t.title)+'</div></div>';
          var prioLabel=(t.priority==='normal'||!t.priority)?'<span class="muted" style="font-size:.82rem">Normal</span>':priorityBadge(t.priority);
          html+='<div class="det-row"><div class="det-lbl">Priority</div><div class="det-val">'+prioLabel+'</div></div>';
          if(t.repoUrl){
            html+='<div class="det-row"><div class="det-lbl">Repo URL</div><div class="det-val"><a href="'+esc(t.repoUrl)+'" target="_blank" rel="noopener" class="pr-link">'+esc(t.repoUrl)+'</a></div></div>';
          }else{
            html+='<div class="det-row"><div class="det-lbl">Project</div><div class="det-val">'+esc(t.projectId)+'</div></div>';
          }
          if(t.branch)html+='<div class="det-row"><div class="det-lbl">Branch</div><div class="det-val mono">'+esc(t.branch)+'</div></div>';
          if(t.chainId)html+='<div class="det-row"><div class="det-lbl">Chain</div><div class="det-val mono">'+esc(t.chainId)+'</div></div>';
          if(t.parentTaskId)html+='<div class="det-row"><div class="det-lbl">Parent Task</div><div class="det-val mono">'+esc(t.parentTaskId)+'</div></div>';
          var attemptLabel=t.maxAttempts?('Attempt '+t.attempt+' / '+t.maxAttempts):('Attempt '+t.attempt);
          html+='<div class="det-row"><div class="det-lbl">Attempts</div><div class="det-val mono">'+esc(attemptLabel)+'</div></div>';
          if(t.status==='retrying'&&t.nextRetryAt)html+='<div class="det-row"><div class="det-lbl">Next Retry</div><div class="det-val mono"><span id="retry-countdown">…</span> &nbsp;<span class="muted" style="font-size:.8em">(at '+esc(fmtDate(t.nextRetryAt))+')</span></div></div>';
          var durationHtml=dur(t.durationSeconds);
          if(t.estimatedDurationSeconds){
            var dPct=t.durationSeconds!==null?Math.min(100,Math.round((t.durationSeconds/t.estimatedDurationSeconds)*100)):0;
            var dIsOver=dPct>=100;
            durationHtml+=' <span class="muted" style="font-size:.8em">(est. '+dur(t.estimatedDurationSeconds)+'</span>'
              +' <span style="font-size:.8em;color:'+(dIsOver?'var(--b-q-fg)':'var(--b-done-fg)')+'">'+dPct+'%</span>'
              +'<span class="muted" style="font-size:.8em">)</span>';
          }
          html+='<div class="det-row"><div class="det-lbl">Duration</div><div class="det-val mono">'+durationHtml+'</div></div>';
          if(t.startedAt){
            html+='<div class="det-row"><div class="det-lbl">Queued</div><div class="det-val mono">'+fmtDate(t.createdAt)+'</div></div>';
            html+='<div class="det-row"><div class="det-lbl">Started</div><div class="det-val mono">'+fmtDate(t.startedAt)+'</div></div>';
          }else{
            html+='<div class="det-row"><div class="det-lbl">Queued</div><div class="det-val mono">'+fmtDate(t.createdAt)+'</div></div>';
          }
          if(t.completedAt)html+='<div class="det-row"><div class="det-lbl">Completed</div><div class="det-val mono">'+fmtDate(t.completedAt)+'</div></div>';
          html+='<div class="det-row"><div class="det-lbl">Pull Requests</div><div class="det-val">'+prsHtml+'</div></div>';
          if(t.error)html+='<div class="det-row"><div class="det-lbl">Error</div><div class="det-err">'+esc(t.error)+'</div></div>';
          if(t.output)html+='<div class="det-row"><div class="det-lbl">Output</div><div class="det-pre">'+esc(t.output)+'</div></div>';
          document.getElementById('task-bd').innerHTML=html;
          if(t.status==='retrying'&&t.nextRetryAt)startRetryCountdown(t.nextRetryAt);
        })
        .catch(function(){document.getElementById('task-bd').innerHTML='<div class="det-err">Failed to load task details.</div>';});
    }
    function closeTask(){
      stopRetryCountdown();
      document.getElementById('task-overlay').style.display='none';
      currentTaskId=null;
      currentTaskData=null;
    }
    function cancelTask(){
      if(!currentTaskId)return;
      if(!confirm('Cancel task '+currentTaskId+'?'))return;
      var btn=document.getElementById('task-cancel');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          closeTask();
        })
        .catch(function(){btn.disabled=false;alert('Failed to cancel task');});
    }
    function openEditTask(){
      if(!currentTaskData)return;
      document.getElementById('et-prompt').value=currentTaskData.prompt;
      document.getElementById('et-err').style.display='none';
      document.getElementById('et-submit').disabled=false;
      document.getElementById('et-overlay').style.display='flex';
      setTimeout(function(){document.getElementById('et-prompt').focus();},50);
    }
    function closeEditTask(){document.getElementById('et-overlay').style.display='none';}
    function submitEditTask(){
      var prompt=document.getElementById('et-prompt').value.trim();
      var errEl=document.getElementById('et-err');
      errEl.style.display='none';
      if(!prompt){errEl.textContent='Prompt is required.';errEl.style.display='block';return;}
      var btn=document.getElementById('et-submit');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt})})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){errEl.textContent='Error: '+d.error;errEl.style.display='block';return;}
          closeEditTask();
          openTask(currentTaskId);
        })
        .catch(function(){btn.disabled=false;errEl.textContent='Failed to update task.';errEl.style.display='block';});
    }
    function retryTask(){
      if(!currentTaskId)return;
      if(!confirm('Retry task '+currentTaskId+'?'))return;
      var btn=document.getElementById('task-retry');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/retry',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          closeTask();
        })
        .catch(function(){btn.disabled=false;alert('Failed to retry task');});
    }
    function toggleTaskPriority(){
      if(!currentTaskId||!currentTaskData)return;
      var isPrioritized=currentTaskData.priority==='high'||currentTaskData.priority==='critical';
      var newPriority=isPrioritized?'normal':'high';
      var btn=document.getElementById('task-prioritize');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/priority',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({priority:newPriority})})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          currentTaskData.priority=newPriority;
          var nowPrioritized=newPriority==='high';
          btn.className='btn '+(nowPrioritized?'btn-depri':'btn-pri');
          btn.innerHTML=nowPrioritized?'&#x2605; Prioritized':'&#x2605; Prioritize';
          // Refresh detail body to update priority badge
          openTask(currentTaskId,currentTaskData.projectId);
        })
        .catch(function(){btn.disabled=false;alert('Failed to update priority');});
    }
    function retryNow(){
      if(!currentTaskId)return;
      var btn=document.getElementById('task-retry-now');
      btn.disabled=true;
      fetch('/dashboard/api/task/'+encodeURIComponent(currentTaskId)+'/retry-now',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          closeTask();
        })
        .catch(function(){btn.disabled=false;alert('Failed to retry task now');});
    }
    function openContinueTask(){
      if(!currentTaskData)return;
      document.getElementById('ct-taskid').textContent=currentTaskId+(currentTaskData.title?' — '+currentTaskData.title:'');
      document.getElementById('ct-prompt').value='';
      document.getElementById('ct-err').style.display='none';
      document.getElementById('ct-submit').disabled=false;
      document.getElementById('ct-overlay').style.display='flex';
      setTimeout(function(){document.getElementById('ct-prompt').focus();},50);
    }
    function closeContinueTask(){document.getElementById('ct-overlay').style.display='none';}
    function submitContinueTask(){
      var prompt=document.getElementById('ct-prompt').value.trim();
      var errEl=document.getElementById('ct-err');
      errEl.style.display='none';
      if(!prompt){errEl.textContent='Prompt is required.';errEl.style.display='block';return;}
      var btn=document.getElementById('ct-submit');
      btn.disabled=true;
      var body={projectId:currentTaskData.projectId,prompt:prompt,continueTaskId:currentTaskId};
      fetch('/dashboard/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){errEl.textContent='Error: '+d.error;errEl.style.display='block';return;}
          closeContinueTask();
          closeTask();
        })
        .catch(function(){btn.disabled=false;errEl.textContent='Failed to create continuation task.';errEl.style.display='block';});
    }
    function retryAllFailed(){
      if(!confirm('Retry all failed tasks?'))return;
      var btn=document.getElementById('retry-failed-btn');
      btn.disabled=true;
      fetch('/dashboard/api/tasks/retry-failed',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){alert('Error: '+d.error);return;}
          alert('Retried '+d.retried+' failed task(s).');
        })
        .catch(function(){btn.disabled=false;alert('Failed to retry tasks');});
    }
    function openNewTask(){
      var projects=lastData?Object.keys(lastData.projects):[];
      var sel=document.getElementById('nt-proj');
      sel.innerHTML=projects.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>';}).join('');
      if(selectedProjects.size===1){sel.value=Array.from(selectedProjects)[0];}
      document.getElementById('nt-prompt').value='';
      document.getElementById('nt-continue').value='';
      document.getElementById('nt-err').style.display='none';
      document.getElementById('nt-submit').disabled=false;
      document.getElementById('nt-overlay').style.display='flex';
      setTimeout(function(){document.getElementById('nt-prompt').focus();},50);
    }
    function closeNewTask(){document.getElementById('nt-overlay').style.display='none';}
    function submitNewTask(){
      var projectId=document.getElementById('nt-proj').value;
      var prompt=document.getElementById('nt-prompt').value.trim();
      var contId=document.getElementById('nt-continue').value.trim();
      var priority=document.getElementById('nt-priority').value||'normal';
      var errEl=document.getElementById('nt-err');
      errEl.style.display='none';
      if(!projectId||!prompt){errEl.textContent='Project and prompt are required.';errEl.style.display='block';return;}
      var body={projectId:projectId,prompt:prompt,priority:priority};
      if(contId)body.continueTaskId=contId;
      var btn=document.getElementById('nt-submit');
      btn.disabled=true;
      fetch('/dashboard/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){return r.json();})
        .then(function(d){
          btn.disabled=false;
          if(d.error){errEl.textContent='Error: '+d.error;errEl.style.display='block';return;}
          closeNewTask();
        })
        .catch(function(){btn.disabled=false;errEl.textContent='Failed to create task.';errEl.style.display='block';});
    }
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape'){
        if(voiceMode&&voiceTarget){voiceCancel();return;}
        if(voiceMode){toggleVoiceMode();return;}
        if(document.getElementById('et-overlay').style.display!=='none')closeEditTask();
        else if(document.getElementById('ct-overlay').style.display!=='none')closeContinueTask();
        else if(document.getElementById('task-overlay').style.display!=='none')closeTask();
        else if(document.getElementById('nt-overlay').style.display!=='none')closeNewTask();
        else if(selectionMode)exitSelectionMode();
      }
    });
    function refreshData(){
      var btn=document.getElementById('refresh-btn');
      if(btn.disabled)return;
      btn.disabled=true;
      btn.textContent='Refreshing\u2026';
      fetch('/dashboard/api/data')
        .then(function(r){return r.json();})
        .then(function(d){
          lastData=d;
          updatePauseUI(!!d.paused);
          renderProjects(d.projects);
          renderTasks(d.tasks);
          document.getElementById('dot').className='dot';
          document.getElementById('upd').textContent='Updated '+new Date().toLocaleTimeString();
        })
        .catch(function(){document.getElementById('dot').className='dot err';})
        .finally(function(){btn.disabled=false;btn.textContent='\u21bb Refresh';});
    }
    var es=new EventSource('/dashboard/events');
    es.onmessage=function(e){
      var d=JSON.parse(e.data);
      lastData=d;
      updatePauseUI(!!d.paused);
      renderProjects(d.projects);
      renderTasks(d.tasks);
      document.getElementById('dot').className='dot';
      document.getElementById('upd').textContent='Updated '+new Date().toLocaleTimeString();
    };
    es.onerror=function(){
      document.getElementById('dot').className='dot err';
      document.getElementById('upd').textContent='Connection lost';
    };
    function toggleFullscreen(){
      if(!document.fullscreenElement){
        document.documentElement.requestFullscreen().catch(function(e){console.warn('Fullscreen error:',e);});
      }else{
        document.exitFullscreen();
      }
    }
    function updateFullscreenBtn(){
      var btn=document.getElementById('fullscreen-btn');
      if(!btn)return;
      btn.textContent=document.fullscreenElement?'\u2715':'\u26F6';
      btn.title=document.fullscreenElement?'Exit fullscreen':'Enter fullscreen';
    }
    document.addEventListener('fullscreenchange',updateFullscreenBtn);
    /* ── Subscription limits dialog ────────────────────────────────────── */
    var subLoaded=false;
    function openUsageDialog(){
      document.getElementById('usage-overlay').style.display='';
      loadSubscriptionData();
    }
    function closeUsageDialog(){
      document.getElementById('usage-overlay').style.display='none';
      subLoaded=false;
    }
    function loadSubscriptionData(){
      var el=document.getElementById('sub-container');
      if(!el)return;
      if(subLoaded){return;}
      el.innerHTML='<div class="sub-loading">Loading subscription data&hellip;</div>';
      fetch('/dashboard/api/subscription')
        .then(function(r){
          var ct=r.headers.get('content-type')||'';
          if(!r.ok||ct.indexOf('application/json')===-1){
            return r.text().then(function(txt){
              var msg=r.status===401?'Session expired. Please refresh and log in again.'
                :r.status===404?'Subscription endpoint not available.'
                :r.status===501?'No OAuth token configured.'
                :'Server returned an unexpected response (HTTP '+r.status+').';
              throw new Error(msg);
            });
          }
          return r.json();
        })
        .then(function(d){
          subLoaded=true;
          if(d.error){
            if(d.error.indexOf('No OAuth')!==-1){
              el.innerHTML='<div class="sub-no-token">'+
                'No OAuth token available.<br><br>'+
                'Configure <code>claudeOauthRefreshToken</code> in a project\\'s <code>auth</code> section to see subscription limits.</div>';
            }else{
              el.innerHTML='<div class="sub-section"><div class="sub-header">Subscription Limits</div><div class="sub-error">'+escapeHtml(d.error)+'</div></div>';
            }
            return;
          }
          el.innerHTML=renderSubscriptionSection(d);
        })
        .catch(function(err){
          subLoaded=false;
          el.innerHTML='<div class="sub-section"><div class="sub-header">Subscription Limits</div><div class="sub-error">'+escapeHtml(err.message||'Failed to load subscription data.')+'</div></div>';
        });
    }
    function subBarColor(pct){
      if(pct<50)return 'var(--ok,#22c55e)';
      if(pct<75)return 'var(--warn,#eab308)';
      return 'var(--fail,#ef4444)';
    }
    function formatResetTime(iso){
      if(!iso)return '';
      var d=new Date(iso);
      var now=Date.now();
      var diff=d.getTime()-now;
      if(diff<=0)return 'resetting\u2026';
      var h=Math.floor(diff/3600000);
      var m=Math.floor((diff%3600000)/60000);
      if(h>24){
        var days=Math.floor(h/24);
        return 'resets in '+days+'d '+(h%24)+'h';
      }
      if(h>0)return 'resets in '+h+'h '+m+'m';
      return 'resets in '+m+'m';
    }
    function renderSubRow(label,win){
      if(!win)return '';
      var pct=Math.min(win.utilization,100);
      var color=subBarColor(win.utilization);
      var h='<div class="sub-row">';
      h+='<div class="sub-lbl">'+label+'</div>';
      h+='<div class="sub-bar-wrap">';
      h+='<div class="sub-bar"><div class="sub-bar-fill" style="width:'+pct.toFixed(1)+'%;background:'+color+'"></div></div>';
      h+='<div class="sub-pct" style="color:'+color+'">'+win.utilization.toFixed(0)+'%</div>';
      h+='</div>';
      var reset=formatResetTime(win.resetsAt);
      if(reset)h+='<div class="sub-reset">'+reset+'</div>';
      h+='</div>';
      return h;
    }
    function renderSubscriptionSection(d){
      var h='<div class="sub-section">';
      h+='<div class="sub-header">Subscription Limits<span class="sub-fetched">fetched '+new Date(d.fetchedAt).toLocaleTimeString()+'</span></div>';
      h+=renderSubRow('5-Hour',d.fiveHour);
      h+=renderSubRow('7-Day',d.sevenDay);
      h+=renderSubRow('Opus (7d)',d.sevenDayOpus);
      if(!d.fiveHour&&!d.sevenDay&&!d.sevenDayOpus){
        h+='<div style="text-align:center;color:var(--text4);font-size:.78rem;padding:8px 0">No utilization data available.</div>';
      }
      h+='</div>';
      return h;
    }
    /* ── Settings dialog ─────────────────────────────────────────────── */
    function openSettings(){
      document.getElementById('settings-overlay').style.display='';
      document.getElementById('settings-error').style.display='none';
      document.getElementById('settings-success').style.display='none';
      document.getElementById('settings-editor').value='Loading\u2026';
      document.getElementById('settings-save').disabled=true;
      document.getElementById('settings-restart').disabled=true;
      fetch('/dashboard/api/config').then(function(r){
        if(!r.ok)throw new Error('Failed to load config (HTTP '+r.status+')');
        return r.text();
      }).then(function(txt){
        document.getElementById('settings-editor').value=txt;
        document.getElementById('settings-save').disabled=false;
        document.getElementById('settings-restart').disabled=false;
      }).catch(function(err){
        document.getElementById('settings-editor').value='';
        document.getElementById('settings-error').textContent=err.message;
        document.getElementById('settings-error').style.display='';
      });
    }
    function closeSettings(){
      document.getElementById('settings-overlay').style.display='none';
    }
    function saveConfig(restart){
      var errEl=document.getElementById('settings-error');
      var okEl=document.getElementById('settings-success');
      errEl.style.display='none';
      okEl.style.display='none';
      var body=document.getElementById('settings-editor').value;
      document.getElementById('settings-save').disabled=true;
      document.getElementById('settings-restart').disabled=true;
      fetch('/dashboard/api/config',{method:'PUT',headers:{'Content-Type':'text/yaml'},body:body})
        .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}});})
        .then(function(res){
          document.getElementById('settings-save').disabled=false;
          document.getElementById('settings-restart').disabled=false;
          if(!res.ok){
            errEl.textContent=res.data.error||'Validation failed';
            errEl.style.display='';
            return;
          }
          if(restart){
            okEl.textContent='Config saved. Restarting server\u2026';
            okEl.style.display='';
            fetch('/dashboard/api/restart',{method:'POST'}).catch(function(){});
          }else{
            okEl.textContent='Config saved successfully. Changes will take effect after restart.';
            okEl.style.display='';
          }
        }).catch(function(err){
          document.getElementById('settings-save').disabled=false;
          document.getElementById('settings-restart').disabled=false;
          errEl.textContent=err.message;
          errEl.style.display='';
        });
    }

    /* ── Config editor: Tab/Enter support, line numbers, syntax highlighting ── */
    (function(){
      var ta=document.getElementById('settings-editor');
      var lnEl=document.getElementById('settings-line-nums');
      var hlEl=document.getElementById('settings-highlight');
      var scrollBox=document.getElementById('settings-editor-inner');

      /* Tab / Shift+Tab / Enter with auto-indent */
      ta.addEventListener('keydown',function(e){
        if(e.key==='Tab'){
          e.preventDefault();
          var start=ta.selectionStart,end=ta.selectionEnd,val=ta.value;
          if(start!==end&&e.shiftKey){
            /* Multi-line unindent */
            var blockStart=val.lastIndexOf('\\n',start-1)+1;
            var block=val.substring(blockStart,end);
            var lines=block.split('\\n');
            var removed=0;
            for(var li=0;li<lines.length;li++){
              var r=0;
              if(lines[li][0]===' '){r++;if(lines[li][1]===' ')r++;}
              if(r){lines[li]=lines[li].substring(r);removed+=r;}
            }
            if(removed){
              var newBlock=lines.join('\\n');
              ta.value=val.substring(0,blockStart)+newBlock+val.substring(end);
              var firstLineRemoved=0;
              var fl=block.split('\\n')[0];
              if(fl[0]===' '){firstLineRemoved++;if(fl[1]===' ')firstLineRemoved++;}
              ta.selectionStart=Math.max(blockStart,start-firstLineRemoved);
              ta.selectionEnd=blockStart+newBlock.length;
            }
          }else if(start!==end&&!e.shiftKey){
            /* Multi-line indent */
            var blockStart2=val.lastIndexOf('\\n',start-1)+1;
            var block2=val.substring(blockStart2,end);
            var newBlock2=block2.split('\\n').map(function(l){return '  '+l;}).join('\\n');
            ta.value=val.substring(0,blockStart2)+newBlock2+val.substring(end);
            ta.selectionStart=start+2;
            ta.selectionEnd=blockStart2+newBlock2.length;
          }else if(!e.shiftKey){
            /* Single cursor: insert 2 spaces */
            ta.value=val.substring(0,start)+'  '+val.substring(end);
            ta.selectionStart=ta.selectionEnd=start+2;
          }else{
            /* Single cursor shift+tab: unindent current line */
            var lineStart=val.lastIndexOf('\\n',start-1)+1;
            var rem=0;
            if(val[lineStart]===' '){rem++;if(val[lineStart+1]===' ')rem++;}
            if(rem){
              ta.value=val.substring(0,lineStart)+val.substring(lineStart+rem);
              ta.selectionStart=ta.selectionEnd=Math.max(lineStart,start-rem);
            }
          }
          ta.dispatchEvent(new Event('input'));
        }
        /* Enter: auto-indent to match current line */
        if(e.key==='Enter'){
          e.preventDefault();
          var start2=ta.selectionStart,val2=ta.value;
          var lineStart2=val2.lastIndexOf('\\n',start2-1)+1;
          var currentLine=val2.substring(lineStart2,start2);
          var indentMatch=currentLine.match(/^(\\s*)/);
          var indent=indentMatch?indentMatch[1]:'';
          /* If line ends with ':', add extra indent */
          var trimmed=val2.substring(lineStart2,start2).trimEnd();
          if(trimmed.endsWith(':'))indent+='  ';
          var insert='\\n'+indent;
          ta.value=val2.substring(0,start2)+insert+val2.substring(ta.selectionEnd);
          ta.selectionStart=ta.selectionEnd=start2+insert.length;
          ta.dispatchEvent(new Event('input'));
          /* Ensure cursor is visible after enter */
          var lineHeight=parseFloat(getComputedStyle(ta).lineHeight)||20;
          var cursorLine=(val2.substring(0,start2).match(/\\n/g)||[]).length+1;
          var cursorY=cursorLine*lineHeight;
          if(cursorY>scrollBox.scrollTop+scrollBox.clientHeight-lineHeight*2){
            scrollBox.scrollTop=cursorY-scrollBox.clientHeight+lineHeight*3;
          }
        }
      });

      /* Sync scroll: the scrollBox (.cfg-editor-inner) is the scroll container.
         The textarea is absolutely positioned inside .cfg-editor-content.
         We sync line numbers from scrollBox scroll events. */
      scrollBox.addEventListener('scroll',function(){
        lnEl.scrollTop=scrollBox.scrollTop;
      });

      /* Update line numbers */
      function updateLineNums(text){
        var count=(text.match(/\\n/g)||[]).length+1;
        var h='';
        for(var i=1;i<=count;i++) h+='<span>'+i+'</span>';
        lnEl.innerHTML=h;
      }

      /* Simple YAML syntax highlighting */
      function highlightYaml(text){
        var s=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var lines=s.split('\\n');
        for(var i=0;i<lines.length;i++){
          var line=lines[i];
          /* Empty lines */
          if(!line.trim()){continue;}
          /* Comments */
          if(/^\\s*#/.test(line)){lines[i]='<span class="cfg-hl-comment">'+line+'</span>';continue;}
          /* Key: value lines */
          var m=line.match(/^(\\s*)(- )?(\\s*)([^:#\\s][^:]*?)(:\\s*)(.*)?$/);
          if(m){
            var pre=m[1]||'';
            var dash=m[2]?'<span class="cfg-hl-dash">'+m[2]+'</span>':'';
            var sp=m[3]||'';
            var key='<span class="cfg-hl-key">'+m[4]+'</span>';
            var colon=m[5];
            var val=m[6]||'';
            val=colorVal(val);
            lines[i]=pre+dash+sp+key+colon+val;
            continue;
          }
          /* List items without key */
          var m2=line.match(/^(\\s*)(- )(.*)?$/);
          if(m2){
            var val2=m2[3]||'';
            val2=colorVal(val2);
            lines[i]=m2[1]+'<span class="cfg-hl-dash">'+m2[2]+'</span>'+val2;
            continue;
          }
        }
        return lines.join('\\n')+'\\n';
      }
      function colorVal(v){
        if(!v)return v;
        var ic=v.match(/^(.*?)(\\s+#.*)$/);
        var comment='';
        if(ic){v=ic[1];comment='<span class="cfg-hl-comment">'+ic[2]+'</span>';}
        if(/^(true|false|yes|no|on|off)$/i.test(v)) return '<span class="cfg-hl-bool">'+v+'</span>'+comment;
        if(/^(null|~)$/i.test(v)) return '<span class="cfg-hl-null">'+v+'</span>'+comment;
        if(/^-?[0-9]+(\\.[0-9]+)?$/.test(v)) return '<span class="cfg-hl-number">'+v+'</span>'+comment;
        if(/^["']/.test(v)) return '<span class="cfg-hl-string">'+v+'</span>'+comment;
        return v+comment;
      }

      /* Update highlight + line nums on input */
      ta.addEventListener('input',function(){
        hlEl.innerHTML=highlightYaml(ta.value);
        updateLineNums(ta.value);
      });

      /* Observe value changes (e.g. when config is loaded via JS) */
      var origDesc=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
      Object.defineProperty(ta,'value',{
        get:function(){return origDesc.get.call(this);},
        set:function(v){origDesc.set.call(this,v);hlEl.innerHTML=highlightYaml(v);updateLineNums(v);}
      });
    })();

    ${VOICE_MODE_JS}
    ${THEME_TOGGLE_JS}
  </script>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const DASH_COOKIE = "impl_dash";

export function registerDashboardRoutes(
    app: express.Express,
    taskManager: TaskManager,
    config: Config
): void {
    const adminPassword = config.server.adminPassword;

    // GET /dashboard — login form or live dashboard
    app.get("/dashboard", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml());
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(dashboardHtml(true));
    });

    app.post("/dashboard", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        const password =
            typeof req.body?.password === "string" ? req.body.password : "";
        if (password === adminPassword) {
            const token = dashboardToken(adminPassword);
            res.setHeader(
                "Set-Cookie",
                `${DASH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`
            );
            res.redirect("/dashboard");
        } else {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(loginHtml(true));
        }
    });

    // Logout is always available — just clears the cookie
    app.get("/dashboard/logout", (_req, res) => {
        res.setHeader(
            "Set-Cookie",
            `${DASH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
        );
        res.redirect("/dashboard");
    });

    app.get("/dashboard/events", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).send("Unauthorized");
            return;
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const send = () =>
            res.write(
                `data: ${JSON.stringify(buildDashboardData(taskManager, config))}\n\n`
            );
        send();
        const interval = setInterval(send, 3000);
        req.on("close", () => clearInterval(interval));
    });

    app.get("/dashboard/api/data", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        res.json(buildDashboardData(taskManager, config));
    });

    app.get("/dashboard/api/task/:taskId", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.id === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        res.json({
            taskId: task.id,
            projectId: task.data.projectId,
            repoUrl: task.data.repoUrl ?? null,
            branch: task.branch?.name ?? null,
            prompt: task.data.prompt,
            title: task.title ?? null,
            parentTaskId: task.data.parentTaskId ?? null,
            chainId: task.data.chainId ?? null,
            status: task.data.status,
            priority: task.data.priority ?? "normal",
            attempt: task.data.attempt,
            maxAttempts:
                task.project.data.errorRetry?.maxAttempts ?? null,
            nextRetryAt: task.data.nextRetryAt ?? null,
            createdAt: task.data.createdAt,
            startedAt: task.data.startedAt ?? null,
            completedAt: task.data.completedAt,
            durationSeconds:
                task.data.status === "queued"
                    ? null
                    : Math.round(
                          ((task.data.completedAt
                              ? new Date(task.data.completedAt).getTime()
                              : Date.now()) -
                              new Date(
                                  task.data.startedAt ?? task.data.createdAt
                              ).getTime()) /
                              1000
                      ),
            estimatedDurationSeconds:
                task.data.estimatedDurationSeconds ?? null,
            output:
                task.data.status === "queued" ||
                task.data.status === "starting" ||
                task.data.status === "running" ||
                task.data.status === "retrying" ||
                task.data.status === "interrupted"
                    ? null
                    : extractLastAssistantMessage(task.data.output) || null,
            error: task.data.error ?? null,
            pullRequests: task.data.pullRequests ?? null
        });
    });

    app.post("/dashboard/api/task", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const { projectId, prompt, continueTaskId } = req.body ?? {};
        if (
            typeof projectId !== "string" ||
            !config.projects[projectId as ProjectId]
        ) {
            res.status(400).json({ error: "Invalid or missing project ID" });
            return;
        }
        if (typeof prompt !== "string" || !prompt.trim()) {
            res.status(400).json({ error: "Prompt is required" });
            return;
        }
        const contId =
            typeof continueTaskId === "string" && continueTaskId.trim()
                ? continueTaskId.trim()
                : undefined;
        try {
            const task = taskManager.createNewTask(
                projectId as ProjectId,
                {
                    prompt: prompt.trim(),
                    continueTaskId: contId as TaskId | undefined
                }
            );
            res.json({
                taskId: task.id,
                branch: task.branch,
                status: task.data.status
            });
        } catch (err) {
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.post("/dashboard/api/task/:taskId/cancel", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.id === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        const cancelled = await taskManager.cancelTask(
            task.data.projectId,
            task.id
        );
        res.json({
            taskId: cancelled.id,
            branch: cancelled.branch,
            status: cancelled.data.status
        });
    });

    app.post("/dashboard/api/task/:taskId/retry", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.id === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        try {
            const retried = taskManager.retryTask(
                task.data.projectId,
                task.id
            );
            res.json({
                taskId: retried.id,
                branch: retried.branch,
                status: retried.data.status
            });
        } catch (err) {
            if (err instanceof TaskActiveError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.post("/dashboard/api/task/:taskId/retry-now", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.id === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        try {
            const retried = taskManager.retryTask(
                task.data.projectId,
                task.id
            );
            res.json({
                taskId: retried.id,
                branch: retried.branch,
                status: retried.data.status
            });
        } catch (err) {
            if (err instanceof TaskActiveError) {
                res.status(409).json({ error: err.message });
                return;
            }
            res.status(500).json({
                error:
                    err instanceof Error ? err.message : "Internal server error"
            });
        }
    });

    app.post("/dashboard/api/task/:taskId/read", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        try {
            const task = taskManager.markTaskRead(
                req.params.taskId as TaskId
            );
            res.json({ taskId: task.id, readAt: task.data.readAt });
        } catch {
            res.status(404).json({ error: "Task not found" });
        }
    });

    app.post("/dashboard/api/tasks/retry-failed", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const failedTasks = taskManager
            .listAllTasks()
            .filter((t) => t.data.status === "failed");
        const results = await Promise.allSettled(
            failedTasks.map((t) =>
                Promise.resolve(
                    taskManager.retryTask(t.data.projectId, t.id)
                )
            )
        );
        const retried = results.filter((r) => r.status === "fulfilled").length;
        const errors = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) =>
                r.reason instanceof Error ? r.reason.message : "Unknown error"
            );
        res.json({ retried, errors });
    });

    app.post("/dashboard/api/tasks/bulk-cancel", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const { taskIds } = req.body ?? {};
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            res.status(400).json({ error: "taskIds array is required" });
            return;
        }
        const allTasks = taskManager.listAllTasks();
        const tasksById = new Map(allTasks.map((t) => [t.id, t]));
        const results = await Promise.allSettled(
            taskIds.map(async (id: string) => {
                const task = tasksById.get(id as TaskId);
                if (!task) throw new Error(`Task ${id} not found`);
                return taskManager.cancelTask(task.data.projectId, task.id);
            })
        );
        const succeeded = results.filter(
            (r) => r.status === "fulfilled"
        ).length;
        const errors = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) =>
                r.reason instanceof Error ? r.reason.message : "Unknown error"
            );
        res.json({ succeeded, failed: errors.length, errors });
    });

    // PATCH /dashboard/api/task/:taskId — edit a queued task's prompt
    app.patch("/dashboard/api/task/:taskId", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const task = taskManager
            .listAllTasks()
            .find((t) => t.id === req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        const { prompt } = req.body ?? {};
        if (typeof prompt !== "string" || !prompt.trim()) {
            res.status(400).json({ error: "Prompt is required" });
            return;
        }
        if (task.data.status !== "queued" && task.data.status !== "starting") {
            res.status(409).json({ error: "Only queued or starting tasks can be edited" });
            return;
        }
        task.data.prompt = prompt.trim();
        task.tickUpdate();
        res.json({ taskId: task.id, prompt: task.data.prompt });
    });

    // POST /dashboard/api/task/:taskId/priority — update task priority
    app.post("/dashboard/api/task/:taskId/priority", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const { priority } = req.body ?? {};
        const validPriorities = ["low", "normal", "high", "critical"];
        if (typeof priority !== "string" || !validPriorities.includes(priority)) {
            res.status(400).json({ error: "priority must be one of: low, normal, high, critical" });
            return;
        }
        try {
            const task = taskManager.setTaskPriority(
                req.params.taskId as TaskId,
                priority as import("./types.js").TaskPriority
            );
            res.json({ taskId: task.id, priority: task.data.priority });
        } catch {
            res.status(404).json({ error: "Task not found" });
        }
    });

    // GET /dashboard/api/subscription — fetch subscription utilization via OAuth
    app.get("/dashboard/api/subscription", async (req, res) => {
        try {
            if (!adminPassword) {
                res.status(404).json({ error: "Not Found" });
                return;
            }
            if (!isDashboardAuthenticated(req, adminPassword)) {
                res.status(401).json({ error: "Unauthorized" });
                return;
            }

            // Find the first project with an OAuth token (refresh or static)
            let oauthToken: string | null = null;
            for (const project of Object.values(config.projects)) {
                const auth = project.data.auth;
                if (auth?.claudeOauthRefreshToken || auth?.claudeOauthToken) {
                    try {
                        const creds =
                            await project.tokenManager.getCredentials();
                        if (creds.envName === "CLAUDE_CODE_OAUTH_TOKEN") {
                            oauthToken = creds.value;
                            break;
                        }
                    } catch {
                        // This project's token failed, try next
                    }
                }
            }

            if (!oauthToken) {
                res.status(501).json({
                    error: "No OAuth token available. Configure claudeOauthRefreshToken in a project's auth section."
                });
                return;
            }

            const data = await fetchSubscriptionUsage(oauthToken);
            res.json(data);
        } catch (err) {
            console.error("Failed to fetch subscription usage:", err);
            if (!res.headersSent) {
                res.status(502).json({
                    error:
                        err instanceof Error
                            ? err.message
                            : "Failed to fetch subscription usage"
                });
            }
        }
    });

    // POST /dashboard/api/pause — pause queue processing
    app.post("/dashboard/api/pause", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        taskManager.pause();
        res.json({ paused: true });
    });

    // POST /dashboard/api/resume — resume queue processing
    app.post("/dashboard/api/resume", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        taskManager.resume();
        res.json({ paused: false });
    });

    app.post("/dashboard/api/tasks/bulk-retry", async (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        const { taskIds } = req.body ?? {};
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            res.status(400).json({ error: "taskIds array is required" });
            return;
        }
        const allTasks = taskManager.listAllTasks();
        const tasksById = new Map(allTasks.map((t) => [t.id, t]));
        const results = await Promise.allSettled(
            taskIds.map(async (id: string) => {
                const task = tasksById.get(id as TaskId);
                if (!task) throw new Error(`Task ${id} not found`);
                return taskManager.retryTask(task.data.projectId, task.id);
            })
        );
        const succeeded = results.filter(
            (r) => r.status === "fulfilled"
        ).length;
        const errors = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) =>
                r.reason instanceof Error ? r.reason.message : "Unknown error"
            );
        res.json({ succeeded, failed: errors.length, errors });
    });

    // GET /dashboard/api/config — read config.yaml as raw text
    app.get("/dashboard/api/config", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        try {
            const content = readFileSync(config.configPath, "utf-8");
            res.setHeader("Content-Type", "text/yaml; charset=utf-8");
            res.send(content);
        } catch (err) {
            res.status(500).json({
                error: `Failed to read config: ${err instanceof Error ? err.message : String(err)}`
            });
        }
    });

    // PUT /dashboard/api/config — validate and write config.yaml
    app.put("/dashboard/api/config", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        // Read raw body as text (Content-Type: text/yaml)
        let rawYaml: string;
        if (typeof req.body === "string") {
            rawYaml = req.body;
        } else if (Buffer.isBuffer(req.body)) {
            rawYaml = req.body.toString("utf-8");
        } else {
            res.status(400).json({ error: "Expected raw YAML text in request body" });
            return;
        }

        // Validate YAML syntax
        let parsed: unknown;
        try {
            parsed = yaml.load(rawYaml);
        } catch (yamlErr) {
            res.status(400).json({
                error: `Invalid YAML syntax: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`
            });
            return;
        }

        // Validate against config schema
        try {
            ConfigSchema.parse(parsed);
        } catch (zodErr: any) {
            const issues = zodErr.issues
                ? zodErr.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("\n")
                : String(zodErr);
            res.status(400).json({ error: `Config validation failed:\n${issues}` });
            return;
        }

        // Write to disk
        try {
            writeFileSync(config.configPath, rawYaml, "utf-8");
        } catch (err) {
            res.status(500).json({
                error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`
            });
            return;
        }

        res.json({ ok: true });
    });

    // POST /dashboard/api/restart — graceful process restart
    app.post("/dashboard/api/restart", (req, res) => {
        if (!adminPassword) {
            res.status(404).send("Not Found");
            return;
        }
        if (!isDashboardAuthenticated(req, adminPassword)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        res.json({ ok: true, message: "Restarting..." });
        // Delay exit slightly so the response is sent
        setTimeout(() => {
            console.log("[dashboard] Restart requested via admin dashboard — exiting process.");
            process.exit(0);
        }, 500);
    });
}
