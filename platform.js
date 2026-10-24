/* The Reorder Desk outside Claude. The page asks its host for capabilities through window.claude.use(), as a
   claude.ai artifact does; here they are answered by Supabase (database, sign-in, live updates), /api/brief
   (AI briefs, Editors only) and plain browser downloads. Inside claude.ai this file does nothing. */
(() => {
  if (window.claude && window.claude.use) return;
  const { supabaseUrl, supabaseKey } = window.DESK_CONFIG;
  const sb = window.supabase.createClient(supabaseUrl, supabaseKey);
  const nameOf = email => String(email || '').split('@')[0];
  let session = null, role = null;   // role: 'editor' | 'viewer' | null (signed in but not on the desk)

  const ready = (async () => {
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) {
      const { data: m } = await sb.from('members').select('role').eq('user_id', session.user.id).maybeSingle();
      role = m ? m.role : null;
    }
    // This file loads in <head>; with no saved session the work above can finish before <body> exists.
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    authBar();
  })();

  // Errors in the shape the page already handles: a write the rules refuse is invalid_argument, the rest transient.
  const dbError = e => ({ code: e && (e.code === '42501' || e.code === 'PGRST301') ? 'invalid_argument' : 'unavailable', message: e && e.message });
  let channels = 0;
  const onRunsChange = fn => {
    const ch = sb.channel('runs-' + ++channels).on('postgres_changes', { event: '*', schema: 'public', table: 'runs' }, fn).subscribe();
    return () => sb.removeChannel(ch);
  };

  const db = {
    doc(path) {
      const id = path.split('/')[1];
      const get = async () => {
        const { data, error } = await sb.from('runs').select('data').eq('id', id).maybeSingle();
        if (error) throw dbError(error);
        return data ? data.data : undefined;
      };
      return {
        onSnapshot(next, onError) {
          let live = true;
          const pull = () => get().then(
            d => live && next({ id, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }),
            e => live && onError && onError(e));
          pull();
          // Payloads can be large, so a change only says "look again".
          const stop = onRunsChange(p => { if ((p.new && p.new.id === id) || (p.old && p.old.id === id)) pull(); });
          return () => { live = false; stop(); };
        },
        async set(data) {
          const { error } = await sb.from('runs').upsert({ id, data });
          if (error) throw dbError(error);
        },
        // Merges into the saved run on the server, so two people's decisions never overwrite each other.
        async update(patch) {
          const { data, error } = await sb.rpc('merge_run', { run_id: id, patch });
          if (error) throw dbError(error);
          if (!data) throw { code: 'invalid_argument', message: 'This run does not exist, or you may not change it.' };
        },
      };
    },
    // Only the query the page makes: one source's runs, oldest week first, capped.
    collection() {
      const q = { source: null, n: 1000 };
      const api = {
        where(field, op, value) { if (field === 'source') q.source = value; return api; },
        orderBy() { return api; },
        limit(n) { q.n = n; return api; },
        onSnapshot(next, onError) {
          let live = true;
          const pull = async () => {
            let r = sb.from('runs').select('data').order('as_of').limit(q.n);
            if (q.source) r = r.eq('source', q.source);
            const { data, error } = await r;
            if (!live) return;
            if (error) return onError && onError(dbError(error));
            next({ docs: data.map(x => ({ data: () => x.data })) });
          };
          pull();
          const stop = onRunsChange(pull);
          return () => { live = false; stop(); };
        },
      };
      return api;
    },
  };

  const user = {
    me: async () => ({ id: session.user.id, name: nameOf(session.user.email), email: null, avatarUrl: '', color: '#c8f36b', isOwner: false, canEdit: role === 'editor' }),
    id: async () => session.user.id,
    can: async name => (name === 'data.write' ? role === 'editor' : false),
    profiles: async ids => {
      const list = [...new Set([].concat(ids))];
      const { data } = await sb.from('members').select('user_id,email').in('user_id', list);
      const byId = Object.fromEntries((data || []).map(m => [m.user_id, nameOf(m.email)]));
      return Object.fromEntries(list.map(id => [id, { id, name: byId[id] || '' }]));
    },
  };

  const sample = {
    json: async (prompt, opts = {}) => {
      const { data } = await sb.auth.getSession();   // the client refreshes tokens; read the current one per call
      let r;
      try {
        r = await fetch('/api/brief', {
          method: 'POST', signal: opts.signal, body: JSON.stringify({ prompt }),
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (data.session ? data.session.access_token : '') },
        });
      } catch (e) {
        throw { code: e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', message: String(e) };
      }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw { code: body.code || 'upstream_error', message: body.message || r.statusText };
      return body.result;
    },
  };

  const downloads = {
    save: async ({ filename, data }) => {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { status: 'saved' };
    },
  };

  window.claude = {
    use: async name => {
      await ready;
      if (name === 'downloads') return downloads;
      if (!session) return null;
      if (name === 'user') return user;
      if (name === 'db') return role ? db : null;
      if (name === 'sample') return role === 'editor' ? sample : null;
      return null;
    },
  };

  // Sign-in lives outside the page's own markup, which re-renders on every click.
  function authBar() {
    const style = document.createElement('style');
    style.textContent = `
      .desk-auth { position: fixed; left: max(16px, env(safe-area-inset-left, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 45;
        display: grid; gap: 8px; max-width: min(440px, calc(100vw - 32px)); padding: 8px; border-radius: 18px; background: rgba(9, 14, 10, .86);
        border: 1px solid rgba(215, 255, 170, .22); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #eef5ea; font: 13px/1.4 "Geist", system-ui, sans-serif; }
      .desk-auth.row { display: flex; align-items: center; gap: 10px; padding-left: 14px; }
      .desk-auth form { display: flex; flex-wrap: wrap; gap: 6px; }
      .desk-auth input { flex: 1 1 150px; min-width: 0; height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(215, 255, 170, .22);
        background: rgba(5, 8, 6, .6); color: inherit; font: inherit; }
      .desk-auth input:focus { outline: none; box-shadow: 0 0 0 1px rgba(200, 243, 107, .5), 0 0 18px rgba(200, 243, 107, .3); }
      .desk-auth button { height: 36px; padding: 0 16px; border-radius: 999px; border: 0; cursor: pointer; font: 500 13px "Geist", system-ui, sans-serif;
        background: linear-gradient(90deg, #c2ef66, #eaf8a8); color: #0c1405; transition: transform .12s, box-shadow .2s; }
      .desk-auth button.ghost { background: transparent; color: #eef5ea; border: 1px solid rgba(215, 255, 170, .22); }
      .desk-auth button:hover { box-shadow: 0 0 20px rgba(200, 243, 107, .4); }
      .desk-auth button:active { transform: scale(.96); }
      .desk-auth button:disabled { opacity: .5; cursor: wait; }
      .desk-auth p { margin: 0 6px 2px; color: #a2b3a5; font-size: 12px; }
      @media (prefers-reduced-motion: reduce) { .desk-auth button { transition: none; } .desk-auth button:active { transform: none; } }`;
    document.head.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'desk-auth row';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Sign in');
    if (session) {
      bar.innerHTML = '<span></span><button type="button" class="ghost">Sign out</button>';
      bar.querySelector('span').textContent = `${nameOf(session.user.email)} · ${role === 'editor' ? 'Editor' : role === 'viewer' ? 'Viewer' : 'no desk access yet'}`;
      bar.querySelector('button').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    } else {
      bar.innerHTML = '<button type="button">Sign in to save decisions</button>';
      bar.querySelector('button').onclick = () => {
        bar.className = 'desk-auth';
        bar.innerHTML = `<form><input id="desk-email" type="email" required placeholder="Work email" autocomplete="username" aria-label="Work email">
          <input id="desk-password" type="password" required placeholder="Password" autocomplete="current-password" aria-label="Password">
          <button type="submit">Sign in</button></form><p>The desk owner creates accounts. Editors approve; everyone else can review and export.</p>`;
        const form = bar.querySelector('form'), note = bar.querySelector('p'), go = form.querySelector('button');
        form.querySelector('input').focus();
        form.onsubmit = async e => {
          e.preventDefault();
          go.disabled = true;
          note.textContent = 'Signing in…';
          const { error } = await sb.auth.signInWithPassword({ email: form.elements[0].value.trim(), password: form.elements[1].value });
          if (!error) return location.reload();
          go.disabled = false;
          note.textContent = /invalid login/i.test(error.message) ? "That email and password don't match a desk account." : error.message;
        };
      };
    }
    document.body.appendChild(bar);
  }
})();
