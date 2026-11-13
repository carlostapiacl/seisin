(function(){
  "use strict";

  /* ── the example ──────────────────────────────────────────────────────────
   * Opened as a file there is no server, so the page shows an example. It used
   * to be three unrelated lists — a policy, five log lines, and nothing else —
   * so Activity showed denials while the KPIs said none and Waiting on you was
   * empty. Now the example is a log and a queue, and every screen is computed
   * from them by the same functions that draw the live state (demoState below).
   * All of it is illustrative: the names are made up. */
  var DEMO = {
    keys: ["netlify-token", "database-url", "sentry-dsn", "registry-token", "cloud-token"],
    roles: [
      {name:"frontend", writes:["src/web/**","public/**"], keys:["netlify-token"], controlFiles:["ide"]},
      {name:"backend",  writes:["src/api/**","migrations/**"], keys:["database-url","sentry-dsn"]},
      {name:"docs",     writes:["docs/**","README.md"], keys:[]},
      {name:"release",  writes:[".github/**"], keys:["registry-token","cloud-token"]}
    ],
    // [minutes ago, role, action, target, verdict, kind, source]
    log: [
      [240,"backend","write","migrations/014_stock.sql","allowed"],
      [200,"frontend","write","src/web/App.tsx","allowed"],
      [190,"backend","write",".git/index.lock","denied"],
      [188,"backend","write",".git/index.lock","denied"],
      [150,"frontend","write","src/api/orders.ts","denied"],
      [149,"frontend","write","src/api/orders.ts","denied"],
      [140,"backend","connect","api.stripe.com:443","denied","network","kernel"],
      [121,"backend","write",".env.local","denied"],
      [120,"backend","write",".env.local","denied"],
      [118,"backend","write",".env.local","denied"],
      [95,"frontend","write","dist/index.html","denied"],
      [94,"frontend","write","dist/index.html","denied"],
      [80,"docs","write","CHANGELOG.md","denied"],
      [70,"docs","use","mcp__github__create_issue","denied","tool"],
      [61,"release","read",".secrets/database-url","denied","key"],
      [60,"backend","write",".git/index.lock","denied"],
      [45,"frontend","write","src/api/orders.ts","denied"],
      [44,"frontend","write","src/web/Cart.tsx","allowed"],
      [30,"docs","write","src/api/orders.ts","denied"],
      [21,"frontend","write","scripts/deploy.sh","denied","file","kernel"],
      [12,"release","write","docs/release-notes.md","denied"],
      [9,"frontend","write","src/api/orders.ts","denied"],
      [4,"frontend","write","src/web/Header.tsx","allowed"]
    ],
    requests: [
      {role:"frontend", action:"write", target:"src/api/orders.ts", grant:"src/api/**", times:4, first:150},
      {role:"docs", action:"write", target:"CHANGELOG.md", grant:"CHANGELOG.md", times:1, first:80},
      {role:"release", action:"write", target:"docs/release-notes.md", grant:"docs/**", times:1, first:12}
    ]
  };

  var KEYS = DEMO.keys.slice();
  var ROLES = [];
  var KEYDIR = ".secrets";
  // `[protect]` and the hash of the policy text the console last read, which a
  // control-files save sends back so a file that moved in between is refused.
  var PROTECT = { instructions: false };
  var BASE = null;
  var ROOT = "";
  var sel = "frontend";

  function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  // For attribute values: the text an agent chose (a request's id is its path)
  // must not be able to close the quote it sits in.
  function escA(s){return esc(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
  function pad(n){return String(n).padStart(2,"0");}
  function plural(n, one, many){ return n.toLocaleString() + " " + (n === 1 ? one : (many || one + "s")); }

  /** "3 min ago · 14:02", with the exact instant in the tooltip. */
  function when(iso){
    var t = Date.parse(iso);
    if (isNaN(t)) return { text: "", title: "" };
    var d = new Date(t), s = Math.max(0, (Date.now() - t) / 1000);
    var ago = s < 45 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" :
              s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago";
    var clock = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (s >= 86400) clock = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + clock;
    return { text: ago + " · " + clock, title: d.toISOString() };
  }

  function theme(v){
    var r=document.documentElement;
    if(v==="auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme",v);
    [["light","light"],["dark","dark"],["auto","auto"]].forEach(function(p){
      var b=document.getElementById("t-"+p[0]);
      b.classList.toggle("on", v===p[1]);
      b.setAttribute("aria-pressed", v===p[1] ? "true" : "false");
    });
  }
  document.getElementById("t-light").onclick=function(){theme("light");};
  document.getElementById("t-dark").onclick=function(){theme("dark");};
  document.getElementById("t-auto").onclick=function(){theme("auto");};

  /** A change made in the example, written into the example's log. */
  function note(act, target){
    DEMO.log.push([new Date(), "you", act, target, "admin"]);
    demoRefresh();
  }

  /* ── the example, computed the way the server computes the live state ── */

  /** What kind of thing an unowned path is — kinds.js's own sentences, word for word. */
  var KIND_HINTS = {
    credential: "credential-shaped: never grant a write to it; if a role needs to read it, declare it as a key",
    git: "git's own bookkeeping, not territory: grant the repository to the role that runs git there, never the file",
    temporary: "temporary files a tool or a test makes while it runs: point it at $TMPDIR (already writable through [runtime] writes), or fix it; do not grant it in the repo",
    build: "build output or installed dependencies: grant the folder to the role that builds it, or build outside the repo",
    territory: "an ownable path no role claims: a real decision — give it an owner, or tell the agent not to write there"
  };
  function demoKind(p){
    var name = p.split("/").pop();
    if (p.indexOf(KEYDIR + "/") === 0 || /^\.env(\..+)?$/.test(name)) return "credential";
    if (/(^|\/)\.git(\/|$)/.test(p)) return "git";
    if (/(^|\/)(tmp|\.cache)\//.test(p) || /\.(tmp|log|lock)$/.test(name)) return "temporary";
    if (/(^|\/)(dist|build|node_modules)\//.test(p)) return "build";
    return "territory";
  }
  function covers(glob, p){
    if (/\/\*\*$/.test(glob)) { var d = glob.slice(0, -3); return p === d || p.indexOf(d + "/") === 0; }
    return glob === p;
  }
  function ownersIn(roles, p){ return roles.filter(function(r){ return r.writes.some(function(g){ return covers(g, p); }); }).map(function(r){ return r.name; }); }

  function demoState(){
    var now = Date.now();
    var roles = ROLES.length ? ROLES : DEMO.roles.map(function(r){ return Object.assign({ sandbox: true, controlFiles: [] }, r, { writes: r.writes.slice(), keys: r.keys.slice() }); });
    var entries = DEMO.log.map(function(x){
      var about = x[5] || "file";
      return { at: new Date(x[0] instanceof Date ? x[0] : now - x[0] * 6e4).toISOString(), role: x[1], action: x[2], target: x[3],
               verdict: x[4], kind: about, source: x[6],
               owners: about === "file" ? ownersIn(roles, x[3]) : [] };
    });
    var denied = entries.filter(function(e){ return e.verdict === "denied"; });
    var still = function(role, e){
      var r = roles.filter(function(x){ return x.name === role; })[0];
      if (!r) return false;
      if (e.kind === "key") return r.keys.indexOf(e.target.split("/").pop()) === -1;
      if (e.kind !== "file") return true;
      return !r.writes.some(function(g){ return covers(g, e.target); });
    };
    var by = {}, fams = {}, about = { file:{paths:0,denials:0}, key:{paths:0,denials:0}, network:{paths:0,denials:0}, tool:{paths:0,denials:0} };
    denied.forEach(function(e){
      var k = e.action + "\u0000" + e.target;
      var g = by[k] || (by[k] = { about: e.kind, action: e.action, target: e.target, times: 0, roles: [], owners: e.owners });
      g.times++; if (g.roles.indexOf(e.role) === -1) g.roles.push(e.role);
    });
    var groups = Object.keys(by).map(function(k){ return by[k]; });
    var total = denied.length, unowned = 0, kinds = {};
    Object.keys(KIND_HINTS).forEach(function(k){ kinds[k] = { paths: 0, denials: 0 }; });
    groups.forEach(function(g){
      about[g.about].paths++; about[g.about].denials += g.times;
      g.share = g.times / total;
      g.stillDenied = g.roles.filter(function(r){ return still(r, g); }).length;
      if (g.about !== "file") { g.standing = "outside"; return; }
      if (g.owners.length) { g.standing = "owned"; return; }
      g.standing = "unowned"; unowned++;
      g.kind = demoKind(g.target); g.hint = KIND_HINTS[g.kind];
      kinds[g.kind].paths++; kinds[g.kind].denials += g.times;
    });
    groups.forEach(function(g){
      var name = g.target.split("/").pop();
      var f = fams[name] || (fams[name] = { name: name, times: 0, paths: 0, where: [], roles: [] });
      f.times += g.times; f.paths++; f.where.push({ target: g.target, times: g.times });
      g.roles.forEach(function(r){ if (f.roles.indexOf(r) === -1) f.roles.push(r); });
    });
    var families = Object.keys(fams).map(function(k){ var f = fams[k]; f.share = f.times / total; return f; })
      .sort(function(a, b){ return b.times - a.times; });
    groups.sort(function(a, b){ return b.times - a.times; });

    var walls = {};
    roles.forEach(function(r){
      var mine = {};
      denied.forEach(function(e){
        if (e.role !== r.name) return;
        var k = e.action + "\u0000" + e.target;
        (mine[k] = mine[k] || { e: e, times: 0 }).times++;
      });
      var list = Object.keys(mine).map(function(k){ return mine[k]; })
        .filter(function(w){ return w.times >= 2 && still(r.name, w.e); })
        .map(function(w){
          var x = { action: w.e.action, target: w.e.target, times: w.times, retried: w.times - 1,
                    owners: w.e.owners, about: w.e.kind, reason: "" };
          if (x.about === "file" && !x.owners.length) { x.standing = "unowned"; x.kind = demoKind(x.target); x.hint = KIND_HINTS[x.kind]; }
          return x;
        }).sort(function(a, b){ return b.times - a.times; });
      if (list.length) walls[r.name] = list;
    });

    return {
      live: false,
      allKeys: DEMO.keys,
      protect: PROTECT,
      roles: roles.map(function(r){
        return { name: r.name, writes: r.writes.slice(), keys: r.keys.slice(), sandbox: r.sandbox !== false,
                 controlFiles: (r.controlFiles || []).slice(), neverWrites: [],
                 blocks: denied.filter(function(e){ return e.role === r.name; }).length };
      }),
      requests: DEMO.requests.map(function(q){
        var owners = ownersIn(roles, q.target);
        return Object.assign({ key: q.role + ":" + q.action + ":" + q.target, owners: owners,
                               handoffNote: demoHandoff(q, owners),
                               last: new Date(now - q.first * 6e4).toISOString() }, q);
      }),
      causes: { total: total, distinct: groups.length, unowned: unowned, about: about,
                standing: { unowned: { paths: unowned, kinds: kinds } },
                families: families.slice(0, 8), causes: groups },
      walls: walls,
      log: entries.slice().reverse()
    };
  }

  /** Where an example request goes. Live, the server says it (handoff.js); the example has no
   *  server, so it says the three cases its requests can reach, in the same words. */
  function demoHandoff(q, owners){
    if (owners.length === 1) return owners[0] === q.role
      ? "no handoff needed — the policy moved and " + q.role + " has it now" : "handed to " + owners[0];
    return owners.length ? "a person decides: more than one role owns this (" + owners.join(", ") + ")"
                         : "a person decides: no role owns this";
  }

  /** The example's state again, after a change made in it. */
  function demoRefresh(){ if (!LIVE) applyState(demoState()); }

  /* ── roles ────────────────────────────────────────────────────────────── */

  /** Above this many paths the territory cell folds into folder counts. Four is what fits on
   *  one line at the narrowest column this table is allowed to reach. */
  var FOLD_AT=4;
  /** Which roles the reader has unfolded. Kept outside `draw` so a poll every two seconds
   *  does not close a list someone is reading — the rule this file opens with. */
  var OPEN={};
  var FILTER="";

  /** Paths grouped by the folder that holds them, biggest group first. */
  function byFolder(paths){
    var m={};
    paths.forEach(function(p){
      var dir=p.replace(/\/\*\*$/,"").replace(/\/[^/]*$/,"")||"/";
      (m[dir]=m[dir]||[]).push(p);
    });
    return Object.keys(m).map(function(d){return {dir:d+"/",n:m[d].length,paths:m[d]};})
                 .sort(function(a,b){return b.n-a.n||a.dir.localeCompare(b.dir);});
  }

  /** Does this role match what was typed? Name OR any path it writes. */
  function hits(r,q){
    if(!q) return true;
    q=q.toLowerCase();
    if(r.name.toLowerCase().indexOf(q)!==-1) return true;
    return r.writes.some(function(p){return p.toLowerCase().indexOf(q)!==-1;});
  }

  /**
   * The roles table.
   *
   * Live, it is read-only. It used to offer × on every path, "+ folder" and key
   * toggles against a real repo, and every one of those edits was thrown away on
   * the next poll without a word — a page that looks like it saved and did not.
   * Live, the only writes are a decision on a request and a control-files save;
   * territories and keys are changed in seisin.toml. In the example the table
   * stays editable, under a banner that says nothing is saved.
   */
  function drawRows(){
    var tb=document.getElementById("rows"); tb.textContent="";
    var shown=ROLES.filter(function(r){return hits(r,FILTER);});
    var cuenta=document.getElementById("f-hits");
    if(cuenta) cuenta.textContent=FILTER?(shown.length+" of "+ROLES.length):"";
    var vacio=document.getElementById("nohits");
    if(vacio) vacio.hidden=!(FILTER&&!shown.length);
    if(vacio&&FILTER&&!shown.length)
      vacio.innerHTML="No role writes anything matching <b>"+esc(FILTER)+"</b>. "+
                      "If an agent needs it, that is a request nobody can grant yet — "+
                      "no role owns the path.";
    document.getElementById("roles-note").textContent = LIVE
      ? "read-only here — change territories and keys in seisin.toml"
      : "example — edits stay in this page";

    shown.forEach(function(r){
      var tr=document.createElement("tr");
      tr.className=(r.sandbox?"g":"a")+(r.name===sel?" on":"");

      var c1=document.createElement("td"); c1.className="role"; c1.setAttribute("data-label","role");
      var rb=document.createElement("button"); rb.type="button";
      rb.innerHTML="<i aria-hidden=\"true\">●</i>"+esc(r.name);
      rb.setAttribute("aria-pressed", r.name===sel ? "true" : "false");
      rb.setAttribute("aria-label", r.name+" — show its control files and sandbox settings");
      rb.onclick=function(){sel=r.name;drawRows();drawCfg();drawControls();};
      c1.appendChild(rb); tr.appendChild(c1);

      var c2=document.createElement("td"); c2.className="terr"; c2.setAttribute("data-label","writes");
      var t2=document.createElement("div"); t2.className="tags";
      function tagFor(p,i){
        var s=document.createElement("span"); s.className="tag w"; s.textContent=p;
        if (LIVE) return s;
        var x=document.createElement("button"); x.type="button"; x.className="x"; x.textContent="×";
        x.setAttribute("aria-label","Remove "+p+" from "+r.name);
        x.onclick=function(){r.writes.splice(i,1);note("removed folder",r.name+" ✕ "+p);};
        s.appendChild(x); return s;
      }
      if(r.writes.length<=FOLD_AT||OPEN[r.name]){
        r.writes.forEach(function(p,i){ t2.appendChild(tagFor(p,i)); });
        if(r.writes.length>FOLD_AT){
          var less=document.createElement("button"); less.type="button"; less.className="more";
          less.textContent="show folders"; less.onclick=function(){OPEN[r.name]=false;drawRows();};
          t2.appendChild(less);
        }
      }else{
        byFolder(r.writes).forEach(function(f){
          var s=document.createElement("button"); s.type="button"; s.className="tag fold";
          s.innerHTML=esc(f.dir)+" <b>"+f.n+"</b>";
          s.title=f.paths.slice(0,12).join("\n")+(f.n>12?"\n… and "+(f.n-12)+" more":"");
          s.onclick=function(){OPEN[r.name]=true;drawRows();};
          t2.appendChild(s);
        });
        var more=document.createElement("button"); more.type="button"; more.className="more";
        more.textContent="show all "+r.writes.length+" paths";
        more.onclick=function(){OPEN[r.name]=true;drawRows();};
        t2.appendChild(more);
      }
      if (!r.writes.length) { var none=document.createElement("span"); none.className="ro"; none.textContent="no territory"; t2.appendChild(none); }
      if (!LIVE) {
        var add=document.createElement("button"); add.type="button"; add.className="add"; add.textContent="+ folder";
        add.onclick=function(){
          var v=prompt("Path from the repo root, with /** for the subtree:","src/");
          if(v&&v.trim()){r.writes.push(v.trim());note("added folder",r.name+" + "+v.trim());}
        };
        t2.appendChild(add);
      }
      c2.appendChild(t2); tr.appendChild(c2);

      var c3=document.createElement("td"); c3.setAttribute("data-label","keys");
      var t3=document.createElement("div"); t3.className="tags";
      if (LIVE) {
        r.keys.forEach(function(k){ var s=document.createElement("span"); s.className="tag"; s.textContent=k; t3.appendChild(s); });
        if (!r.keys.length) { var nk=document.createElement("span"); nk.className="ro"; nk.textContent="none"; t3.appendChild(nk); }
      } else KEYS.forEach(function(k){
        var on=r.keys.indexOf(k)!==-1;
        var b=document.createElement("button"); b.type="button"; b.className="tag"; b.textContent=k;
        b.setAttribute("aria-pressed",on?"true":"false");
        b.setAttribute("aria-label",k+" — "+(on?"held by ":"not held by ")+r.name);
        b.onclick=function(){
          if(on) r.keys.splice(r.keys.indexOf(k),1); else r.keys.push(k);
          note(on?"removed key":"added key",r.name+(on?" ✕ ":" + ")+k);
        };
        t3.appendChild(b);
      });
      c3.appendChild(t3); tr.appendChild(c3);

      var c4=document.createElement("td"); c4.className="st"; c4.setAttribute("data-label","confined");
      if (LIVE) {
        // The last canary is evidence from a run, not a promise inferred from the policy.
        if (r.canary) {
          var passed=r.canary.confined===true;
          c4.innerHTML='<span class="state" title="'+(passed?'Last canary passed':'Last canary failed')+'"><i></i>'+
            (passed?'canary passed':'canary failed')+'</span>';
          if(!passed)c4.querySelector(".state").classList.add("warn");
        } else c4.innerHTML='<span class="state" title="No run has recorded a canary yet"><i></i>not run</span>';
      } else {
        var sw=document.createElement("button"); sw.type="button"; sw.className="sw";
        var txt=r.sandbox?"confined":"unconfined";
        sw.setAttribute("data-on",r.sandbox?"true":"false");
        sw.setAttribute("aria-pressed",r.sandbox?"true":"false");
        sw.setAttribute("aria-label",txt+" — "+r.name);
        sw.title = r.sandbox ? "The OS enforces this role's territory" : "Unconfined: nothing stops a write outside its territory";
        sw.innerHTML="<i></i>"+txt;
        sw.onclick=function(){ r.sandbox=!r.sandbox; note(r.sandbox?"confined":"unconfined",r.name); };
        c4.appendChild(sw);
      }
      tr.appendChild(c4);

      var c5=document.createElement("td"); c5.className="num"; c5.setAttribute("data-label","denials");
      c5.innerHTML=r.blocks?'<span style="color:var(--amber);font-weight:600">'+r.blocks+"</span>"
                           :'<span style="color:var(--dim)">—</span>';
      tr.appendChild(c5);

      tb.appendChild(tr);
    });

  }

  function drawCfg(){
    var r=ROLES.filter(function(x){return x.name===sel;})[0];
    if(!r){
      document.getElementById("cfg-title").textContent=".seisin/….json";
      document.getElementById("cfg").textContent =
        ROLES.length ? "pick a role above" : "no roles in this policy";
      return;
    }
    document.getElementById("cfg-title").textContent=".seisin/"+r.name+".json";
    document.getElementById("cfg-note").textContent = LIVE
      ? "what seisin hands the runtime for the selected role"
      : "illustrative — the shape of what seisin hands the runtime, from the example";
    if(LIVE){
      var got=SETTINGS[r.name];
      if(!got){ document.getElementById("cfg").textContent="reading "+r.name+"’s settings…"; loadSettings(r.name); return; }
      if(got.error){ document.getElementById("cfg").textContent=got.error; return; }
      document.getElementById("cfg").innerHTML=
        '<span class="c">// seisin run '+esc(r.name)+' -- claude -p "…"</span>\n'+
        esc(JSON.stringify(got.settings,null,2)).replace(/^(\s*)("[^"\n]*")(:)/gm,'$1<span class="k">$2</span>$3');
      return;
    }
    var L=[];
    L.push('<span class="c">// illustrative: seisin run '+esc(r.name)+' -- claude -p "…"</span>');
    if(!r.sandbox){
      L.push('<span class="d">// UNCONFINED. seisin still names the owner, but</span>');
      L.push('<span class="d">// nothing stops the write. Only the log will know.</span>');
    }
    L.push("{");
    L.push('  <span class="k">"network"</span>: {');
    L.push('    "allowedDomains": ["github.com"],');
    L.push('    "deniedDomains": [], "allowUnixSockets": [],');
    L.push('    "allowLocalBinding": false');
    L.push("  },");
    L.push('  <span class="k">"filesystem"</span>: {');
    L.push('    <span class="d">"denyRead"</span>: ["'+esc(KEYDIR)+'"],');
    if(r.keys.length){
      L.push('    <span class="g">"allowRead"</span>: [');
      r.keys.forEach(function(k,i){L.push('      "'+esc(KEYDIR)+"/"+esc(k)+'"'+(i<r.keys.length-1?",":""));});
      L.push("    ],");
    }else{
      L.push('    <span class="g">"allowRead"</span>: [],  <span class="c">// declares none</span>');
    }
    L.push('    <span class="g">"allowWrite"</span>: [');
    if(r.writes.length) r.writes.forEach(function(p,i){
      L.push('      "'+esc(p.replace(/\/\*\*$/,""))+'"'+(i<r.writes.length-1?",":""));
    });
    else L.push('      <span class="c">// no territory</span>');
    L.push("    ],");
    L.push('    "denyWrite": []');
    L.push("  }");
    L.push("}");
    document.getElementById("cfg").innerHTML=L.join("\n");
  }

  /**
   * The policy, as TOML.
   *
   * Served live, it prints the file on disk verbatim — comments, order and the
   * provenance a grant wrote — with the line the last decision wrote marked.
   * Opened as a file, there is no disk to read, so it renders the example's
   * model, and says so.
   */
  var MARK = null;   // the line number the last save wrote, marked until the next one
  function drawToml(){
    var host = document.getElementById("toml");
    if (ONDISK !== null) {
      host.innerHTML = ONDISK.split("\n").map(function(l, i){
        var h = esc(l).replace(/^(\[[^\]]+\])$/, '<span class="k">$1</span>').replace(/(#[^\n]*)$/, '<span class="c">$1</span>');
        return MARK === i + 1 ? '<mark id="toml-mark">' + h + "</mark>" : h;
      }).join("\n");
      return;
    }
    var L=['<span class="c"># Example policy, generated in this page. Anything not listed is denied.</span>',"",
           "[keys]",'dir = "'+esc(KEYDIR)+'"',"","[network]",'allow = ["github.com", "*.github.com"]',""];
    if(PROTECT.instructions) L.push('<span class="k">[protect]</span>',"instructions = true","");
    ROLES.forEach(function(r){
      L.push('<span class="k">[roles.'+esc(r.name)+"]</span>");
      L.push("writes = ["+r.writes.map(function(w){return '"'+esc(w)+'"';}).join(", ")+"]");
      L.push("keys   = ["+r.keys.map(function(k){return '"'+esc(k)+'"';}).join(", ")+"]");
      if((r.controlFiles||[]).length)
        L.push("control_files = ["+r.controlFiles.map(function(f){return '"'+esc(f)+'"';}).join(", ")+"]");
      L.push("");
    });
    host.innerHTML=L.join("\n");
  }



  /* ── control files ────────────────────────────────────────────────────── */

  /**
   * The two families a policy can hand a role, and the one global switch.
   *
   * A toggle never saves. It asks the server (dryRun) what each sandbox profile
   * would gain or lose and who could then write each family; that answer is
   * shown, and a separate button saves it. The server's list is the only list:
   * the families no role is ever handed are not offered here.
   */
  var FAM = {
    ide: { label: "Editor settings", files: ".vscode/ · .cursor/ · .windsurf/",
           what: "Tasks, terminal profiles and settings the editor applies the moment they change, outside the sandbox." },
    instructions: { label: "Instruction files", files: "CLAUDE.md · AGENTS.md · GEMINI.md · .cursorrules …",
           what: "What the next agent session reads as its instructions — how one role reaches another’s context." }
  };
  var PENDING = null;   // { edit, from, fam, where, plan, error, busy, demo } — the change being looked at

  function selRole(){ return ROLES.filter(function(x){ return x.name === sel; })[0]; }

  function ctlRow(o){
    var row = document.createElement("div"); row.className = "ctl-row" + (o.glob ? " glob" : "");
    var l = document.createElement("div"); l.className = "lbl";
    l.innerHTML = "<b>" + esc(o.title) + "</b> <code>" + esc(o.code) + "</code><p>" + o.desc + "</p>";
    var b = document.createElement("button"); b.type = "button"; b.className = "sw"; b.id = o.id;
    b.setAttribute("data-state", o.open ? "open" : "shut");
    b.setAttribute("aria-pressed", o.pressed ? "true" : "false");
    // The accessible name starts with the words on the button (WCAG 2.5.3): a voice user says
    // what they see. It was "Protect instruction files for every role" on a button reading
    // "not protected".
    b.setAttribute("aria-label", o.text + " — " + o.aria);
    b.innerHTML = "<i></i>" + esc(o.text);
    if (o.disabled) { b.disabled = true; b.title = o.why || ""; }
    else b.onclick = o.click;
    row.appendChild(l); row.appendChild(b);
    return row;
  }

  function drawControls(){
    var pw = document.getElementById("pw");
    var host = document.getElementById("ctl"); if (!host || !pw) return;
    var r = selRole();
    document.getElementById("ctl-title").textContent = r ? "Control files · " + r.name : "Control files";
    host.textContent = ""; pw.textContent = "";
    var prot = !!PROTECT.instructions;
    pw.appendChild(ctlRow({
      glob: true, id: "ctl-sw-protect", title: "Protect instruction files", code: "[protect] instructions",
      desc: prot
        ? "On: instruction files are denied to every role not handed them below."
        : "Off: every role may edit instruction files inside its own territory.",
      open: !prot, pressed: prot, text: prot ? "protected" : "not protected",
      aria: "instruction files, for every role",
      click: function(){ propose({ protect: !prot }, "ctl-sw-protect", "instructions", "pw"); }
    }));
    if (!r) { drawPreview(); if (READONLY) document.querySelectorAll("#pw button").forEach(function(b){ b.disabled = true; }); return; }
    ["ide", "instructions"].forEach(function(f){
      var mine = (r.controlFiles || []).indexOf(f) !== -1;
      var idle = f === "instructions" && !prot;
      var desc = idle
        ? "Nothing to hand over while <code>[protect] instructions</code> is off: no role is denied these. Turn protection on under Policy-wide first."
        : (mine ? esc(r.name) + " may edit these inside its own territory. "
                : "Protected: " + esc(r.name) + " is denied writing them. ") + esc(FAM[f].what);
      host.appendChild(ctlRow({
        id: "ctl-sw-" + f, title: FAM[f].label + " (" + f + ")", code: FAM[f].files, desc: desc,
        open: mine || idle, pressed: mine, text: idle ? "not protected" : mine ? "may edit" : "protected",
        aria: FAM[f].label.toLowerCase() + ", " + r.name,
        disabled: idle, why: "Turn on [protect] instructions first",
        click: function(){
          var next = (r.controlFiles || []).filter(function(x){ return x !== f; });
          if (!mine) next.push(f);
          next = ["ide", "instructions"].filter(function(x){ return next.indexOf(x) !== -1; });
          propose({ role: r.name, families: next }, "ctl-sw-" + f, f, "ctl");
        }
      }));
    });
    drawPreview();
    if (READONLY) document.querySelectorAll("#pw button, #ctl button").forEach(function(b){
      b.disabled = true; b.title = "read only: this run's policy was lent by its launcher";
    });
  }

  async function callControls(body){
    var r = await fetch("/api/control-files", {
      method: "POST",
      headers: { "content-type": "application/json", "x-seisin-token": TOKEN },
      body: JSON.stringify(body)
    });
    var out = await r.json();
    if (!r.ok) { var err = new Error(out.error || "the console did not accept that"); err.status = r.status; throw err; }
    return out;
  }

  function sameEdit(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

  /** A toggle pressed: ask what it would do. Pressing the same one again puts it back. */
  async function propose(edit, from, fam, where){
    if (PENDING && sameEdit(PENDING.edit, edit)) { cancelEdit(); return; }
    var mine = PENDING = { edit: edit, from: from, fam: fam, where: where, plan: null, error: null, busy: LIVE, demo: !LIVE };
    drawPreview();
    if (!LIVE) return;
    try { var out = await callControls(Object.assign({ dryRun: true }, edit)); if (PENDING === mine) mine.plan = out; }
    catch (e) { if (PENDING === mine) mine.error = whyFailed(e, e.status); }
    if (PENDING !== mine) return;
    mine.busy = false;
    drawPreview();
    // Focus goes to the decision, so the keyboard path is toggle → Enter → reason → Save.
    var next = document.getElementById("ctl-why") || document.getElementById("ctl-save") || document.getElementById("ctl-cancel");
    if (next) next.focus();
  }

  function cancelEdit(){
    var from = PENDING && PENDING.from;
    PENDING = null;
    drawPreview();
    var b = from && document.getElementById(from);
    if (b) b.focus();
  }

  /** A path as a reader names it: relative to the repo, and a pattern for a file not
   *  there yet (`.curso[r]`, see surface.js `exactly`) written as the name it matches. */
  function rel(p){
    var q = ROOT && p.indexOf(ROOT + "/") === 0 ? p.slice(ROOT.length + 1) : p;
    return q.replace(/\[([^\]\/])\]$/, "$1");
  }

  function describe(edit){
    if (edit.protect !== undefined)
      return (edit.protect ? "Turn on" : "Turn off") + " protection of instruction files, for every role";
    return "Set " + edit.role + "’s control_files to [" +
      edit.families.map(function(f){ return '"' + f + '"'; }).join(", ") + "]";
  }

  function whoMay(list){ return list && list.length ? "<b>" + list.map(esc).join(", ") + "</b>" : "<b>no role</b>"; }

  /**
   * The profile changes, grouped: one line per direction ("7 instruction files in frontend,
   * backend and ops become denied"), the paths behind a disclosure. It listed every path of
   * every role, and turning protection on in a policy of twelve roles was eighty-four lines
   * saying the same thing.
   */
  function groupedDiff(diff, fam){
    var dirs = { shut: { roles: [], n: 0, created: 0, per: {} }, open: { roles: [], n: 0, created: 0, per: {} } };
    diff.forEach(function(x){
      if (x.error) return;
      [["shut", x.added], ["open", x.removed]].forEach(function(p){
        if (!p[1].length) return;
        var g = dirs[p[0]];
        g.roles.push(x.role); g.n += p[1].length;
        g.per[x.role] = p[1];
        p[1].forEach(function(e){ if (/if it is created$/.test(e.why)) g.created++; });
      });
    });
    var what = FAM[fam] ? FAM[fam].label.toLowerCase().replace(/s$/, "") : "control file";
    var h = "";
    [["shut", "become denied", "an agent that edits these today will be denied"],
     ["open", "become writable", "the role may edit them inside its territory"]].forEach(function(d){
      var g = dirs[d[0]]; if (!g.n) return;
      var exist = g.n - g.created;
      h += '<li class="' + d[0] + '"><b aria-hidden="true">' + (d[0] === "shut" ? "+" : "−") + "</b><span>" +
        '<span class="cnt">' + g.n + " " + esc(what) + (g.n === 1 ? "" : "s") + "</span> in " +
        esc(g.roles.join(", ")) + " " + d[1] +
        "<em>" + d[2] + (g.created ? " · " + exist + " exist now, " + g.created + " only if created" : "") + "</em>" +
        "<details><summary>show the " + g.n + " path" + (g.n === 1 ? "" : "s") + "</summary><ul>" +
        g.roles.map(function(r){
          return "<li>" + esc(r) + ": " + g.per[r].map(function(e){ return esc(rel(e.path)); }).join(", ") + "</li>";
        }).join("") + "</ul></details></span></li>";
    });
    diff.forEach(function(x){ if (x.error) h += '<li><b>!</b><span>' + esc(x.role) + ': <span class="err">' + esc(x.error) + "</span></span></li>"; });
    return h ? '<ul class="diff">' + h + "</ul>" : "";
  }

  /** The exact lines of seisin.toml an edit writes, the way a diff shows them. */
  function tomlLines(lines, note){
    if (!lines) return "";
    var body = lines.removed.map(function(l){ return '<span class="d">- ' + esc(l) + "</span>"; })
      .concat(lines.added.map(function(l){ return '<span class="g">+ ' + esc(l) + "</span>"; })).join("\n");
    return "<p>" + note + " at line " + lines.at + ":</p>" + '<pre class="tomlline">' + body + "</pre>";
  }

  function drawPreview(){
    ["pw", "ctl"].forEach(function(where){
      var box = document.getElementById(where + "-preview"); if (!box) return;
      var p = PENDING && PENDING.where === where ? PENDING : null;
      if (!p) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      var h = "<h3>" + esc(describe(p.edit)) + "</h3>";
      var buttons = '<button class="btn" id="ctl-cancel" type="button">Cancel</button>';
      if (p.busy) h += "<p>Asking the server what this changes…</p>";
      else if (p.error) h += '<p class="err">' + esc(p.error) + "</p>";
      else if (p.demo) {
        h += "<p>This is the example, and nothing here is saved. Run by <code>seisin ui</code>, this panel lists " +
             "what each role’s sandbox settings gain or lose — computed by the server from the edited " +
             "policy — and the exact line written to seisin.toml, and nothing is written until you confirm.</p>";
        buttons = '<button class="btn primary" id="ctl-save" type="button">Apply to the example</button>' + buttons;
      } else if (p.plan && !p.plan.changed) {
        h += "<p>seisin.toml already says this. Nothing to save.</p>";
      } else if (p.plan) {
        var d = p.plan.diff || [];
        h += groupedDiff(d, p.fam);
        var idle = p.plan.unaffected || [];
        if (idle.length)
          h += "<p>No change for <b>" + esc(idle.join(", ")) + "</b>: no territory of " +
               (idle.length === 1 ? "that role" : "those roles") + " holds a project where these files are or could be created.</p>";
        var a = p.plan.access || {};
        h += "<p>Then editor settings may be edited by " + whoMay(a.ide) + "; instruction files " +
             (a.instructions === null || a.instructions === undefined
               ? "are not protected — <b>every role</b> may edit them in its own territory."
               : "by " + whoMay(a.instructions) + ".") + "</p>";
        h += tomlLines(p.plan.lines, "Written to seisin.toml (your reason is added at the end of the line)");
        buttons = '<input id="ctl-why" placeholder="reason (required) — written beside the line" aria-label="Reason for this change">' +
                  '<button class="btn primary" id="ctl-save" type="button" data-write>Save to seisin.toml</button>' + buttons;
      }
      box.innerHTML = h + '<div class="act">' + buttons + '</div><p class="err" id="ctl-err" hidden></p>';
      document.getElementById("ctl-cancel").onclick = cancelEdit;
      var save = document.getElementById("ctl-save");
      if (save) save.onclick = saveEdit;
      box.onkeydown = function(e){ if (e.key === "Escape") { e.preventDefault(); cancelEdit(); } };
    });
    lockWrites();
  }

  /** What a save wrote, left under the box until the next change. */
  function doneNotice(where, html){
    ["pw", "ctl"].forEach(function(w){
      var el = document.getElementById(w + "-done");
      if (!el) return;
      if (w !== where || !html) { el.hidden = true; el.innerHTML = ""; return; }
      el.hidden = false;
      el.innerHTML = '<span class="txt">' + html + '</span><button type="button">dismiss</button>';
      el.querySelector("button").onclick = function(){ el.hidden = true; el.innerHTML = ""; };
    });
  }

  /** The confirmation: the edit that was previewed, against the file it was previewed on. */
  async function saveEdit(){
    var p = PENDING; if (!p) return;
    if (p.demo) {
      if (p.edit.protect !== undefined) PROTECT = { instructions: p.edit.protect };
      else { var r = ROLES.filter(function(x){ return x.name === p.edit.role; })[0]; if (r) r.controlFiles = p.edit.families.slice(); }
      PENDING = null;
      doneNotice(p.where, "Applied to the example: " + esc(describe(p.edit)) + ". Nothing was saved — " +
        '<a href="#configfile">see the example seisin.toml</a>.');
      note("control files", describe(p.edit));
      var b = document.getElementById(p.from); if (b) b.focus();
      return;
    }
    var why = document.getElementById("ctl-why");
    if (why && !why.value.trim()) {
      why.setAttribute("aria-invalid", "true"); why.focus();
      var er = document.getElementById("ctl-err");
      er.hidden = false; er.textContent = "Write a reason first — it is saved beside the line in seisin.toml.";
      return;
    }
    var box = document.getElementById(p.where + "-preview");
    box.querySelectorAll("button,input").forEach(function(e){ e.disabled = true; });
    try {
      var out = await callControls(Object.assign({ base: p.plan.base, reason: (document.getElementById("ctl-why") || {}).value || "" }, p.edit));
      PENDING = null;
      var ln = out.lines;
      MARK = ln && ln.added.length ? ln.at : null;
      doneNotice(p.where, "Saved to seisin.toml: " + esc(describe(p.edit)) + ". The next <code>seisin run</code> of a role uses it." +
        (ln && ln.added.length ? '<span class="ln">line ' + ln.at + ": " +
          ln.added.filter(function(l){ return l.trim(); }).map(esc).join(" · ") + "</span>" : "") +
        ' <a href="#configfile">see Config file' + (MARK ? ", line " + MARK : "") + "</a>");
      await reload();
      drawPreview();
      var b2 = document.getElementById(p.from); if (b2) b2.focus();
    } catch (e) {
      if (PENDING === p) { p.error = whyFailed(e, e.status); p.plan = null; }
      drawPreview();
    }
  }

  /* ── requests ─────────────────────────────────────────────────────────── */

  var REQS = [];
  var LIVE = false;    // served by `seisin ui`, reading a real repo
  var SETTINGS = {};   // role -> { settings } or { error }, from /api/settings; cleared when the policy changes
  var ONDISK = null;   // the file on disk, when there is one









  /** A count beside a nav item, or nothing — with its unit for a screen reader and a tooltip. */
  function pill(id, n, unit){
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = n ? esc(n > 999 ? Math.round(n/1000) + "k" : String(n)) + '<span class="sr"> ' + esc(unit) + "</span>" : "";
    el.title = n ? n.toLocaleString() + " " + unit : "";
    el.hidden = !n;
  }


  /** What granting covers, said before the click: the file that was asked for, the folder
   *  that would be granted, and whose it is. It said "wants to write docs/**" for a request
   *  over docs/api.md, and the widening was a detail in grey under it. */
  function scopeOf(r){
    var owners = r.owners || [];
    var own = owners.length
      ? '<span class="own">' + esc(r.grant) + " belongs to <b>" + esc(owners.join(", ")) + "</b>. Granting lets <b>" +
        esc(r.role) + "</b> write it too.</span>"
      : '<span class="own">No role owns it today.</span>';
    if (r.action === "read")
      return '<div class="scope">Granting lets <b>' + esc(r.role) + "</b> read the key <code>" + esc(r.grant) + "</code>.</div>";
    if (r.grant === r.target)
      return '<div class="scope">Granting covers exactly <code>' + esc(r.grant) + "</code>." + own + "</div>";
    return '<div class="scope wide">Asked for <code>' + esc(r.target) + "</code> → granting covers <b>all of <code>" +
      esc(r.grant) + "</code></b>, not only that file." + own + "</div>";
  }

  /** Where the request goes, as the server decided it: handed to its owner, or a person decides.
   *  Not worked out here — the page shows the decision seisin requests and the MCP show. */
  function handoffOf(r){
    if (typeof r.handoffNote !== "string" || !r.handoffNote) return "";
    var routed = /^handed to /.test(r.handoffNote);
    return '<div class="handoff' + (routed ? "" : " person") + '">' + esc(r.handoffNote) + "</div>";
  }

  /** A write keyed by a folder can be granted as the one file instead. */
  function narrowable(r){ return r.action === "write" && r.grant !== r.target; }

  /** The line a one-file grant carries. Live, the server says it from the role's last run;
   *  the example has no runs, so it says it conditionally. */
  function fileNoteOf(r){
    if (typeof r.fileNote === "string") return r.fileNote;
    return "If " + r.role + " runs Claude Code, a one-file grant will not let it edit: Claude Code's Write and Edit " +
      "save to a temporary beside the file and rename it over, and the temporary is outside a one-file grant (EPERM).";
  }

  /** Folder (as before) or only the file: the choice, and what the file choice costs. */
  function scopeChoice(r, i){
    if (!narrowable(r)) return "";
    return '<div class="pick" role="radiogroup" aria-label="What to grant">' +
      '<label><input type="radio" name="scope-' + i + '" value="folder" checked> the folder <code>' + esc(r.grant) + "</code></label>" +
      '<label><input type="radio" name="scope-' + i + '" value="file"> only the file <code>' + esc(r.target) + "</code></label>" +
      "</div>" +
      '<div class="fnote" id="fnote-' + i + '" hidden>' + esc(fileNoteOf(r)) + "</div>";
  }

  /** What the row's Grant button would write: the folder, or the one file chosen instead. */
  function chosen(r, i){
    var f = document.querySelector('input[name="scope-' + i + '"][value="file"]');
    return narrowable(r) && f && f.checked ? { scope: "file", grant: r.target } : { scope: "folder", grant: r.grant };
  }


  function drawReqs(){
    var host = document.getElementById("reqs");
    pill("req-pin", REQS.length, REQS.length === 1 ? "request" : "requests");
    if (!REQS.length) {
      host.innerHTML = READONLY
        ? '<p class="blank quiet">This run asked for nothing.</p>'
        : '<p class="blank quiet">No pending decisions. ' +
          '<span>Agents land here when they ask for a path the policy denies them.</span></p>';
      drawBulk();
      return;
    }

    // On a role's page, that role's requests only; each keeps its place in the queue, which is what a decision names.
    var only = route() === "role" ? ROLE : null;
    document.getElementById("req-h").textContent = only ? "Waiting on you" : "Pending decisions";
    host.innerHTML = REQS.map(function(r, i){
      if (only && r.role !== only) return "";
      var times = r.times > 1 ? 'asked ' + r.times + "×" : "asked once";
      var w = when(r.last || r.first);
      var stale = r.stale ? ' · not asked again in ' + Number(r.stale.runs) + ' runs since — likely no longer needed' : "";
      return '<div class="req' + (r.stale ? ' stale' : '') + '">' +
        '<div class="who">' +
          "<div><b>" + esc(r.role) + "</b> wants to " + esc(r.action) + ' <span class="path">' + esc(r.target) + "</span></div>" +
          scopeOf(r) + handoffOf(r) + (READONLY ? "" : scopeChoice(r, i)) +
          '<div class="sub"><span class="asked">' + times + "</span>" +
            (w.text ? ' · last <span title="' + escA(w.title) + '">' + esc(w.text) + "</span>" : "") + stale + "</div>" +
          '<div class="err" id="err-' + i + '" role="alert" hidden></div>' +
        "</div>" +
        (READONLY
          ? '<div class="act ro-ask">' + 'Not granted here — ask for it ' + esc(askedOf()) + ': <code>' + esc(r.grant) + "</code></div>"
          : '<div class="act">' +
          '<input id="why-' + i + '" placeholder="reason (required)" aria-label="Reason for ' +
            escA(r.role) + '’s request" aria-describedby="err-' + i + '">' +
          '<button class="btn primary" data-n="' + i + '" data-k="' + escA(r.key) + '" data-d="granted" type="button" data-write>Grant</button>' +
          '<button class="btn" data-n="' + i + '" data-k="' + escA(r.key) + '" data-d="declined" type="button" data-write>Decline</button>' +
        "</div>") +
      "</div>";
    }).join("");

    host.querySelectorAll("button[data-n]").forEach(function(b){
      b.addEventListener("click", function(){ act(b); });
    });
    host.querySelectorAll('input[type="radio"][name^="scope-"]').forEach(function(x){
      x.addEventListener("change", function(){
        var n = x.name.slice(6), note = document.getElementById("fnote-" + n);
        if (note) note.hidden = !(x.value === "file" && x.checked && note.textContent);
      });
    });
    drawBulk();
    lockWrites();
  }

  /** Two clicks: the first arms the button and says what the second does. */
  function arm(btn, text, rest){
    btn.dataset.armed = "1";
    btn.classList.add("armed");
    btn.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(function(){ disarm(btn, rest); }, 5000);
  }
  function disarm(btn, rest){
    btn.dataset.armed = "";
    btn.classList.remove("armed");
    btn.textContent = rest;
  }

  /**
   * Decline every request on screen — two clicks, with the reason in view.
   *
   * There is no "grant all" on purpose: a grant is read one at a time. The
   * keys sent are the ones drawn now, so a request that arrives in between is
   * not declined unseen. A reason is required; an empty box is filled with a
   * default on the first click, so what is sent is on screen before it is sent.
   */
  function drawBulk(){
    var bulk = document.getElementById("bulk");
    var btn = document.getElementById("decline-all");
    var why = document.getElementById("why-all");
    // On a role's page the box lists that role's requests; "all" would reach the others too.
    bulk.hidden = REQS.length < 2 || READONLY || /^#role\//.test(location.hash);
    btn.disabled = false;
    var rest = "Decline all (" + REQS.length + ")";
    disarm(btn, rest);
    btn.onclick = async function(){
      if (!btn.dataset.armed) {
        if (!why.value.trim()) why.value = "declined in bulk from the console";
        arm(btn, "Click again to decline " + REQS.length + " with this reason", rest);
        return;
      }
      if (!LIVE) {
        DEMO.requests = [];
        decided("Declined " + plural(REQS.length, "request") + " in the example · reason «" + esc(why.value.trim()) + "». Nothing was saved.");
        note("declined all", why.value.trim());
        return;
      }
      btn.disabled = true;
      try {
        var r = await fetch("/api/decline-all", {
          method: "POST",
          headers: { "content-type": "application/json", "x-seisin-token": TOKEN },
          body: JSON.stringify({ keys: REQS.map(function(q){ return q.key; }), reason: why.value.trim() })
        });
        var out = await r.json();
        if (!r.ok) { var err = new Error(out.error || "the console did not accept that"); err.status = r.status; throw err; }
        decided("Declined " + plural(out.declined, "request") + " · reason «" + esc(why.value.trim()) +
                "», recorded in the request queue. The policy was not changed." +
                (out.stillAllowed ? " The policy already gives " + out.stillAllowed.toLocaleString() + " of them, and that stays." : ""));
        why.value = "";
        await reload();
      } catch (e) {
        btn.disabled = false;
        disarm(btn, rest);
        var n = document.getElementById("req-note");
        n.textContent = whyFailed(e, e.status); n.style.color = "var(--amber)";
      }
    };
  }

  /** What the last decision did, until the next one. */
  function decided(html){
    var el = document.getElementById("decided");
    if (!html) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = '<span class="txt">' + html + '</span><button type="button">dismiss</button>';
    el.querySelector("button").onclick = function(){ decided(null); };
  }

  /**
   * One decision, sent once.
   *
   * By the request's id, taken from the row as it was drawn. A reason is required
   * for either answer. Granting a path that is another role's takes a second
   * click that names what is shared; declining with an empty box fills in the
   * default and asks again, so what is recorded is on screen before it is.
   */
  async function act(btn){
    var i = Number(btn.dataset.n);
    var req = REQS[i];
    var key = btn.dataset.k;
    var granting = btn.dataset.d === "granted";
    var input = document.getElementById("why-" + i);
    var err = document.getElementById("err-" + i);
    var row = btn.closest(".req");
    var rest = granting ? "Grant" : "Decline";
    function fail(msg){ err.hidden = false; err.textContent = msg; }
    err.hidden = true;
    input.removeAttribute("aria-invalid");

    var filled = false;
    if (!input.value.trim()) {
      if (granting) {
        input.setAttribute("aria-invalid", "true");
        fail("Write a reason first — it is saved next to the grant in seisin.toml.");
        input.focus();
        return;
      }
      input.value = "declined from the console";
      filled = true;
    }
    var pick = chosen(req, i);
    var needsArm = granting ? (req.owners || []).length > 0 : filled;
    if (needsArm && !btn.dataset.armed) {
      arm(btn, granting ? "Click again to share " + pick.grant + " with " + req.role
                        : "Click again to decline with this reason", rest);
      return;
    }
    disarm(btn, rest);
    var why = input.value.trim();

    if (!LIVE) {
      if (granting) {
        var r0 = ROLES.filter(function(x){ return x.name === req.role; })[0];
        if (r0 && r0.writes.indexOf(pick.grant) === -1) r0.writes.push(pick.grant);
      }
      DEMO.requests = DEMO.requests.filter(function(q){ return q.role + ":" + q.action + ":" + q.target !== key; });
      decided(granting
        ? "Granted <code>" + esc(pick.grant) + "</code> to <b>" + esc(req.role) + "</b> in the example. Live, this line is written to seisin.toml:" +
          '<span class="ln">"' + esc(pick.grant) + '"   # granted … · «' + esc(why) + "»</span>Nothing was saved. " +
          '<a href="#configfile">see the example seisin.toml</a>'
        : "Declined <b>" + esc(req.role) + "</b>’s request for <code>" + esc(req.grant) + "</code> in the example · reason «" + esc(why) + "».");
      note(granting ? "granted" : "declined", req.role + " · " + (granting ? pick.grant : req.grant));
      return;
    }

    row.querySelectorAll("button,input").forEach(function(e){ e.disabled = true; });
    try {
      var r = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json", "x-seisin-token": TOKEN },
        body: JSON.stringify({ key: key, decision: btn.dataset.d, reason: why, scope: granting ? pick.scope : "folder" })
      });
      var out = await r.json();
      if (!r.ok) { var e2 = new Error(out.error || "the console did not accept that"); e2.status = r.status; throw e2; }
      if (granting) {
        MARK = out.line ? out.line.number : null;
        decided("Granted <code>" + esc(out.grant) + "</code> to <b>" + esc(out.role) + "</b>" +
          (out.line
            ? " · written to seisin.toml, line " + out.line.number + ':<span class="ln">' + esc(out.line.text) + "</span>"
            : " · seisin.toml already had it; nothing new was written. ") +
          '<a href="#configfile">see Config file' + (out.line ? ", line " + out.line.number : "") + "</a>");
      } else {
        decided("Declined <b>" + esc(out.role) + "</b>’s request for <code>" + esc(out.grant) + "</code> · reason «" + esc(why) +
                "», recorded in the request queue. The policy was not changed." +
                (out.stillAllowed ? " <b>" + esc(out.role) + " keeps it:</b> " + esc(out.stillAllowed) : ""));
      }
      // Re-read rather than patch: the grant rewrote seisin.toml, so the
      // territory on screen is stale too, not just the queue.
      await reload();
    } catch (e) {
      row.querySelectorAll("button,input").forEach(function(el){ el.disabled = false; });
      fail(whyFailed(e, e.status));
      lockWrites();
    }
  }

  /**
   * One view failing must not take the others down: a console whose KPIs read zero because
   * of a typo is worse than one that is down, because zero is a plausible answer.
   */
  function draw(){
    [drawRows, drawCfg, drawControls, drawToml, drawReqs]
      .forEach(function(f){ try { f(); } catch (e) { console.error("seisin: " + f.name + " failed", e); } });
  }

  /**
   * This run's token, from the link `seisin ui` opened.
   *
   * It arrives in the fragment (#t=…), which the browser never sends to any
   * server, and it is moved into this tab's storage and wiped from the address
   * bar and the history entry at once.
   */
  /**
   * A run a link asked for: `&run=<id>` beside the token, the link a launcher's
   * panel hands out. There is no console of one run any more: once the runs are
   * read, it opens under its role (`#role/<role>/run/<id>`).
   */
  var LINKED_RUN = (function(){
    var h = /(?:^#|&)run=([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:&|$)/.exec(location.hash || "");
    var q = new URLSearchParams(location.search).get("run");
    var id = h ? h[1] : q;
    return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? id : null;
  })();
  var TOKEN = (function(){
    var m = /(?:^#|&)t=([a-f0-9]+)/.exec(location.hash || "");
    try {
      if (m) { sessionStorage.setItem("seisin-token", m[1]); }
      var t = m ? m[1] : (sessionStorage.getItem("seisin-token") || "");
      if (m) history.replaceState(null, "", location.pathname + location.search.replace(/([?&])run=[^&]*&?/, "$1").replace(/[?&]$/, ""));
      return t;
    } catch (_) { return m ? m[1] : ""; }
  })();
  /** "policy" — one seisin.toml, the console as it always was — or "runs", read only. */
  var MODE = "policy";
  var READONLY = false;
  /** `[console] launcher`: who lends the territory, so nothing is granted here. */
  var LAUNCHER = null;
  var HAS_RUNS = false;
  /** Who a denial is asked of, when it is not asked here. */
  function askedOf(){ var who = LAUNCHER; return who ? "in " + who : "where the run was launched"; }

  /** What to tell a person when a request to this server fails. */
  function whyFailed(e, status){
    if (status === 401 || status === 403)
      return "this tab's link has expired — the console was restarted. Open the new one: seisin ui --link";
    if (e && /network|fetch/i.test(String(e.message || e)))
      return "the console did not answer. If you stopped `seisin ui`, start it again and open the link it prints.";
    return (e && e.message) || "failed";
  }

  /* ── offline ──────────────────────────────────────────────────────────────
   * The header said "live" in green for as long as the tab was open, whether or
   * not anything was answering, and Grant stayed clickable against a server
   * that was gone or had a new token. After two failed polls in a row the page
   * says which of the two it is, since when, and turns the writes off. */
  var FAILS = 0, OFFLINE = null;
  function setOffline(kind, why){
    if (kind && OFFLINE && OFFLINE.kind === kind && OFFLINE.why === why) return;
    OFFLINE = kind ? { kind: kind, why: why || null, since: (OFFLINE && OFFLINE.since) || new Date() } : null;
    var label = document.getElementById("source");
    var ban = document.getElementById("off-banner");
    if (!OFFLINE) {
      label.textContent = LIVE_LABEL; label.style.color = "var(--green)";
      ban.hidden = true; ban.innerHTML = "";
    } else {
      var t = pad(OFFLINE.since.getHours()) + ":" + pad(OFFLINE.since.getMinutes());
      label.style.color = "var(--amber)";
      if (kind === "policy") {
        label.textContent = "seisin.toml cannot be read";
        ban.innerHTML = "<b>seisin.toml cannot be read</b> (since " + t + "): " + esc(OFFLINE.why) + " " +
          "What is on screen is the last policy that loaded. Decisions and saves are off until the file is fixed.";
      } else if (kind === "expired") {
        label.textContent = "link expired — open the new one";
        ban.innerHTML = "<b>This tab's link has expired</b> (since " + t + "): the console was restarted with a new one. " +
          "Open the new link — run <code>seisin ui --link</code> in the repository. Decisions and saves are off in this tab.";
      } else {
        label.textContent = "offline since " + t;
        ban.innerHTML = "<b>The console is not answering</b> (since " + t + "). What is on screen is as of then. " +
          "Decisions and saves are off until it answers again; if you stopped <code>seisin ui</code>, start it and open the link it prints.";
      }
      ban.hidden = false;
    }
    lockWrites();
  }
  /** Every control that writes is off while the server is not there to take it. */
  function lockWrites(){
    document.querySelectorAll("[data-write]").forEach(function(b){
      if (OFFLINE) { b.disabled = true; b.title = "the console is not answering"; }
      else if (b.title === "the console is not answering") { b.disabled = false; b.title = ""; }
    });
  }

  function stateUrl(){ return "/api/state"; }

  /**
   * One read of the state, for boot, the poll and the reload after a decision.
   * The poll sends back the tag of what it last got; 304 when nothing moved.
   */
  var LAST = { url: null, etag: null };
  async function fetchState(fresh){
    var url = stateUrl();
    var h = { "x-seisin-token": TOKEN };
    if (!fresh && LAST.etag && LAST.url === url) h["if-none-match"] = LAST.etag;
    var r = await fetch(url, { cache: "no-store", headers: h });
    if (r.status === 304) return { same: true };
    // A refusal carries the server's reason (a seisin.toml that no longer
    // parses): kept, so it is shown instead of reading as the server gone.
    if (!r.ok) {
      var why = null;
      try { why = (await r.json()).error || null; } catch (_) { /* no body */ }
      return { status: r.status, error: why };
    }
    var s = await r.json();
    if (s.error) return { status: r.status, error: s.error };
    LAST = { url: url, etag: r.headers.get("etag") };
    return { s: s };
  }

  /**
   * What the server (or the example) said, applied — and only what changed is redrawn,
   * so a table someone is reading or a reason being typed is not thrown away every two
   * seconds.
   */
  var SEEN = {};
  function changed(part, v){
    var j = JSON.stringify(v === undefined ? null : v);
    if (SEEN[part] === j) return false;
    SEEN[part] = j;
    return true;
  }
  function applyState(s){
    var shape = s.roles.map(function(x){ var y = Object.assign({}, x); delete y.blocks; return y; });
    var policy = changed("toml", s.toml);
    policy = changed("shape", shape) || policy;
    policy = changed("keyDirs", s.keyDirs) || policy;
    policy = changed("protect", s.protect) || policy;
    BASE = s.base || null;
    if (policy && PENDING && PENDING.plan && PENDING.plan.base !== BASE) {
      PENDING.plan = null;
      PENDING.error = "seisin.toml changed on disk since this preview. Toggle again to see the change against what is there now.";
    }
    if (policy) {
      KEYDIR = (s.keyDirs && s.keyDirs[0]) || ".secrets";
      KEYS = s.allKeys ? s.allKeys.slice() : [...new Set(s.roles.flatMap(r => r.keys))].map(k => k.replace(/\.[^.]+$/, ""));
      ROLES = s.roles.map(r => ({
        name: r.name,
        writes: r.writes.slice(),
        keys: r.keys.map(k => k.replace(/\.[^.]+$/, "")),
        sandbox: r.sandbox !== false,
        blocks: r.blocks,
        neverWrites: r.neverWrites || [],
        localBinding: !!r.localBinding,
        localPorts: (r.localPorts || []).slice(),
        trustd: !!r.trustd,
        controlFiles: (r.controlFiles || []).slice()
      }));
      PROTECT = s.protect || { instructions: false };
      ROOT = s.root || "";
      ONDISK = s.toml || null;
      SETTINGS = {};
      if (!ROLES.some(function(r){ return r.name === sel; })) sel = (ROLES[0] || {}).name || "";
    }
    var blocks = changed("blocks", s.roles.map(function(x){ return [x.name, x.blocks]; }));
    if (blocks && !policy) ROLES.forEach(function(r2){
      var fresh = s.roles.find(function(x){ return x.name === r2.name; });
      if (fresh) r2.blocks = fresh.blocks;
    });
    var reqs = changed("requests", s.requests || []);
    if (reqs) REQS = s.requests || [];

    var views = [];
    if (policy) views.push(drawRows, drawCfg, drawControls, drawToml);
    else if (blocks) views.push(drawRows);
    if (reqs) views.push(drawReqs);
    views.forEach(function(f){ try { f(); } catch (e) { console.error("seisin: " + f.name + " failed", e); } });
  }

  /** One role's settings, asked of the server once per policy. */
  var ASKING = {};
  async function loadSettings(name){
    if (ASKING[name]) return;
    ASKING[name] = true;
    try {
      var r = await fetch("/api/settings?role=" + encodeURIComponent(name) + "",
                          { cache: "no-store", headers: { "x-seisin-token": TOKEN } });
      var out = await r.json();
      SETTINGS[name] = r.ok ? { settings: out.settings } : { error: out.error || "could not read the settings" };
    } catch (e) {
      SETTINGS[name] = { error: whyFailed(e) };
    } finally {
      delete ASKING[name];
    }
    if (name === sel) { try { drawCfg(); } catch (e) { console.error("seisin: drawCfg failed", e); } }
  }

  var LIVE_LABEL = "";
  /** Until the server has answered, nothing is shown: the example drawn first read as a live run for a second. */
  async function boot(){
    var asking = location.protocol.startsWith("http") && !!TOKEN;
    if (asking) document.body.classList.add("booting");
    try { await bootInner(); } finally { document.body.classList.remove("booting"); }
  }
  async function bootInner(){
    let got = null, stale = false;
    try {
      // Opened as a file there is no server to ask; the fetch only printed a CORS error.
      if (location.protocol === "file:") throw new Error("no server");
      var info = await fetch("/api/info", { cache: "no-store", headers: { "x-seisin-token": TOKEN } });
      if (info.ok) {
        var said = await info.json();
        HAS_RUNS = true;
        if (said.mode === "runs") { MODE = "runs"; READONLY = true; }
        if (said.readOnly) READONLY = true;
        LAUNCHER = said.launcher || null;
      }
      if (MODE === "runs") { await bootRuns(); return; }
      got = await fetchState(true);
      // A live server that refuses this tab's token: `seisin ui` was restarted
      // and minted a new one. Falling back to the example here showed a policy
      // that is not the reader's, one F5 after a restart, with nothing saying why.
      stale = got.status === 403 || got.status === 401;
    } catch (_) { /* opened as a file: stay in the example */ }
    const s = got && got.s;

    const label = document.getElementById("source");
    if (stale) {
      label.textContent = "link expired — open the new one";
      label.style.color = "var(--amber)";
      document.querySelector("main").innerHTML =
        '<div class="box" style="padding:22px 24px;max-width:640px">' +
        '<h2 style="margin:0 0 8px;font-size:17px">This tab has the link from an earlier run</h2>' +
        '<p style="margin:0 0 8px"><code>seisin ui</code> was restarted, and every run gets a new link. ' +
        'Open the new one: run <code>seisin ui --link</code> in the repository, or use the link it printed in the terminal.</p>' +
        '<p style="margin:0;color:var(--mid)">Nothing here is shown until then, so this page never ' +
        'passes the example policy off as yours.</p></div>';
      return;
    }
    if (!s && got && got.error) {
      label.textContent = "seisin.toml cannot be read";
      label.style.color = "var(--amber)";
      document.querySelector("main").innerHTML =
        '<div class="box" style="padding:22px 24px;max-width:640px">' +
        '<h2 style="margin:0 0 8px;font-size:17px">The console cannot read this repository\'s policy</h2>' +
        '<p style="margin:0 0 8px" class="err">' + esc(got.error) + '</p>' +
        '<p style="margin:0;color:var(--mid)">Fix the file and reload. <code>seisin check</code> says the same in a terminal.</p></div>';
      return;
    }
    if (!s) {
      label.textContent = location.protocol.startsWith("http") && !TOKEN
        ? "no token — showing an example"
        : "example — not your repo";
      label.style.color = "var(--amber)";
      document.getElementById("demo-banner").hidden = false;
      if (location.protocol.startsWith("http") && !TOKEN)
        document.getElementById("demo-banner").innerHTML += " This tab has no link token: open the link <code>seisin ui</code> printed, or run <code>seisin ui --link</code>.";
      applyState(demoState());
      draw();
      route();   // sets ROLE, so a reload on a role's page draws that role
      bootDemoRuns();
      show(route());
      openPending(demoView());
      return;
    }

    LIVE = true;
    applyState(s);
    LIVE_LABEL = s.config.replace(/^.*\//, "") + " · live";
    if (LAUNCHER) LIVE_LABEL += " · read only";
    label.textContent = LIVE_LABEL;
    label.title = LIVE_LABEL;
    label.style.color = "var(--green)";
    // Read only nothing waits on the person here: what a run asked for is asked for where it was launched.
    if (READONLY) document.getElementById("nav-req").hidden = true;
    document.getElementById("toml-note").textContent = "the file on disk, as it stands";
    document.getElementById("foot-mode").textContent = READONLY ? "Live, read only." : "Live.";
    document.getElementById("foot-text").innerHTML = READONLY
      ? "This page reads <b>" + esc(s.config) + "</b> and the log on disk. Nothing is written from here: " +
        "the territory is lent by " + esc(LAUNCHER) + ", and access is asked for there."
      : "This page reads <b>" + esc(s.config) + "</b> and the log on disk. Two actions write, each in place and stamped " +
      "with its reason: a decision on a request, and saving a control-files change after its preview. Territories " +
      "and keys are changed in seisin.toml itself.";
    draw();
    if (HAS_RUNS) await addRuns();
    show(route());
    // Opened on a role (a reload, a link to a run): that role's cut, and the run it names.
    if (HAS_RUNS && route() === "role") { var g2 = await fetchRuns(true); if (g2.v) { drawRunsAll(g2.v); openPending(g2.v); } }
    poll();
  }

  /* ── a directory of runs ──────────────────────────────────────────────────
   * `seisin ui --runs`: every run, filtered and summed, read only. One run opens
   * as the console always looked — its policy, its denials, its log — with no
   * grant on it. */
  var RFILTER = (function(){
    var q = new URLSearchParams(location.search), out = {};
    ["since", "team", "role", "work_item", "status", "outcome", "q"].forEach(function(k){ var v = q.get(k); if (v) out[k] = v; });
    return out;
  })();
  var RLAST = { url: null, etag: null, v: null };

  function runsUrl(){
    var q = new URLSearchParams();
    Object.keys(RFILTER).forEach(function(k){ if (RFILTER[k]) q.set(k, RFILTER[k]); });
    // On a role's page, every run cut to what that role did in it.
    if (ROLE && /^#role\//.test(location.hash)) q.set("srole", ROLE);
    var s = q.toString();
    return "/api/runs" + (s ? "?" + s : "");
  }
  async function fetchRuns(fresh){
    if (!LIVE && DEMO_SHIFTED) return { v: demoView() };
    var url = runsUrl();
    var h = { "x-seisin-token": TOKEN };
    if (!fresh && RLAST.etag && RLAST.url === url) h["if-none-match"] = RLAST.etag;
    var r = await fetch(url, { cache: "no-store", headers: h });
    if (r.status === 304) return { same: true };
    if (!r.ok) return { status: r.status };
    var v = await r.json();
    RLAST = { url: url, etag: r.headers.get("etag"), v: v };
    return { v: v };
  }

  function runMeta(r){
    var bits = [];
    if (r.team) bits.push("team <b>" + esc(r.team) + "</b>");
    if (r.role) bits.push("role <b>" + esc(r.role) + "</b>");
    if (r.work_item) bits.push("<b>" + esc(r.work_item) + "</b>");
    if (r.repo) bits.push("repo " + esc(r.repo));
    if (r.status) bits.push("status " + esc(r.status));
    var w = when(r.started_at || "");
    if (w.text) bits.push('started <span title="' + escA(w.title) + '">' + esc(w.text) + "</span>");
    return bits.join(" · ");
  }
  function outcomeTag(o, dropped){
    var says = { clean: "clean", denied: "denied", refused: "canary failed", unread: "policy unreadable", "no-record": "no record" };
    // A run whose system log dropped kernel messages: its walls may be missing some.
    var lost = dropped ? ' <span class="oc refused" title="the system log dropped ' + escA(String(dropped)) +
      ' batch(es) of kernel messages during this run: denials may be missing from its record">record incomplete</span>' : "";
    return '<span class="oc ' + escA(o) + '">' + esc(says[o] || o) + "</span>" + lost;
  }


  function drawRunsView(v){
    document.getElementById("rn-count").textContent = v.totals.runs === v.total
      ? plural(v.total, "run") : plural(v.totals.runs, "run") + " of " + v.total;
    pill("runs-pin", v.total, v.total === 1 ? "run" : "runs");

    var t = v.totals, k = t.byKind || {};
    function card(cls, title, n, sub){
      return '<div class="card kpi ' + cls + '"><h2>' + esc(title) + '</h2><div class="n">' + esc(Number(n).toLocaleString()) +
        '</div><div class="s">' + sub + "</div></div>";
    }
    document.getElementById("rn-kpis").innerHTML =
      card("b", "runs", t.runs, (t.outcome.denied || 0) + " denied something · " + (t.outcome.clean || 0) + " clean") +
      card(t.outcome.refused ? "a" : "g", "canary failed", t.outcome.refused || 0, "runs that never started") +
      (t.outcome["no-record"] ? card("a", "no record", t.outcome["no-record"], "runs with nothing that says the boundary held") : "") +
      (t.incomplete ? card("a", "record incomplete", t.incomplete, "runs whose system log dropped kernel messages") : "") +
      (function(){
        var p = (v.attention && v.attention.piles) || null;
        if (!p) return card(t.denied ? "a" : "g", "denied", t.denied, (k.file || 0).toLocaleString() + " files · " + (k.network || 0).toLocaleString() + " network");
        var need = p.decide.denials + p.outside.denials + p.handoff.denials;
        return card(need ? "a" : "g", "need a person", need, "denials · +" + (p.protected.denials + p.expected.denials).toLocaleString() + " the boundary working");
      })() +
      card(t.retried ? "a" : "g", "spent retrying", t.retried, "calls after the first denial of the same thing");

    var causes = v.causes || [];
    document.getElementById("rn-causes-n").textContent = causes.length ? String(causes.length) : "";
    document.getElementById("rn-causes").innerHTML = causes.length
      ? "<thead><tr><th>stands</th><th>denied</th><th>what</th><th class=num>runs</th><th class=num>times</th><th>teams</th><th>roles</th></tr></thead><tbody>" +
        causes.map(function(c){
          return '<tr class="' + (c.about === "system" ? "sys" : "") + '"><td>' + classTag(c.class) + "</td><td>" + esc(c.action) + "</td><td><code>" + esc(c.target) +
            '</code><div class="ro-ask">' + esc(c.hint || c.why || "") + "</div></td><td class=num>" + c.runs + "</td><td class=num>" + c.times + "</td><td>" + esc((c.teams || []).join(", ")) +
            "</td><td>" + esc((c.roles || []).join(", ")) + "</td></tr>";
        }).join("") + "</tbody>"
      : '<tbody><tr><td class="blank quiet">Nothing denied in these runs.</td></tr></tbody>';

    var SHOWN = 300, runs = v.runs || [];
    document.getElementById("rn-list").innerHTML = runs.length
      ? "<thead><tr><th>run</th><th>started</th><th>team</th><th>role</th><th>work item</th><th>status</th><th>outcome</th>" +
        '<th class=num title="denials that need a person: no owner, outside, another role">needs</th><th class=num title="denials that are the boundary working: protected on purpose, expected">boundary</th><th class=num>retried</th><th>hosts denied</th></tr></thead><tbody>' +
        runs.slice(0, SHOWN).map(function(r){
          var w = when(r.started_at || "");
          var ran = r.roles_ran || [];
          var into = ran.indexOf(r.role) !== -1 ? r.role : ran[ran.length - 1];
          var href = into ? "#role/" + encodeURIComponent(into) + "/run/" + encodeURIComponent(r.id) : "./?run=" + encodeURIComponent(r.id) + "#denied";
          return "<tr><td><a href=\"" + escA(href) + "\"><code>" + esc(r.run_id || r.id) + "</code></a></td>" +
            '<td title="' + escA(w.title || "") + '">' + esc(w.text || "") + "</td><td>" + esc(r.team || "") + "</td><td>" + esc(r.role || "") +
            "</td><td>" + esc(r.work_item || "") + "</td><td>" + esc(r.status || "") + "</td><td>" + outcomeTag(r.outcome, r.dropped) +
            "</td><td class=num>" + needsOf(r) + "</td><td class=num>" + workingOf(r) + "</td><td class=num>" + r.retried + "</td><td>" +
            (r.hosts || []).slice(0, 3).map(function(h){ return "<code>" + esc(h.target) + "</code>"; }).join(" ") + "</td></tr>";
        }).join("") + "</tbody>"
      : '<tbody><tr><td class="blank quiet">' + (v.total ? "No run matches these filters." : "No runs in " + esc(v.dir) + " yet.") + "</td></tr></tbody>";
    var more = document.getElementById("rn-more");
    more.hidden = runs.length <= SHOWN;
    more.textContent = "Showing the newest " + SHOWN + " of " + runs.length + ": narrow the filters for the rest.";
  }

  /* ── attention ───────────────────────────────────────────────────────────
   * Where each denial stands, in the five words the CLI uses too (views.js classOf):
   * no owner, outside and another role's need a person; protected and expected are the
   * boundary working, counted and kept off the top. */
  var CLASS_LABEL = { decide: "no owner", outside: "outside", handoff: "other role", protected: "protected", expected: "expected", granted: "granted since" };
  var CLASS_WHAT = {
    decide: "no role owns it: a decision nobody has made",
    outside: "a host, a port, a key or a path outside the repository: the allow list's question",
    handoff: "another role's territory: work to hand over, or a territory drawn wrong",
    protected: "closed to every role on purpose: the boundary working",
    expected: "the agent program's own housekeeping, denied correctly: nothing to do",
    granted: "the policy gives it to this role now: denied before the grant, nothing left to do"
  };
  function classTag(c){
    c = c || "decide";
    return '<span class="cl ' + escA(c) + '" title="' + escA(CLASS_WHAT[c] || "") + '">' + esc(CLASS_LABEL[c] || c) + "</span>";
  }
  function needsOf(r){ var b = r.byClass || {}; return (b.decide || 0) + (b.outside || 0) + (b.handoff || 0); }
  function workingOf(r){ var b = r.byClass || {}; return (b.protected || 0) + (b.expected || 0); }

  /** The shared filter: every value any run has, with how many runs have it. */
  function drawFilters(v){
    // The filters: every value any run has, with how many runs have it.
    document.querySelectorAll("#rn-filters select").forEach(function(sel){
      var f = sel.dataset.f;
      // The window has its own options; it only shows which one is on.
      if (sel.dataset.fixed) { sel.value = RFILTER[f] || ""; return; }
      var opts = (v.facets[f] || []);
      var cur = RFILTER[f] || "";
      sel.innerHTML = '<option value="">all</option>' + opts.map(function(o){
        return '<option value="' + escA(o.value) + '"' + (o.value === cur ? " selected" : "") + ">" + esc(o.value) + " (" + o.runs + ")</option>";
      }).join("");
      sel.disabled = !opts.length;
      // A repository's own runs have no team or work item: the filter is left out rather than offered empty.
      sel.closest("label").hidden = !opts.length;
    });
  }

  function drawRunsAll(v){
    try { drawFilters(v); } catch (e) { console.error("seisin: drawFilters failed", e); }
    try { drawRolesNav(v.roles || []); } catch (e) { console.error("seisin: drawRolesNav failed", e); }
    if (v.filters && v.filters.srole) {
      try { drawRole(v); } catch (e) { console.error("seisin: drawRole failed", e); }
      return;
    }
    drawRunsView(v);
    try { drawOverview(v); } catch (e) { console.error("seisin: drawOverview failed", e); }
  }

  /* Shared by the overview and a role's page: the same list, the same days, the same five places. */
  function needsRows(top, limit, withRoles){
    return "<thead><tr><th class=num>runs</th><th>stands</th><th>what was denied</th><th>why it is denied</th><th>" + (withRoles ? "who" : "where") + "</th><th>last</th></tr></thead><tbody>" +
      top.slice(0, limit).map(function(c, i){
        var who = [];
        if (withRoles && c.roles && c.roles.length) who.push(c.roles.slice(0, 3).join(", ") + (c.roles.length > 3 ? " +" + (c.roles.length - 3) : ""));
        if (c.teams && c.teams.length) who.push(c.teams.slice(0, 3).join(", ") + (c.teams.length > 3 ? " +" + (c.teams.length - 3) : ""));
        if (c.work_item_count) who.push(c.work_item_count === 1 ? "1 work item" : c.work_item_count + " work items");
        var w = when(c.last_at || "");
        return '<tr class="' + (i < 3 ? "lead" : "") + '"><td class=num>' + c.runs.toLocaleString() + "</td><td>" + classTag(c.class) +
          (c.new ? '<span class="cl new" title="first seen in the last 24 hours">new</span>' : "") + "</td><td>" + esc(c.action) +
          " <code>" + esc(c.target) + "</code>" + (c.times > c.runs ? ' <span class="ro-ask">' + c.times.toLocaleString() + " times</span>" : "") +
          (c.places ? ' <span class="ro-ask" title="' + escA((c.where || []).map(function(x){ return x.target + " (" + x.runs + " runs)"; }).join("\n") +
            (c.places > (c.where || []).length ? "\n…" : "")) + '">in ' + c.places.toLocaleString() + " places</span>" : "") +
          '</td><td class="why">' + esc(c.hint || c.why || CLASS_WHAT[c.class] || "") + '</td><td class="who">' + esc(who.join(" · ")) + "</td><td>" +
          esc(w.text || "") + "</td></tr>";
      }).join("") + "</tbody>";
  }
  function daysHtml(days){
    var max = Math.max.apply(null, days.map(function(d){ return d.needs; }).concat([1]));
    var DAYNAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return '<div class="days" role="img" aria-label="denials that need a person, per day, over the last 14 days">' +
      days.map(function(d){
        var pct = d.needs ? Math.max(3, Math.round(d.needs / max * 100)) : 0;
        var tip = d.day + ": " + d.runs + (d.runs === 1 ? " run" : " runs") + " · " + d.needs.toLocaleString() + " needing a person · " +
          d.boundary.toLocaleString() + " the boundary working" + (d.refused ? " · " + d.refused + " canary failed" : "");
        return '<div class="d' + (d.needs ? "" : " zero") + '" title="' + escA(tip) + '"><i style="height:' + pct + '%"></i></div>';
      }).join("") + "</div>" +
      '<div class="days-axis">' + days.map(function(d, i){
        var dt = new Date(d.day + "T12:00:00");
        return "<span>" + (i === days.length - 1 ? "today" : (i % 2 ? "" : DAYNAMES[dt.getDay()] + " " + dt.getDate())) + "</span>";
      }).join("") + "</div>" +
      '<p class="days-sum">' + days.reduce(function(n, d){ return n + d.runs; }, 0).toLocaleString() + " runs in these 14 days · " +
      days.reduce(function(n, d){ return n + d.needs; }, 0).toLocaleString() + " denials needing a person</p>";
  }
  function pilesHtml(p){
    var order = ["decide", "outside", "handoff", "protected", "expected"];
    var total = order.reduce(function(n, c){ return n + p[c].denials; }, 0) || 1;
    return "<thead><tr><th>stands</th><th class=num>denials</th><th class=num>share</th><th class=num>runs</th><th>what it asks of you</th></tr></thead><tbody>" +
      order.map(function(c){
        var quiet = c === "protected" || c === "expected";
        return '<tr class="' + (quiet ? "quiet" : "") + '"><td>' + classTag(c) + "</td><td class=num>" + p[c].denials.toLocaleString() +
          "</td><td class=num>" + Math.round(p[c].denials / total * 100) + "%</td><td class=num>" + p[c].runs.toLocaleString() +
          '</td><td class="what">' + esc(CLASS_WHAT[c]) + "</td></tr>";
      }).join("") + "</tbody>";
  }
  function kpiCard(cls, title, n, sub, href){
    return '<a class="card kpi ' + cls + '" href="' + (href || "#overview") + '"><h2>' + esc(title) + '</h2><div class="n">' +
      esc(typeof n === "number" ? n.toLocaleString() : n) + '</div><div class="s">' + sub + "</div></a>";
  }
  function healthCards(a, href){
    var h = a.health, p = a.piles;
    var need = p.decide.denials + p.outside.denials + p.handoff.denials;
    var working = p.protected.denials + p.expected.denials;
    // With no run there is nothing to say held: the canary has not been tried.
    return (!h.runs ? kpiCard("", "boundary", "—", "no run yet: <code>seisin run &lt;role&gt; -- &lt;agent&gt;</code>", href) : kpiCard(h.refused ? "a" : "g", "boundary",
        h.refused ? h.refused.toLocaleString() + " failed" : "held",
        h.refused ? "runs whose canary failed: nothing ran" : "canary passed in every run that has one", href)) +
      (h.incomplete || h.noRecord ? kpiCard("a", "record", (h.incomplete + h.noRecord).toLocaleString(),
        [h.incomplete ? h.incomplete + " with kernel messages dropped" : "", h.noRecord ? h.noRecord + " with no record" : ""].filter(Boolean).join(" · "), href) : "") +
      kpiCard(need ? "a" : "g", "need a person", a.needs, (a.needs === 1 ? "thing" : "things") + (a.paths !== a.needs ? " in " + a.paths.toLocaleString() + " places" : "") + " · " + need.toLocaleString() + " denials", href) +
      kpiCard(a.fresh ? "a" : "g", "new today", a.fresh, a.fresh ? "first seen in the last 24 h" : "nothing new in the last 24 h", href) +
      kpiCard("", "boundary working", working, "protected " + p.protected.denials.toLocaleString() + " · expected " + p.expected.denials.toLocaleString(), href);
  }

  /** The roles in the sidebar: a name that shares its prefix with two or more others is folded under it. */
  var ROLES_SEEN = [];
  function drawRolesNav(roles){
    ROLES_SEEN = roles;
    var box = document.getElementById("nav-roles");
    if (!box) return;
    // No prototype: a role named constructor-one must not find Object's own constructor.
    var groups = Object.create(null);
    roles.forEach(function(r){ var m = /^([^-]+)-./.exec(r.name); if (m) (groups[m[1]] = groups[m[1]] || []).push(r); });
    var folded = Object.create(null);
    Object.keys(groups).forEach(function(k){ if (groups[k].length >= 3) groups[k].forEach(function(r){ folded[r.name] = k; }); });
    function link(r){
      var on = route() === "role" && ROLE === r.name;
      return '<a href="#role/' + escA(encodeURIComponent(r.name)) + '" class="' + (on ? "on" : "") + (r.def ? "" : " gone") + '" title="' +
        escA(r.def ? r.runs + " runs" : "not in the newest policy: only its past runs") + '"><i>' + (r.health.refused ? "!" : "·") + "</i>" +
        esc(r.name) + '<span class="pin">' + (r.needs ? esc(String(r.needs)) : "") + "</span></a>";
    }
    var done = Object.create(null), out = "";
    roles.forEach(function(r){
      var g = folded[r.name];
      if (!g) { out += link(r); return; }
      if (done[g]) return;
      done[g] = true;
      var members = groups[g];
      var needs = members.reduce(function(n, x){ return n + x.needs; }, 0);
      var open = route() === "role" && members.some(function(x){ return x.name === ROLE; });
      out += "<details" + (open ? " open" : "") + '><summary title="' + escA(members.length + " roles") + '">' + esc(g) + "-*" +
        '<span class="pin">' + (needs ? needs : "") + "</span></summary>" + members.map(link).join("") + "</details>";
    });
    var keep = box.querySelector("details[open]") ? Array.from(box.querySelectorAll("details")).map(function(d){ return d.open; }) : null;
    box.innerHTML = out;
    if (keep) box.querySelectorAll("details").forEach(function(d, i){ if (keep[i]) d.open = true; });
  }

  function drawOverview(v){
    var a = v.attention;
    if (!a) return;
    var waiting = !READONLY && REQS && REQS.length;
    document.getElementById("at-kpis").innerHTML =
      (waiting ? kpiCard("b", "waiting on you", REQS.length, REQS.length === 1 ? "request to decide" : "requests to decide", "#requests") : "") +
      healthCards(a);
    pill("att-pin", a.needs, a.needs === 1 ? "thing needs a person" : "things need a person");

    // Every role, worst first: the page's main table.
    var roles = v.roles || [];
    document.getElementById("ov-roles").innerHTML = roles.length
      ? "<thead><tr><th>role</th>" + (waiting ? "<th class=num>waiting on you</th>" : "") + "<th class=num>runs</th><th class=num>needs a person</th><th>the most of it</th><th>boundary</th><th>last run</th></tr></thead><tbody>" +
        roles.map(function(r){
          var asks = waiting ? REQS.filter(function(q){ return q.role === r.name; }).length : 0;
          var w = when(r.last_at || "");
          var bound = r.health.refused ? '<span class="oc refused">' + r.health.refused + " canary failed</span>"
            : r.runs ? '<span class="oc clean">held</span>' : "";
          return '<tr class="' + (r.runs ? "" : "idle") + '"><td><a href="#role/' + escA(encodeURIComponent(r.name)) + '">' + esc(r.name) + "</a>" +
            (r.def ? "" : ' <span class="ro-ask" title="not in the newest policy">past</span>') + "</td>" +
            (waiting ? "<td class=num>" + (asks ? '<a href="#role/' + escA(encodeURIComponent(r.name)) + '"><b>' + asks + "</b></a>" : "") + "</td>" : "") +
            "<td class=num>" + r.runs.toLocaleString() +
            "</td><td class=num>" + (r.needs ? r.needs.toLocaleString() : "—") + '</td><td class="top">' +
            (r.top ? classTag(r.top.class) + " " + esc(r.top.action) + " <code>" + esc(r.top.target) + "</code>" : (r.runs ? "nothing" : "never ran")) +
            "</td><td>" + bound + "</td><td>" + esc(w.text || "") + "</td></tr>";
        }).join("") + "</tbody>"
      : '<tbody><tr><td class="blank quiet">No role has run yet.</td></tr></tbody>';

    var top = a.top || [];
    var SHOW = SHOW_ALL_ATT ? top.length : 8;
    document.getElementById("at-need-note").textContent = a.needs
      ? "every role, by how many runs hit it · " + (top.length < a.needs ? "the first " + top.length + " of " + a.needs.toLocaleString() : a.needs.toLocaleString() + " in all")
      : "";
    document.getElementById("at-list").innerHTML = top.length ? needsRows(top, SHOW, true)
      : '<tbody><tr><td class="blank quiet">' + (v.totals.runs
          ? "Nothing needs a person: every denial in these runs was protected on purpose or expected."
          : (v.total ? "No run matches these filters." : "No runs yet. Start one with <code>seisin run &lt;role&gt; -- &lt;agent&gt;</code>; each line it logs names its run.")) + "</td></tr></tbody>";
    var more = document.getElementById("at-more");
    more.hidden = top.length <= 8;
    more.innerHTML = '<a href="#overview" id="at-toggle">' + (SHOW_ALL_ATT ? "show the first 8" : "show all " + top.length) + "</a>";
    var t = document.getElementById("at-toggle");
    if (t) t.onclick = function(e){ e.preventDefault(); SHOW_ALL_ATT = !SHOW_ALL_ATT; drawOverview(v); };
    document.getElementById("at-days").innerHTML = daysHtml(a.days || []);
    document.getElementById("at-piles").innerHTML = pilesHtml(a.piles);
  }
  var SHOW_ALL_ATT = false;

  /* ── one role ───────────────────────────────────────────────────────────── */
  var ROLE = null;
  var OPEN_RUNS = {};
  var SHOW_ALL_ROLE = false;
  function drawRole(v){
    var info = (v.roles || []).find(function(r){ return r.name === ROLE; }) || { name: ROLE, def: null, health: {} };
    var d = info.def;
    function codes(list, none){ return list && list.length ? list.map(function(x){ return "<code>" + esc(String(x)) + "</code>"; }).join("") : '<span class="ro-ask">' + none + "</span>"; }
    document.getElementById("v-title").textContent = ROLE;
    document.getElementById("rl-head").innerHTML =
      "<dl>" +
      (d ? "<dt>writes</dt><dd>" + codes(d.writes, "nothing") + "</dd>" +
        "<dt>reads</dt><dd>" + esc(d.read === "territory" ? "only its territory, and what the policy opens" : "the machine, except keys, other roles' credentials and protected places") + "</dd>" +
        "<dt>keys</dt><dd>" + codes(d.keys, "none") + "</dd>" +
        "<dt>network</dt><dd>" + codes(d.network, "no host") + (d.localPorts ? " · local ports " + codes(d.localPorts, "") : "") + "</dd>" +
        "<dt>held by</dt><dd>" + esc(d.sandbox || "the default: tartaros, or sandbox-runtime where tartaros is not installed") + "</dd>"
        : "") +
      "</dl>" +
      (d ? '<p class="ro-ask" style="margin:8px 0 0">As the newest policy says it' + (MODE === "runs" ? " (the newest run's)" : "") + ".</p>"
         : '<p class="gone">Not in the newest policy: this page shows only its past runs.</p>') +
      "";
    var a = v.attention;
    document.getElementById("rl-kpis").innerHTML = healthCards(a, "#role/" + encodeURIComponent(ROLE));
    var top = a.top || [];
    var SHOW = SHOW_ALL_ROLE ? top.length : 10;
    document.getElementById("rl-need-note").textContent = a.needs ? "by how many of its runs hit it" : "";
    document.getElementById("rl-list").innerHTML = top.length ? needsRows(top, SHOW, false)
      : '<tbody><tr><td class="blank quiet">' + (v.totals.runs ? "Nothing needs a person: every denial this role had was protected on purpose or expected." : "This role has no runs in this window.") + "</td></tr></tbody>";
    var more = document.getElementById("rl-list-more");
    more.hidden = top.length <= 10;
    more.innerHTML = '<a href="#" id="rl-toggle">' + (SHOW_ALL_ROLE ? "show the first 10" : "show all " + top.length) + "</a>";
    var t = document.getElementById("rl-toggle");
    if (t) t.onclick = function(e){ e.preventDefault(); SHOW_ALL_ROLE = !SHOW_ALL_ROLE; drawRole(v); };
    document.getElementById("rl-days").innerHTML = daysHtml(a.days || []);
    document.getElementById("rl-piles").innerHTML = pilesHtml(a.piles);

    // Its runs, each opening in place as this role lived it.
    var SHOWN = 200, runs = v.runs || [];
    document.getElementById("rl-runs-note").textContent = runs.length
      ? plural(v.totals.runs, "run") + " · newest first · open one to see it in order" : "";
    var body = runs.slice(0, SHOWN).map(function(r){
      var w = when(r.started_at || "");
      var open = !!OPEN_RUNS[r.id];
      return '<tr class="run' + (open ? " open" : "") + '" data-run="' + escA(r.id) + '"><td><code>' + esc(shortId(r.run_id || r.id)) + '</code></td><td title="' + escA(w.title || "") + '">' + esc(w.text || "") +
        "</td><td>" + esc(r.team || "") + "</td><td>" + esc(r.work_item || "") + "</td><td>" + esc(r.role || "") + "</td><td>" + esc(r.status || "") + "</td><td>" +
        outcomeTag(r.outcome, r.dropped) + "</td><td class=num>" + needsOf(r) + "</td><td class=num>" + workingOf(r) + "</td></tr>" +
        (open ? '<tr class="tl"><td colspan="9" id="tl-' + escA(r.id) + '">' + (TIMELINES[r.id + "|" + ROLE] ? timelineHtml(TIMELINES[r.id + "|" + ROLE]) : "Reading…") + "</td></tr>" : "");
    }).join("");
    document.getElementById("rl-runs").innerHTML = runs.length
      ? '<thead><tr><th>run</th><th>started</th><th>team</th><th>work item</th><th title="the launcher\'s word for the run">launched as</th><th>status</th><th>outcome</th>' +
        '<th class=num title="denials that need a person">needs</th><th class=num title="denials that are the boundary working">boundary</th></tr></thead><tbody>' + body + "</tbody>"
      : '<tbody><tr><td class="blank quiet">No run of this role matches these filters.</td></tr></tbody>';
    var m = document.getElementById("rl-more");
    m.hidden = runs.length <= SHOWN;
    m.textContent = "Showing the newest " + SHOWN + " of " + runs.length + ": narrow the window or the filters for the rest.";
    document.querySelectorAll("#rl-runs tr.run").forEach(function(tr){
      tr.onclick = function(){ toggleRun(tr.dataset.run, v); };
    });
  }
  function shortId(id){ return id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-6) : id; }

  var TIMELINES = {};
  async function toggleRun(id, v){
    // The role this run was opened under: the person may be on another role's page by the time it answers.
    var role = ROLE, key = id + "|" + role;
    OPEN_RUNS[id] = !OPEN_RUNS[id];
    drawRole(v);
    if (!OPEN_RUNS[id] || TIMELINES[key]) return;
    if (!LIVE && DEMO_SHIFTED) TIMELINES[key] = DEMO_SHIFTED.timelines[key] || { error: "not in the example" };
    else try {
      var r = await fetch("/api/timeline?run=" + encodeURIComponent(id) + "&role=" + encodeURIComponent(role), { cache: "no-store", headers: { "x-seisin-token": TOKEN } });
      var t = await r.json();
      TIMELINES[key] = r.ok ? t : { error: t.error || "could not read this run" };
    } catch (e) { TIMELINES[key] = { error: whyFailed(e) }; }
    if (ROLE !== role) return;
    var cell = document.getElementById("tl-" + id);
    if (cell) cell.innerHTML = timelineHtml(TIMELINES[key]);
  }
  function timelineHtml(t){
    if (t.error) return '<span class="err">' + esc(t.error) + "</span>";
    // Local time, as every other date on the page.
    function at(s){
      var d = s ? new Date(s) : null;
      return d && !isNaN(d) ? '<span class="t" title="' + escA(s) + '">' + esc(d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })) + "</span>" : '<span class="t">—</span>';
    }
    var items = t.events.map(function(e){
      if (e.type === "canary") return '<li class="' + (e.confined ? "ok" : "bad") + '">' + at(e.at) + (e.confined
        ? "canary passed" + (e.sandbox ? " under " + esc(e.sandbox) : "") + ": the boundary held, the agent started"
        : "<b>canary failed</b>: " + esc((e.reasons || []).join("; ")) + " — nothing ran") + "</li>";
      if (e.type === "narrowed") return '<li class="quiet">' + at(e.at) + "policy narrowed for this run</li>";
      if (e.type === "dropped") return '<li class="bad">' + at(e.at) + "the system log dropped " + e.batches + " batch(es): denials may be missing from here</li>";
      var quiet = e.class === "protected" || e.class === "expected";
      return '<li class="' + (quiet ? "quiet" : "bad") + '">' + at(e.at) + classTag(e.class) + " " + esc(e.action) + " <code>" + esc(e.target) + "</code>" +
        (e.times > 1 ? " ×" + e.times : "") + (e.probe ? ' <span class="ro-ask">the canary\'s own probe</span>' : "") +
        (e.likely ? ' <span class="ro-ask">most likely ' + esc(e.likely) + "</span>" : "") +
        (e.why && !quiet ? ' <span class="ro-ask">— ' + esc(e.why) + "</span>" : "") + "</li>";
    });
    if (!items.length) items.push('<li class="quiet">nothing recorded for this role in this run</li>');
    return '<ul class="tl-list">' + items.join("") + "</ul>" +
      '<div class="tl-foot">' + (t.allowed ? t.allowed.toLocaleString() + " allowed · " : "") + (t.more ? t.more + " more denials not listed · " : "") +
      "</div>" + askedHtml(t) + heldHtml(t);
  }
  /** What an archived run asked for: never granted here, asked for where it was launched. */
  function askedHtml(t){
    var qs = t.requests || [];
    if (!qs.length) return "";
    return '<div class="tl-foot">asked for, and not given — ask for it ' + esc(askedOf()) + ": " + qs.map(function(q){
      return q.error ? '<span class="err">' + esc(q.error) + "</span>"
        : esc(q.action) + " <code>" + esc(q.grant || q.target) + "</code>" + (q.times > 1 ? " ×" + q.times : "");
    }).join(" · ") + "</div>";
  }
  /** What the role could do in this run: the policy it held under, and what --only and --deny took away. */
  function heldHtml(t){
    var h = t.held, n = t.narrowed;
    if (!h && !n) return "";
    function list(xs){ return xs && xs.length ? xs.map(function(x){ return "<code>" + esc(x) + "</code>"; }).join(" ") : "none"; }
    var rows = [];
    if (h) rows.push("<dt>writes</dt><dd>" + list(h.writes) + "</dd>", "<dt>keys</dt><dd>" + list(h.keys) + "</dd>",
                     "<dt>network</dt><dd>" + list(h.network) + "</dd>");
    if (n && n.only && n.only.length) rows.push("<dt>only, this run</dt><dd>" + list(n.only) + "</dd>");
    if (n && n.deny && n.deny.length) rows.push("<dt>denied, this run</dt><dd>" + list(n.deny) + "</dd>");
    if (n && n.vars && n.vars.length) rows.push("<dt>variables given</dt><dd>" + list(n.vars) + "</dd>");
    // Only the run's own policy is called the one it held under; otherwise it is today's, and says so.
    var title = t.held_from === "run" || !h ? "the policy it held under"
      : "the policy today — seisin.toml has changed since this run, and what it held is not kept";
    return '<details class="tl-held"><summary>' + esc(title) + '</summary><div class="role-head"><dl>' + rows.join("") + "</dl></div></details>";
  }

  function setRunFilter(k, val){
    if (val) RFILTER[k] = val; else delete RFILTER[k];
    var q = new URLSearchParams();
    Object.keys(RFILTER).forEach(function(x){ q.set(x, RFILTER[x]); });
    // The hash too: on a role's page the filter applies to that role.
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    fetchRuns(true).then(function(g){ if (g.v) drawRunsAll(g.v); }).catch(function(){});
  }

  /** The filters, once. */
  function wireRuns(){
    document.querySelectorAll("#rn-filters select").forEach(function(sel){
      sel.addEventListener("change", function(){ setRunFilter(sel.dataset.f, sel.value); });
    });
    var q = document.getElementById("rn-q");
    q.value = RFILTER.q || "";
    var tq = null;
    q.addEventListener("input", function(){ clearTimeout(tq); tq = setTimeout(function(){ setRunFilter("q", q.value.trim()); }, 250); });
  }
  /** Read while they are on screen: a directory of hundreds has nothing to say to another view. */
  function pollRuns(){
    setTimeout(async function(){
      var rt = route();
      if (rt === "runs" || rt === "overview" || rt === "role") try {
        var g = await fetchRuns(false);
        if (g.v) drawRunsAll(g.v);
        if (MODE === "runs") {
          if (g.v || g.same) { FAILS = 0; if (OFFLINE) setOffline(null); }
          else if (++FAILS >= 2) setOffline(g.status === 403 ? "expired" : "down");
        }
      } catch (_) { if (MODE === "runs" && ++FAILS >= 2) setOffline("down"); }
      pollRuns();
    }, 2000);
  }
  /** Runs beside a policy: one more item in the menu. */
  async function addRuns(){
    var got = await fetchRuns(true);
    // A repository with no run yet is read the same way: every role of its policy, none run.
    if (!got.v) { HAS_RUNS = false; return; }
    document.getElementById("nav-runs").hidden = false;
    document.body.classList.add("by-roles");
    wireRuns();
    drawRunsAll(got.v);
    pollRuns();
    openLinked(got.v);
  }

  /** `&run=<id>` from a launcher's link: that run, open under the role it ran as. */
  function openLinked(v){
    if (!LINKED_RUN) return;
    var id = LINKED_RUN, r = (v.runs || []).filter(function(x){ return x.id === id; })[0];
    LINKED_RUN = null;
    var role = r && ((r.roles_ran && r.roles_ran[0]) || null);
    if (role) { location.hash = "role/" + encodeURIComponent(role) + "/run/" + encodeURIComponent(id); return; }
    setRunFilter("q", id);
    location.hash = "runs";
  }

  /* ── the example's runs ───────────────────────────────────────────────────
   * Opened as a file, the Overview, each role's page and each run are drawn from
   * DEMO_RUNS (ui/demo.js): made-up runs, computed by the server's own code. Its
   * dates are fixed; they are moved here to end today. The filter is left out:
   * every view of the example is the whole example. */
  var DEMO_SHIFTED = null;
  function shiftDates(x, ms, days){
    if (Array.isArray(x)) return x.map(function(y){ return shiftDates(y, ms, days); });
    if (x && typeof x === "object") {
      var o = {};
      Object.keys(x).forEach(function(k){
        var y = x[k];
        o[k] = k === "day" && typeof y === "string" && /^\d{4}-\d{2}-\d{2}$/.test(y)
          ? new Date(Date.parse(y + "T12:00:00Z") + days * 864e5).toISOString().slice(0, 10)
          : shiftDates(y, ms, days);
      });
      return o;
    }
    if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x)) return new Date(Date.parse(x) + ms).toISOString();
    return x;
  }
  function bootDemoRuns(){
    if (typeof DEMO_RUNS === "undefined") return;
    var days = Math.round((Date.now() - Date.parse(DEMO_RUNS.generated)) / 864e5);
    DEMO_SHIFTED = shiftDates(DEMO_RUNS, days * 864e5, days);
    HAS_RUNS = true;
    document.getElementById("nav-runs").hidden = false;
    document.body.classList.add("by-roles", "demo-runs");
    drawRunsAll(demoView());
  }
  /** The view a live console would have answered: the whole example, or one role's cut of it. */
  function demoView(){
    var on = ROLE && /^#role\//.test(location.hash) && DEMO_SHIFTED.views[ROLE];
    return on || DEMO_SHIFTED.views[""];
  }

  /** Runs with no policy (`seisin ui --runs`): the rest of the menu has nothing to show. */
  async function bootRuns(){
    var label = document.getElementById("source");
    var got = await fetchRuns(true);
    if (!got.v) {
      label.textContent = got.status === 403 ? "link expired — open the new one" : "the console did not answer";
      label.style.color = "var(--amber)";
      return;
    }
    LIVE = true;
    LIVE_LABEL = "runs · read only";
    label.textContent = LIVE_LABEL;
    label.style.color = "var(--green)";
    document.getElementById("nav-runs").hidden = false;
    document.querySelectorAll(".side .list > a[href^='#']").forEach(function(a){ a.hidden = true; });
    document.getElementById("foot-mode").textContent = "Live, read only.";
    document.getElementById("foot-text").innerHTML = "This page reads the runs in <b>" + esc(got.v.dir) +
      "</b>, one folder each, as their launcher archived them. Nothing is written from here.";
    wireRuns();
    drawRunsAll(got.v);
    show(route());
    if (route() === "role") { var g2 = await fetchRuns(true); if (g2.v) { drawRunsAll(g2.v); openPending(g2.v); } }
    pollRuns();
    openLinked(got.v);
  }

  /** Every two seconds after the last answer, not every two seconds regardless. */
  function poll(){
    setTimeout(async function(){
      try { await refresh(); } finally { poll(); }
    }, 2000);
  }

  /* ── the views ────────────────────────────────────────────────────────────
   * Hash routing and not a framework: this page is one file a server hands over whole, and
   * it has to keep working opened straight off the disk with no server at all. */
  function views(){
    return {
      overview:   {view:"overview", title:"Overview",
                   sub:"Whether the boundary held, every role at a glance, and what needs a person. Denials that are the boundary working are counted, not listed."},
      role:       {view:"role",     title: ROLE || "Role",
                   sub:"What this role may do, what it was denied across its runs, and each run as it lived it."},
      runs:       {view:"runs",     title:"Runs",
                   sub:"Every run, newest first. One opens under the role it ran as, in order: its canary, each denial once, the end."},
      policy:     {view:"roles",    title:"Policy",
                   sub:"Each role's territory — the folders it may write — and the keys it may read, with the control files and the settings each role resolves to. " +
                       (LIVE ? "Read-only here: the policy is seisin.toml." : "In this example you can edit them; nothing is saved.")},
      requests:   {view:"requests", title:"Waiting on you",
                   sub:"Requests: access an agent asked for and cannot have. Granting one adds a line to seisin.toml."},
      configfile: {view:"config",   title:"Config file",
                   sub: LIVE ? "The policy as it stands on disk. Decisions and control-files saves write here, stamped."
                             : "The example policy, generated in this page. Live, this is your seisin.toml as it is on disk."}
    };
  }

  function show(route){
    var all = views();
    var v = all[route] || all.requests;
    document.querySelectorAll("main section[data-view]").forEach(function(s){
      s.hidden = s.getAttribute("data-view") !== v.view;
    });
    document.getElementById("v-title").textContent = v.title;
    document.getElementById("v-sub").textContent = v.sub;
    // Full cards on the landing view; a strip elsewhere.
    document.getElementById("nav-all").classList.toggle("on", route === "runs");
    document.getElementById("nav-att").classList.toggle("on", route === "overview");
    document.querySelectorAll("#nav-roles a").forEach(function(a){
      a.classList.toggle("on", route === "role" && a.getAttribute("href") === "#role/" + encodeURIComponent(ROLE || ""));
    });
    // The decisions box lives on the role's page while it is open, when that role has any.
    var box = document.getElementById("requests");
    var mine = route === "role" && !READONLY && REQS.some(function(q){ return q.role === ROLE; });
    var to = mine ? document.getElementById("rl-reqs") : document.querySelector('section[data-view="requests"]');
    if (box && to && box.parentNode !== to) to.insertBefore(box, to.firstChild);
    if (box) { try { drawReqs(); } catch (e) {} }
    // One filter for every view over runs.
    var overRuns = v.view === "runs" || v.view === "overview" || v.view === "role";
    document.getElementById("rn-filterbox").hidden = !(overRuns && !document.getElementById("nav-runs").hidden);
    // The list has its own numbers; the policy's window and cards would sit above them saying 0.
    document.body.classList.toggle("on-runs", overRuns);
    var navRoute = route;
    document.querySelectorAll(".side .list a[href^='#']").forEach(function(a){
      var on = a.getAttribute("href").slice(1) === navRoute;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    // Straight to the line the last save wrote.
    var m = v.view === "config" && document.getElementById("toml-mark");
    if (m) m.scrollIntoView({ block: "center" });
  }

  /** The landing view is what is waiting on you, not the policy table. */
  function route(){
    var h = (location.hash || "").slice(1);
    // #role/<name>, and #role/<name>/run/<id> with that run open under it.
    var m = /^role\/([^/]+)(?:\/run\/([^/]+))?$/.exec(h);
    if (m && HAS_RUNS) {
      ROLE = decodeURIComponent(m[1]);
      if (m[2]) OPEN_RUNS[decodeURIComponent(m[2])] = true;
      return "role";
    }
    if (h === "attention") return "overview";
    if (MODE === "runs") return h === "runs" ? "runs" : "overview";
    // Nothing waits on a person under a lent territory. A link to a screen that is gone
    // (#denied, #walls, #activity: what they said is on each role's page now) lands on the Overview.
    if (h && views()[h] && !(h === "requests" && READONLY)) return h;
    return HAS_RUNS ? "overview" : READONLY ? "policy" : "requests";
  }
  window.addEventListener("hashchange", function(){
    var r = route();
    show(r);
    if (HAS_RUNS && (r === "runs" || r === "overview" || r === "role")) {
      if (RLAST.v && RLAST.url === runsUrl()) drawRunsAll(RLAST.v);
      else fetchRuns(true).then(function(g){ if (g.v) { drawRunsAll(g.v); openPending(g.v); } }).catch(function(){});
    }
  });
  /** Runs a link asked to open (#role/<name>/run/<id>) whose timeline is not read yet. */
  function openPending(v){
    if (route() !== "role") return;
    Object.keys(OPEN_RUNS).forEach(function(id){
      if (OPEN_RUNS[id] && !TIMELINES[id + "|" + ROLE]) { OPEN_RUNS[id] = false; toggleRun(id, v); }
    });
  }
  show(route());

  // Wired once, outside `draw`, so a redraw never drops the listener or the typed text.
  (function(){
    var f = document.getElementById("f");
    if (!f) return;
    f.addEventListener("input", function(){ FILTER = f.value.trim(); drawRows(); });
    f.addEventListener("keydown", function(e){
      if (e.key === "Escape" && f.value) { e.preventDefault(); f.value = ""; FILTER = ""; drawRows(); }
    });
  })();


  async function refresh(){
    var got;
    try { got = await fetchState(false); } catch (_) { got = { down: true }; }
    if (got.s || got.same) {
      FAILS = 0;
      if (OFFLINE) setOffline(null);
      if (got.s) applyState(got.s);
      return;
    }
    // The server answered, with the reason it cannot: said at once, not as an outage.
    if (got.error && got.status !== 401 && got.status !== 403) { FAILS = 0; setOffline("policy", got.error); return; }
    FAILS++;
    if (FAILS >= 2) setOffline(got.status === 401 || got.status === 403 ? "expired" : "down");
  }

  /** Everything again, after a decision rewrote the policy on disk. */
  async function reload(){
    if (!LIVE) { demoRefresh(); return; }
    var got = await fetchState(true);
    if (got.s) applyState(got.s);
  }

  boot();
})();
