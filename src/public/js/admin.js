// Admin dashboard interactivity
(function(){
  const log = (...a)=>{ try { window.ClientLogger?.info('[Admin]', ...a); } catch {} };
  const toast = window.toast || { info:console.log, error:console.error, success:console.log };

  async function api(path, opts={}){
    const res = await fetch(path, { headers:{ 'Content-Type':'application/json' }, ...opts });
    let data; try { data = await res.json(); } catch { data = { ok:false, error:'Bad JSON' }; }
    if(!res.ok || !data.ok) throw new Error(data.error||res.statusText);
    return data;
  }

  // USERS
  let userSearchTerm = '';
  async function loadUsers(){
    const panel = document.getElementById('usersPanel'); if(!panel) return;
    panel.innerHTML = `<div class="toolbar">
      <input type="text" id="userSearch" placeholder="Search users..." />
      <div class="actions">
        <select id="userBulkAction">
          <option value="">Bulk Action</option>
          <option value="disable">Disable</option>
          <option value="enable">Enable</option>
          <option value="delete">Delete</option>
          <option value="reset_mfa">Reset MFA</option>
          <option value="reset_password">Reset Password</option>
          <option value="change_role">Change Role</option>
        </select>
        <input type="text" id="userRoleInput" placeholder="role" style="width:90px;display:none;" />
        <button id="userApply" class="btn-accent" disabled>Apply</button>
      </div>
    </div>
    <table class="data-table" id="usersTable"><thead><tr>
      <th><input type="checkbox" id="userSelectAll" /></th>
      <th>ID</th><th>Email</th><th>Username</th><th>Role</th><th>Disabled</th><th>MFA</th><th>Created</th>
    </tr></thead><tbody><tr><td colspan="8">Loading...</td></tr></tbody></table>`;
    try {
  const d = await api(`/api/admin/users?search=${encodeURIComponent(userSearchTerm)}`);
      const tbody = panel.querySelector('tbody');
      if(!d.users.length){ tbody.innerHTML = '<tr><td colspan="8">No users</td></tr>'; return; }
      tbody.innerHTML = d.users.map(u=>`<tr data-id="${u.id}">
        <td><input type="checkbox" class="userRowChk" /></td>
        <td>${u.id}</td><td>${escapeHtml(u.email||'')}</td><td>${escapeHtml(u.username||'')}</td><td>${escapeHtml(u.role||'')}</td><td>${u.disabled?'<span class="badge red">Yes</span>':'No'}</td><td>${u.mfaEnabled? 'Yes':'No'}</td><td>${fmtTime(u.createdAt)}</td>
      </tr>`).join('');
      wireUserTable(panel);
    } catch(e){ panel.querySelector('tbody').innerHTML = `<tr><td colspan="8">Error: ${escapeHtml(e.message)}</td></tr>`; }
  }

  function wireUserTable(panel){
  const selectAll = panel.querySelector('#userSelectAll');
    const applyBtn = panel.querySelector('#userApply');
    const actionSel = panel.querySelector('#userBulkAction');
    const roleInput = panel.querySelector('#userRoleInput');
  const searchInput = panel.querySelector('#userSearch');
    function update(){
      const ids = getSelected(panel, '.userRowChk');
      applyBtn.disabled = ids.length===0 || !actionSel.value || (actionSel.value==='change_role' && !roleInput.value);
      roleInput.style.display = actionSel.value==='change_role' ? 'inline-block':'none';
    }
    selectAll.addEventListener('change', ()=>{
      panel.querySelectorAll('.userRowChk').forEach(c=> c.checked = selectAll.checked);
      update();
    });
    let searchTimer; searchInput.addEventListener('input', ()=>{
      clearTimeout(searchTimer);
      searchTimer = setTimeout(()=>{ userSearchTerm = searchInput.value.trim(); loadUsers(); }, 300);
    });
    panel.addEventListener('change', e=>{ if(e.target.classList.contains('userRowChk')) update(); });
    actionSel.addEventListener('change', update);
    roleInput.addEventListener('input', update);
    applyBtn.addEventListener('click', async ()=>{
      const ids = getSelected(panel, '.userRowChk');
      const action = actionSel.value; if(!action) return;
      applyBtn.disabled = true; applyBtn.textContent='Working...';
      try {
        const body = { action, ids };
        if(action==='change_role') body.role = roleInput.value.trim();
        await api('/api/admin/users/actions', { method:'POST', body: JSON.stringify(body) });
        toast.success('Users updated');
        loadUsers();
      } catch(e){ toast.error(e.message); applyBtn.disabled=false; applyBtn.textContent='Apply'; }
    });
    update();
  }

  // MEDIA
  let mediaCategoryFilter = '';
  let mediaSearchTerm = '';
  async function loadMedia(){
    const panel = document.getElementById('mediaPanel'); if(!panel) return;
    panel.innerHTML = `<div class="toolbar">
      <input type="text" id="mediaCategory" placeholder="Category filter" />
      <div class="actions">
        <select id="mediaBulkAction">
          <option value="">Bulk Action</option>
          <option value="deactivate">Deactivate</option>
          <option value="activate">Activate</option>
          <option value="delete">Delete</option>
          <option value="set_category">Set Category</option>
          <option value="rename">Rename Title</option>
        </select>
        <input type="text" id="mediaCategoryInput" placeholder="category" style="width:110px;display:none;" />
        <input type="text" id="mediaTitleInput" placeholder="title" style="width:120px;display:none;" />
        <button id="mediaApply" class="btn-accent" disabled>Apply</button>
      </div>
    </div>
    <table class="data-table" id="mediaTable"><thead><tr>
      <th><input type="checkbox" id="mediaSelectAll" /></th>
      <th>ID</th><th>Media Key</th><th>User</th><th>Category</th><th>Title</th><th>Active</th><th>Created</th>
    </tr></thead><tbody><tr><td colspan="8">Loading...</td></tr></tbody></table>`;
    try {
  const d = await api(`/api/admin/media?category=${encodeURIComponent(mediaCategoryFilter)}&search=${encodeURIComponent(mediaSearchTerm)}`);
      const tbody = panel.querySelector('tbody');
      if(!d.media.length){ tbody.innerHTML='<tr><td colspan="8">No media</td></tr>'; return; }
      tbody.innerHTML = d.media.map(m=>`<tr data-id="${m.id}">
        <td><input type="checkbox" class="mediaRowChk" /></td>
        <td>${m.id}</td><td>${escapeHtml(m.mediaKey)}</td><td>${m.userId}</td><td>${escapeHtml(m.category||'')}</td><td>${escapeHtml(m.title||'')}</td><td>${m.active? 'Yes':'No'}</td><td>${fmtTime(m.createdAt)}</td>
      </tr>`).join('');
      wireMediaTable(panel);
    } catch(e){ panel.querySelector('tbody').innerHTML=`<tr><td colspan="8">Error: ${escapeHtml(e.message)}</td></tr>`; }
  }

  function wireMediaTable(panel){
  const selectAll = panel.querySelector('#mediaSelectAll');
    const applyBtn = panel.querySelector('#mediaApply');
    const actionSel = panel.querySelector('#mediaBulkAction');
    const catInput = panel.querySelector('#mediaCategoryInput');
    const titleInput = panel.querySelector('#mediaTitleInput');
  const catFilter = panel.querySelector('#mediaCategory');
  const searchInput = document.createElement('input');
  searchInput.type='text'; searchInput.placeholder='Search title...'; searchInput.style.marginLeft='0.5rem'; searchInput.id='mediaSearchInput';
  catFilter.insertAdjacentElement('afterend', searchInput);
    function update(){
      const ids = getSelected(panel, '.mediaRowChk');
      const needsCat = actionSel.value==='set_category';
      const needsTitle = actionSel.value==='rename';
      catInput.style.display = needsCat ? 'inline-block':'none';
      titleInput.style.display = needsTitle ? 'inline-block':'none';
      applyBtn.disabled = ids.length===0 || !actionSel.value || (needsCat && !catInput.value) || (needsTitle && !titleInput.value);
    }
  selectAll.addEventListener('change', ()=>{ panel.querySelectorAll('.mediaRowChk').forEach(c=> c.checked = selectAll.checked); update(); });
  let searchTimer; searchInput.addEventListener('input', ()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>{ mediaSearchTerm = searchInput.value.trim(); loadMedia(); }, 350); });
  catFilter.addEventListener('input', ()=>{ mediaCategoryFilter = catFilter.value.trim(); clearTimeout(searchTimer); searchTimer=setTimeout(()=> loadMedia(), 350); });
    panel.addEventListener('change', e=>{ if(e.target.classList.contains('mediaRowChk')) update(); });
    actionSel.addEventListener('change', update);
    catInput.addEventListener('input', update);
    titleInput.addEventListener('input', update);
    applyBtn.addEventListener('click', async ()=>{
      const ids = getSelected(panel, '.mediaRowChk');
      const action = actionSel.value; if(!action) return;
      applyBtn.disabled=true; applyBtn.textContent='Working...';
      try {
        const body = { action, ids };
        if(action==='set_category') body.category = catInput.value.trim();
        if(action==='rename') body.title = titleInput.value.trim();
        await api('/api/admin/media/actions', { method:'POST', body: JSON.stringify(body) });
        toast.success('Media updated');
        loadMedia();
      } catch(e){ toast.error(e.message); applyBtn.disabled=false; applyBtn.textContent='Apply'; }
    });
    update();
  }

  // SETTINGS
  async function loadSettings(){
    const panel = document.getElementById('settingsPanel'); if(!panel) return;
    // Replace placeholder form with dynamic settings
    try {
      const d = await api('/api/admin/settings');
      const s = d.settings || {};
      panel.innerHTML = `<form id="settingsForm" class="settings-form" onsubmit="return false;">
        <div class="form-row"><label>Site Title<br><input name="site_title" type="text" value="${escapeAttr(s.site_title||'Nude Platform')}" /></label></div>
        <div class="form-row"><label>Max Upload Files<br><input name="max_upload_files" type="number" value="${escapeAttr(s.max_upload_files||'16')}" min="1" /></label></div>
        <div class="form-row inline">
          <label><input type="checkbox" name="disable_generations" ${s.disable_generations==='true'?'checked':''}/> Disable Generations</label>
          <label><input type="checkbox" name="disable_signups" ${s.disable_signups==='true'?'checked':''}/> Disable Signups</label>
        </div>
        <div class="form-row"><button class="btn-accent" id="settingsSave" type="button">Save</button></div>
      </form>`;
      panel.querySelector('#settingsSave').addEventListener('click', saveSettings);
    } catch(e){ panel.innerHTML = `<div class="error">Failed to load settings: ${escapeHtml(e.message)}</div>`; }
  }

  async function saveSettings(){
    const form = document.getElementById('settingsForm');
    if(!form) return;
    const fd = new FormData(form);
    const payload = {};
    for(const [k,v] of fd.entries()) payload[k]=v;
    payload.disable_generations = form.querySelector('input[name=disable_generations]').checked;
    payload.disable_signups = form.querySelector('input[name=disable_signups]').checked;
    try { await api('/api/admin/settings', { method:'POST', body: JSON.stringify(payload) }); toast.success('Settings saved'); }
    catch(e){ toast.error(e.message); }
  }

  // Helpers
  function getSelected(root, selector){ return Array.from(root.querySelectorAll(selector)).filter(c=>c.checked).map(c=> Number(c.closest('tr').dataset.id)); }
  function escapeHtml(s){ return (s||'').replace(/[&<>"]+/g, ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[ch])); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g,'&#39;'); }
  function fmtTime(t){ if(!t) return ''; try { const d = new Date(t); return d.toISOString().replace('T',' ').slice(0,19); } catch { return t; } }

  // Init by route
  document.addEventListener('DOMContentLoaded', ()=>{
    if(location.pathname.startsWith('/users')){
      // If the new list-style Users UI (users.ejs) is present, don't overwrite it.
      if(!document.getElementById('usersList')) loadUsers();
    }
    if(location.pathname.startsWith('/media')){
      // If the new list-style Media UI (media.ejs) is present, don't overwrite it.
      if(!document.getElementById('mediaList')) loadMedia();
    }
    if(location.pathname.startsWith('/settings')) loadSettings();
  });
})();
