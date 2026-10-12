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
  var LOG = [];

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
      g.stillRefused = g.roles.filter(function(r){ return still(r, g); }).length;
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
        return Object.assign({ key: q.role + ":" + q.action + ":" + q.target, owners: ownersIn(roles, q.target),
                               last: new Date(now - q.first * 6e4).toISOString() }, q);
      }),
      causes: { total: total, distinct: groups.length, unowned: unowned, about: about,
                standing: { unowned: { paths: unowned, kinds: kinds } },
                families: families.slice(0, 8), causes: groups },
      walls: walls,
      log: entries.slice().reverse()
    };
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

    var off=ROLES.filter(function(r){return !r.sandbox;}).length;
    drawKpis();
    pill("pin", off, off === 1 ? "role unconfined" : "roles unconfined");
    var k=document.getElementById("kill");
    k.textContent=off?"Confine every role":"Run every role unconfined";
    k.classList.toggle("warn",off===0);
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

  /** What a denial with no owner was about, said of the thing it was — not "no role owns this
   *  path" of a port or a tool, which is not a path and was never anybody's. */
  function unownedSays(about){
    return about === "network" ? "not in the network allow list"
         : about === "tool" ? "MCP server not allowed for this role"
         : about === "key" ? "a key this role does not declare"
         : "no role owns this path";
  }

  function drawLog(){
    var c=document.getElementById("log"); c.textContent="";
    if(!LOG.length){
      var z=document.createElement("p"); z.className="blank";
      z.innerHTML="No decisions recorded yet.<br><span>The log fills when an agent actually "+
                  "runs inside the sandbox — <code>seisin run &lt;role&gt; -- …</code>. "+
                  "Asking <code>seisin explain</code> or reading this console does not write to it.</span>";
      c.appendChild(z); return;
    }
    LOG.forEach(function(e){
      var d=document.createElement("div");
      d.className="ev "+e.kind;
      var label=e.kind==="admin"?"you":e.kind==="deny"?"denied":e.kind==="observed"?"observed":"allowed";
      var line,who="";
      if(e.kind==="admin"){
        line=esc(e.act)+"  <em>"+esc(e.target)+"</em>";
      }else{
        line="<em>"+esc(e.role)+"</em>  "+esc(e.act)+"  "+esc(e.target);
        if(e.kind==="deny"){
          who=e.owners.length
            ? '<div class="who">belongs to <em>'+e.owners.map(esc).join("</em>, <em>")+"</em></div>"
            : '<div class="who">'+esc(unownedSays(e.about))+"</div>";
        }
      }
      // Only the kernel's own lines get the mark. A hook line and an older line look the
      // same as they always did — the absence is the default, not a third state.
      var src=e.source==="kernel"
        ? '<span class="src" title="The OS denied it: recorded from the kernel, whether or not the hook saw the attempt. '+
          'This line cannot be talked around.">OS denied</span>'
        : "";
      var w=when(e.at);
      d.innerHTML="<b>"+label+'</b><span class="body"><span class="what">'+line+"</span>"+who+
                  "</span>"+src+'<span class="when" title="'+escA(w.title)+'">'+esc(w.text)+"</span>";
      c.appendChild(d);
    });
  }

  /**
   * A what-if, and only where a what-if is honest: the example. seisin.toml cannot
   * express an unconfined role, so live this button does not exist.
   */
  document.getElementById("kill").onclick=function(){
    var anyOpen=ROLES.some(function(r){return !r.sandbox;});
    ROLES.forEach(function(r){r.sandbox=anyOpen;});
    note(anyOpen?"confined":"unconfined","every role");
  };

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
    if (!r) { drawPreview(); return; }
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
  var CAUSES = null;   // this window's denials, grouped by what was denied
  var WALLS = {};      // per role, what it keeps being denied and still would be
  var SHOW_ALL = false; // Denied: every cause, not the first twelve

  /** The kind as a person reads it. The stored value "territory" reads as its opposite — a
   *  path nobody owns — so it is said "ownable"; the value itself is a published field. */
  function kindSays(k){ return k === "territory" ? "ownable" : k; }

  /** One cause's line under its path: whose it is, or what kind of thing it is. */
  function causeSays(c){
    if (c.about && c.about !== "file") return unownedSays(c.about);
    // Refused correctly and nothing to grant: said as expected, before "protected".
    if (c.expected) return "expected · " + c.expected.hint;
    if (c.standing === "protected") return "protected: " + (c.why || "");
    if (c.standing === "outside") return c.why || "outside the map";
    if (c.owners && c.owners.length) return "owned by " + c.owners.join(", ");
    return "unowned" + (c.kind ? " · " + kindSays(c.kind) + (c.kind !== "territory" && c.hint ? ": " + c.hint : "") : "");
  }

  function bar(c, max){
    var w = Math.max(2, Math.round((c.times / max) * 100));
    // A cause the policy no longer denies is history, not live: shown greyed, not dropped.
    var cold = c.stillRefused === 0;
    var who = c.roles.length === 1 ? c.roles[0] : c.roles.length + " roles";
    return '<div class="bar' + (cold ? ' cold' : '') + '">' +
      '<div class="lbl"><div class="p">' + esc(c.action) + ' ' + esc(c.target) + '</div>' +
      '<div class="who">' + esc(who) + " · " + esc(causeSays(c)) + (cold ? ' · <b>granted since</b>' : '') + '</div>' +
      '<div class="t"><span class="f" style="width:' + w + '%"></span></div></div>' +
      '<div class="num">' + plural(c.times, "denial") + '<s>' + (c.share * 100).toFixed(1) + '% of all</s></div>' +
    '</div>';
  }

  /**
   * The shape of the window, grouped by cause.
   *
   * The reading comes first and the bars second. Files first, then keys, the network and MCP
   * tools each apart: "no role owns this path" is a sentence about paths. The list is cut at
   * twelve and says so — it used to stop at twelve with nothing to say there were more.
   */
  function drawCauses(){
    var f = CAUSES;
    var lede = document.getElementById("ca-lede");
    var bars = document.getElementById("ca-bars"), more = document.getElementById("ca-more"), other = document.getElementById("ca-other");
    if (!f || !f.total) {
      lede.textContent = "Nothing was denied in this window.";
      bars.innerHTML = ""; more.innerHTML = ""; other.innerHTML = "";
      return;
    }
    var fam = (f.families || [])[0];
    var famShare = fam ? Math.round(fam.share * 100) : 0;
    var distinct = f.distinct || f.causes.length;
    var h = "<b>" + plural(f.total, "denial") + "</b> in this window, over <b>" + distinct.toLocaleString() +
      "</b> distinct " + (distinct === 1 ? "thing" : "things") + ". ";
    // The reading has to be taken at the level of the NAME, not the path, or it comes out
    // backwards: six lock files in six repositories, none above 17%, is one kind of thing.
    if (fam && famShare >= 40 && fam.paths > 1)
      h += "<span class=\"q\"><b>" + fam.times.toLocaleString() + "</b> of them — <b>" +
              famShare + "%</b> — are the same name in " + fam.paths + " places: " +
              "<code>" + esc(fam.name) + "</code>. One kind of thing at that scale is a " +
              "tooling problem with a mechanical fix, not something to grant.</span>";
    else if (fam && famShare >= 40)
      h += "<span class=\"q\"><b>" + famShare + "%</b> of it is a single path. That is " +
              "usually mechanical rather than something to grant.</span>";
    else
      h += "<span class=\"q\">No one kind of thing dominates, which is what a real boundary " +
              "question looks like rather than a tooling one.</span>";
    var st = f.standing || {};
    if (f.unowned)
      h += " <b>" + f.unowned.toLocaleString() + "</b> " + (f.unowned === 1 ? "is a path" : "are paths") +
              " <b>no role owns</b> — a grant cannot settle those until somebody claims them.";
    var kinds = st.unowned && st.unowned.kinds;
    if (f.unowned && kinds && kinds.territory && kinds.territory.paths < f.unowned)
      h += " Only <b>" + kinds.territory.paths.toLocaleString() + "</b> of those " +
              (kinds.territory.paths === 1 ? "is" : "are") + " ownable, a question of who owns what; the rest is " +
              ["git", "temporary", "build", "credential"].filter(function(k){ return kinds[k] && kinds[k].paths; })
                .map(function(k){ return kinds[k].paths.toLocaleString() + " " + k; }).join(", ") +
              ", each with its own fix and none of them an owner.";
    var ex = f.expected;
    if (ex && ex.denials)
      h += " <b>" + plural(ex.denials, "denial") + "</b> " + (ex.denials === 1 ? "is" : "are") +
              " expected: Claude Code updating its plugins from inside the sandbox. They run and update outside it — nothing to grant.";
    var closed = (st.protected ? st.protected.paths : 0);
    if (closed)
      h += " <b>" + closed.toLocaleString() + "</b> " + (closed === 1 ? "is" : "are") +
              " protected on purpose — the boundary working, nothing to grant.";
    lede.innerHTML = h;
    document.getElementById("dn-window").textContent = rangeLabel() + " · " + plural(f.total, "denial");

    var files = f.causes.filter(function(c){ return (c.about || "file") === "file"; });
    var max = Math.max.apply(null, f.causes.map(function(c){ return c.times; }).concat([1]));
    var shown = SHOW_ALL ? files : files.slice(0, 12);
    var fileTotal = f.about ? f.about.file.paths : files.length;
    bars.innerHTML = (files.length ? '<h3 class="sr">Files</h3>' : "") + shown.map(function(c){ return bar(c, max); }).join("");
    more.innerHTML = "";
    if (fileTotal > 12) {
      var b = document.createElement("button"); b.type = "button"; b.className = "showall";
      b.textContent = SHOW_ALL ? "show the first 12" :
        shown.length + " of " + fileTotal.toLocaleString() + " paths · show all" +
        (files.length < fileTotal ? " (the first " + files.length + " are listed here)" : "");
      b.onclick = function(){ SHOW_ALL = !SHOW_ALL; drawCauses(); };
      more.appendChild(b);
    }
    var parts = [
      ["key", "Keys", "reads of a key the role does not declare"],
      ["network", "Network", "connections to a destination not in the network allow list"],
      ["tool", "MCP tools", "tools from an MCP server the role is not allowed to use"]
    ];
    other.innerHTML = parts.map(function(p){
      var list = f.causes.filter(function(c){ return c.about === p[0]; });
      var n = f.about ? f.about[p[0]] : { paths: list.length, denials: list.reduce(function(s, c){ return s + c.times; }, 0) };
      if (!n || !n.denials) return "";
      return '<div class="other"><h3>' + p[1] + " · " + plural(n.denials, "denial") + "</h3><p>" + p[2] + '.</p><div class="bars">' +
        list.map(function(c){ return bar(c, max); }).join("") + "</div></div>";
    }).join("");
  }

  /** Denied, by name — the cut that says what kind of day it was. */
  function drawFamilies(){
    var f = CAUSES;
    var fams = (f && f.families) || [];
    var top = fams[0];
    document.getElementById("fa-lede").innerHTML = !top ? "Nothing was denied in this window."
      : "The most common name is <code>" + esc(top.name) + "</code>: <b>" + Math.round(top.share * 100) + "%</b> of " +
        plural(f.total, "denial") + ", across <b>" + top.paths + "</b> path" + (top.paths === 1 ? "" : "s") + "." +
        (top.share >= 0.4 && top.paths > 1
          ? ' <span class="q">One name at that scale is usually mechanical. Fixing the tool ' +
            'removes the denials; granting the paths only hides them.</span>'
          : ' <span class="q">No single name dominates — these are separate questions, ' +
            'not one problem.</span>');

    document.getElementById("fa-list").innerHTML = fams.map(function(x){
      var w = Math.max(2, Math.round((x.times / (top.times || 1)) * 100));
      return '<div class="fam">' +
        '<div class="fam-h"><code>' + esc(x.name) + '</code>' +
          '<span class="num">' + plural(x.times, "denial") + ' <s>' + (x.share*100).toFixed(1) + '%</s></span></div>' +
        '<div class="t"><span class="f" style="width:' + w + '%"></span></div>' +
        '<div class="who">' + x.paths + ' path' + (x.paths===1?'':'s') + ' · ' +
          x.roles.length + ' role' + (x.roles.length===1?'':'s') + ': ' + esc(x.roles.join(", ")) + '</div>' +
        '<ul class="places">' + x.where.map(function(p){
          return '<li><span>' + esc(p.target) + '</span><b>' + p.times.toLocaleString() + '</b></li>';
        }).join("") + '</ul></div>';
    }).join("");
  }

  /** Retries on a list of walls: every call after the first denial of each. */
  function retriesOf(list){ return list.reduce(function(n, w){ return n + (w.expected ? 0 : w.retried !== undefined ? w.retried : w.times - 1); }, 0); }

  /**
   * What a wall says under its path: the sentence Denied gives the same path, from the same
   * function. Two of them drifted — Walls put "has an owner" before "protected" and had no
   * case for a path outside the repository, so it told a person to add ~/.npmrc to a role's
   * keys where Denied said there was nothing to grant.
   */
  function wallSays(w){ return causeSays(w); }

  /**
   * Walls — per role, what it keeps hitting and what that cost.
   *
   * One unit per number, said beside it. The role's figure was retries (times − 1 per wall)
   * and each row's was times, so a role with walls of 5× and 3× read "6" above two numbers
   * that add up to eight.
   */
  function drawWalls(){
    var rows = Object.keys(WALLS || {}).map(function(r){
      var w = WALLS[r];
      return { role: r, walls: w, spent: retriesOf(w), hits: w.reduce(function(n, x){ return n + x.times; }, 0) };
    }).sort(function(a,b){ return b.spent - a.spent; });
    var total = rows.reduce(function(n,x){ return n + x.spent; }, 0);

    document.getElementById("wl-lede").innerHTML = !rows.length
      ? "No role is repeating a denial it has already been given."
      : "<b>" + plural(total, "retry", "retries") + "</b> across <b>" + plural(rows.length, "role") +
        '</b>: calls that tried again something already denied. <span class="q">A denial is said once, ' +
        'mid-turn. Nothing carries it forward, so it gets tried again.</span>';

    document.getElementById("wl-list").innerHTML = rows.map(function(x){
      return '<div class="fam">' +
        '<div class="fam-h"><code>' + esc(x.role) + '</code>' +
          '<span class="num">' + plural(x.spent, "retry", "retries") + ' <s>of ' + plural(x.hits, "denial") + '</s></span></div>' +
        '<ul class="places">' + x.walls.map(function(w){
          return '<li><span>' + esc(w.action) + ' ' + esc(w.target) + '<br>' +
            '<em>' + esc(wallSays(w)) + '</em></span><b>' + plural(w.times, "denial") + " · " +
            (w.retried !== undefined ? w.retried : w.times - 1) + " retried</b></li>";
        }).join("") + '</ul></div>';
    }).join("");
  }

  /** A count beside a nav item, or nothing — with its unit for a screen reader and a tooltip. */
  function pill(id, n, unit){
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = n ? esc(n > 999 ? Math.round(n/1000) + "k" : String(n)) + '<span class="sr"> ' + esc(unit) + "</span>" : "";
    el.title = n ? n.toLocaleString() + " " + unit : "";
    el.hidden = !n;
  }

  /**
   * The five numbers.
   *
   * Chosen by one rule: a KPI has to be something that can change and that you
   * would do something about. Emphasis is conditional, never constant: at zero
   * they go quiet and say so in words.
   */
  function drawKpis(){
    var f = CAUSES || { total: 0, families: [], distinct: 0, causes: [] };
    var waiting = REQS.length;
    var retry = Object.keys(WALLS || {}).reduce(function(n, r){ return n + retriesOf(WALLS[r]); }, 0);
    var fam = f.families && f.families[0];
    var off = (ROLES || []).filter(function(r){ return !r.sandbox; }).length;

    function set(id, cls, value, sub){
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.remove("live","alarm","calm");
      if (cls) el.classList.add(cls);
      el.querySelector(".n").textContent = value;
      el.querySelector(".s").textContent = sub;
    }

    set("k-wait", waiting ? "live" : "calm", waiting,
        waiting ? (waiting === 1 ? "decision" : "decisions") : "nothing to decide");
    set("k-open", off ? "alarm" : "calm", off,
        off ? (off === 1 ? "role running unconfined" : "roles running unconfined") : "every role confined");
    set("k-ref", f.total ? "live" : "calm", f.total.toLocaleString(),
        (f.total ? (f.distinct || f.causes.length).toLocaleString() + " distinct things" : "nothing was denied") +
        (RANGE === "all" ? "" : " · " + rangeLabel()));
    // Under 40% no name is "the" cause, and the Denied page says so in words. The card said
    // "18% is index.lock" beside a lede saying nothing dominates.
    if (fam && fam.share >= 0.4)
      set("k-conc", "live", Math.round(fam.share * 100) + "%", "of denials are " + fam.name);
    else
      set("k-conc", "calm", fam ? "none" : "—",
          fam ? "no dominant cause · largest: " + fam.name + " " + Math.round(fam.share * 100) + "%" : "nothing was denied");
    set("k-retry", retry ? "live" : "calm", retry.toLocaleString(),
        retry ? "retries on walls already denied" : "nothing retried");

    pill("dn-pin", f.total, f.total === 1 ? "denial" : "denials");
    pill("wl-pin", retry, retry === 1 ? "retry on a wall" : "retries on walls");
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
      host.innerHTML = '<p class="blank quiet">No pending decisions. ' +
        '<span>Agents land here when they ask for a path the policy denies them.</span></p>';
      drawBulk();
      return;
    }

    host.innerHTML = REQS.map(function(r, i){
      var times = r.times > 1 ? 'asked ' + r.times + "×" : "asked once";
      var w = when(r.last || r.first);
      var stale = r.stale ? ' · not asked again in ' + Number(r.stale.runs) + ' runs since — likely no longer needed' : "";
      return '<div class="req' + (r.stale ? ' stale' : '') + '">' +
        '<div class="who">' +
          "<div><b>" + esc(r.role) + "</b> wants to " + esc(r.action) + ' <span class="path">' + esc(r.target) + "</span></div>" +
          scopeOf(r) + scopeChoice(r, i) +
          '<div class="sub"><span class="asked">' + times + "</span>" +
            (w.text ? ' · last <span title="' + escA(w.title) + '">' + esc(w.text) + "</span>" : "") + stale + "</div>" +
          '<div class="err" id="err-' + i + '" role="alert" hidden></div>' +
        "</div>" +
        '<div class="act">' +
          '<input id="why-' + i + '" placeholder="reason (required)" aria-label="Reason for ' +
            escA(r.role) + '’s request" aria-describedby="err-' + i + '">' +
          '<button class="btn primary" data-n="' + i + '" data-k="' + escA(r.key) + '" data-d="granted" type="button" data-write>Grant</button>' +
          '<button class="btn" data-n="' + i + '" data-k="' + escA(r.key) + '" data-d="declined" type="button" data-write>Decline</button>' +
        "</div>" +
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
    bulk.hidden = REQS.length < 2;
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
                "», recorded in the request queue. The policy was not changed.");
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
                "», recorded in the request queue. The policy was not changed.");
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
    [drawRows, drawCfg, drawControls, drawToml, drawLog, drawReqs, drawCauses, drawFamilies, drawWalls]
      .forEach(function(f){ try { f(); } catch (e) { console.error("seisin: " + f.name + " failed", e); } });
  }

  /**
   * This run's token, from the link `seisin ui` opened.
   *
   * It arrives in the fragment (#t=…), which the browser never sends to any
   * server, and it is moved into this tab's storage and wiped from the address
   * bar and the history entry at once.
   */
  var TOKEN = (function(){
    var m = /(?:^#|&)t=([a-f0-9]+)/.exec(location.hash || "");
    try {
      if (m) { sessionStorage.setItem("seisin-token", m[1]); }
      var t = m ? m[1] : (sessionStorage.getItem("seisin-token") || "");
      if (m) history.replaceState(null, "", location.pathname + location.search);
      return t;
    } catch (_) { return m ? m[1] : ""; }
  })();

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
  function setOffline(kind){
    if (kind && OFFLINE && OFFLINE.kind === kind) return;
    OFFLINE = kind ? { kind: kind, since: (OFFLINE && OFFLINE.since) || new Date() } : null;
    var label = document.getElementById("source");
    var ban = document.getElementById("off-banner");
    if (!OFFLINE) {
      label.textContent = LIVE_LABEL; label.style.color = "var(--green)";
      ban.hidden = true; ban.innerHTML = "";
    } else {
      var t = pad(OFFLINE.since.getHours()) + ":" + pad(OFFLINE.since.getMinutes());
      label.style.color = "var(--amber)";
      if (kind === "expired") {
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

  /* ── time window ──────────────────────────────────────────────────────── */
  // "1h" … "30d", "all", or "from:<ISO>". Remembered per browser, as a convenience.
  var RANGE = "all";
  try { RANGE = localStorage.getItem("seisin.range") || "all"; } catch (_) {}
  var SPANS = { "1h": 36e5, "4h": 4 * 36e5, "24h": 24 * 36e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };
  if (!SPANS[RANGE] && RANGE !== "all" && RANGE.indexOf("from:") !== 0) RANGE = "all";

  function sinceIso(){
    if (SPANS[RANGE]) return new Date(Math.floor((Date.now() - SPANS[RANGE]) / 6e4) * 6e4).toISOString();
    if (RANGE.indexOf("from:") === 0) return RANGE.slice(5);
    return null;
  }
  function stateUrl(){
    var s = sinceIso();
    return "/api/state" + (s ? "?since=" + encodeURIComponent(s) : "");
  }
  function rangeLabel(){
    if (SPANS[RANGE]) return "last " + RANGE;
    if (RANGE.indexOf("from:") === 0) return "since " + new Date(RANGE.slice(5)).toLocaleString();
    return "all time";
  }
  var CUSTOM = false;   // the date field is open
  function drawRange(){
    var from = document.getElementById("range-from");
    var isFrom = RANGE.indexOf("from:") === 0;
    document.querySelectorAll("#range .seg button").forEach(function(b){
      var on = b.dataset.r === "custom" ? (isFrom || CUSTOM) : (b.dataset.r === RANGE && !CUSTOM);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.getElementById("range-from-box").hidden = !(isFrom || CUSTOM);
    if (!isFrom) from.value = "";
  }
  function setRange(r){
    RANGE = r;
    CUSTOM = false;
    try { localStorage.setItem("seisin.range", r); } catch (_) {}
    drawRange();
    reload().catch(function(){ /* server went away: keep what is on screen */ });
  }
  document.querySelectorAll("#range .seg button").forEach(function(b){
    b.addEventListener("click", function(){
      if (b.dataset.r === "custom") { CUSTOM = true; drawRange(); document.getElementById("range-from").focus(); return; }
      setRange(b.dataset.r);
    });
  });
  document.getElementById("range-from").addEventListener("change", function(e){
    var t = Date.parse(e.target.value);   // datetime-local is local time, which Date.parse reads as such
    setRange(isNaN(t) ? "all" : "from:" + new Date(t).toISOString());
  });

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
    if (!r.ok) return { status: r.status };
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
    var log = changed("log", s.log);
    if (log) LOG = fromServer(s.log);
    var reqs = changed("requests", s.requests || []);
    if (reqs) REQS = s.requests || [];
    var causes = changed("causes", s.causes);
    if (causes) CAUSES = s.causes || null;
    var walls = changed("walls", s.walls);
    if (walls) WALLS = s.walls || {};

    var views = [];
    if (policy) views.push(drawRows, drawCfg, drawControls, drawToml);
    else if (blocks) views.push(drawRows);
    if (log) views.push(drawLog);
    if (reqs) views.push(drawReqs);
    if (causes) views.push(drawCauses, drawFamilies);
    if (walls) views.push(drawWalls);
    views.push(drawKpis);
    views.forEach(function(f){ try { f(); } catch (e) { console.error("seisin: " + f.name + " failed", e); } });
  }

  /** One role's settings, asked of the server once per policy. */
  var ASKING = {};
  async function loadSettings(name){
    if (ASKING[name]) return;
    ASKING[name] = true;
    try {
      var r = await fetch("/api/settings?role=" + encodeURIComponent(name),
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
  async function boot(){
    let got = null, stale = false;
    try {
      // Opened as a file there is no server to ask; the fetch only printed a CORS error.
      if (location.protocol === "file:") throw new Error("no server");
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
      show(route());
      return;
    }

    LIVE = true;
    applyState(s);
    LIVE_LABEL = s.config.replace(/^.*\//, "") + " · live";
    label.textContent = LIVE_LABEL;
    label.style.color = "var(--green)";
    // Live, the what-if button goes for good: "run every role unconfined" against a real repo is
    // not a preview. `dataset.live` is what `show()` reads.
    document.getElementById("kill").dataset.live = "1";
    document.getElementById("range").hidden = false;
    drawRange();
    document.getElementById("kill").hidden = true;
    // And so does the card that counts what the button would do: live it could only say 0.
    document.getElementById("k-open").style.display = "none";
    document.getElementById("toml-note").textContent = "the file on disk, as it stands";
    document.getElementById("foot-mode").textContent = "Live.";
    document.getElementById("foot-text").innerHTML =
      "This page reads <b>" + esc(s.config) + "</b> and the log on disk. Two actions write, each in place and stamped " +
      "with its reason: a decision on a request, and saving a control-files change after its preview. Territories " +
      "and keys are changed in seisin.toml itself.";
    draw();
    show(route());
    poll();
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
      policy:     {view:"roles",    title:"Roles",
                   sub:"Each role's territory — the folders it may write — and the keys it may read. " +
                       (LIVE ? "Read-only here: the policy is seisin.toml." : "In this example you can edit them; nothing is saved.")},
      requests:   {view:"requests", title:"Waiting on you",
                   sub:"Requests: access an agent asked for and cannot have. Granting one adds a line to seisin.toml."},
      denied:     {view:"denied",   title:"Denied", tab:"path",
                   sub:"Everything an agent tried in the window and the OS denied, grouped by what it was about."},
      causes:     {view:"denied",   title:"Denied", tab:"name",
                   sub:"The same denials grouped by file name — the cut that says whether a day was a tooling problem or a territory question."},
      walls:      {view:"walls",    title:"Walls",
                   sub:"A wall is something a role was denied twice or more and would still be denied today. Retrying one costs a call every time."},
      activity:   {view:"activity", title:"Activity",
                   sub:"Every log entry, newest first — hook and kernel — each denial with whose it was."},
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
    if (v.view === "denied") {
      var byName = v.tab === "name";
      document.getElementById("dn-path").hidden = byName;
      document.getElementById("dn-name").hidden = !byName;
      document.getElementById("tab-path").setAttribute("aria-selected", byName ? "false" : "true");
      document.getElementById("tab-name").setAttribute("aria-selected", byName ? "true" : "false");
    }
    // Full cards on the landing view; a strip elsewhere.
    document.getElementById("kpis").classList.toggle("compact", v.view !== "requests");
    var kill = document.getElementById("kill");
    if (kill) kill.hidden = (v.view !== "roles") || kill.dataset.live === "1";
    var navRoute = route === "causes" ? "denied" : route;
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
  function route(){ return (location.hash || "#requests").slice(1); }
  window.addEventListener("hashchange", function(){ show(route()); });
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

  /** The server's entries, in the shape the renderer already speaks. */
  function fromServer(entries){
    return (entries || []).map(e => ({
      at: e.at || "",
      kind: e.verdict === "denied" ? "deny" : e.verdict === "observed" ? "observed" : e.verdict === "admin" ? "admin" : "allow",
      role: e.role,
      act: e.action,
      target: e.target,
      owners: e.owners || [],
      about: e.kind || "file",
      source: e.source
    }));
  }

  async function refresh(){
    var got;
    try { got = await fetchState(false); } catch (_) { got = { down: true }; }
    if (got.s || got.same) {
      FAILS = 0;
      if (OFFLINE) setOffline(null);
      if (got.s) applyState(got.s);
      return;
    }
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
