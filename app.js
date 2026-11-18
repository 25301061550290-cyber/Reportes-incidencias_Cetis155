/* =====================================================================
   CETis 155 · Reportes de incidencias
   Frontend conectado a Supabase (PostgreSQL + Auth + Storage).
   Requiere cargar antes la librería supabase-js (ver index.html).
   La clave "publishable" es pública por diseño: la seguridad real la
   dan las reglas RLS configuradas en la base de datos.
   ===================================================================== */
var SUPABASE_URL = 'https://qwsaebvedwxhzaeimvwr.supabase.co';
var SUPABASE_KEY = 'sb_publishable_jrJAnDhbl87a5Pu4VKCqlQ_95Xw5_xa';

/* La sesión del personal vive solo en memoria (no se guarda en localStorage) */
var sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
});

var ST = { pendiente: 'Pendiente', proceso: 'En proceso', resuelta: 'Resuelta' };
var auth = false, userId = '', filtro = 'todos', cache = [];
var SEL = 'id,folio,nombre,matricula,descripcion,foto_path,estado,created_at,fecha_resuelta,areas(nombre)';

function $(i) { return document.getElementById(i) }
function toast(t) { var x = $('toast'); x.textContent = t; x.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(function () { x.style.display = 'none' }, 3500) }
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML }
function fecha(iso) { var d = new Date(iso); try { return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return d.toString() } }
function pill(e) { return '<span class="pill ' + esc(e) + '">' + esc(ST[e] || e) + '</span>' }
function msg(e) {
  var m = (e && e.message) ? e.message : String(e || 'Error desconocido');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No se pudo conectar. Revisa tu internet e inténtalo de nuevo.';
  return m;
}
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  var h = '0123456789abcdef', s = '';
  for (var i = 0; i < 36; i++) s += (i === 8 || i === 13 || i === 18 || i === 23) ? '-' : h[Math.floor(Math.random() * 16)];
  return s;
}
function copiar(t) { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(function () { toast('Copiado: ' + t) }).catch(function () { toast('Anótalo: ' + t) }) } else toast('Anótalo: ' + t) }
function prog(e) { var k = ['pendiente', 'proceso', 'resuelta'], i = k.indexOf(e); return '<ol class="prog">' + k.map(function (x, j) { return '<li' + (j <= i ? ' class="on"' : '') + '>' + ST[x] + '</li>' }).join('') + '</ol>' }

/* ---------- Navegación por hash ---------- */
function route() {
  var v = (location.hash || '#reportar').slice(1); if (!$(v)) v = 'reportar';
  document.querySelectorAll('section').forEach(function (s) { s.classList.toggle('on', s.id === v) });
  document.querySelectorAll('nav a').forEach(function (a) { if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current') });
  window.scrollTo(0, 0);
  if (v === 'panel' && auth) cargarAdmin();
}
window.addEventListener('hashchange', route);

/* ---------- Áreas (desde la base de datos) ---------- */
async function cargarAreas() {
  try {
    var r = await sb.from('areas').select('id,nombre,grupo').order('id');
    if (r.error) throw r.error;
    var sel = $('area'), grp = null, og = null;
    r.data.forEach(function (a) {
      if (a.grupo !== grp || !og) { grp = a.grupo; og = document.createElement('optgroup'); og.label = grp || 'Otras'; sel.appendChild(og) }
      var o = document.createElement('option'); o.value = a.id; o.textContent = a.nombre; og.appendChild(o);
    });
  } catch (e) { toast(msg(e)) }
}

/* ---------- Formulario de nuevo reporte ---------- */
function comprimir(file) {
  return new Promise(function (res) {
    var r = new FileReader();
    r.onload = function () {
      var im = new Image();
      im.onload = function () {
        var m = 1000, k = Math.min(1, m / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        c.toBlob(function (b) { res(b) }, 'image/jpeg', 0.75);
      };
      im.onerror = function () { res(null) };
      im.src = r.result;
    };
    r.onerror = function () { res(null) };
    r.readAsDataURL(file);
  });
}
$('foto').onchange = function () {
  var f = this.files[0], p = $('prev'); p.innerHTML = '';
  if (!f || !/^image\//.test(f.type)) return;
  var rd = new FileReader();
  rd.onload = function () {
    p.innerHTML = '<div class="pv"><img alt="Vista previa de la fotografía" src="' + rd.result + '"><button type="button" class="ghost" id="qf">Quitar foto</button></div>';
    $('qf').onclick = function () { $('foto').value = ''; p.innerHTML = '' };
  };
  rd.readAsDataURL(f);
};
$('enviar').onclick = async function () {
  var n = $('nombre').value.trim(), m = $('mat').value.trim(), a = $('area').value, d = $('desc').value.trim(), f = $('foto').files[0];
  if (n.length < 3) return $('err1').textContent = 'Escribe tu nombre completo.';
  if (m.length < 4) return $('err1').textContent = 'La matrícula debe tener al menos 4 caracteres.';
  if (!a) return $('err1').textContent = 'Selecciona el área afectada.';
  if (d.length < 10) return $('err1').textContent = 'Describe el problema con al menos 10 caracteres.';
  if (f && !/^image\//.test(f.type)) return $('err1').textContent = 'El archivo debe ser una imagen.';
  $('err1').textContent = ''; $('enviar').disabled = true; $('enviar').textContent = 'Enviando…';
  try {
    var path = null;
    if (f) {
      var blob = await comprimir(f);
      if (blob) {
        path = 'reportes/' + uuid() + '.jpg';
        var up = await sb.storage.from('evidencias').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
      } else toast('No se pudo leer la foto; se enviará el reporte sin ella.');
    }
    var r = await sb.rpc('crear_reporte', {
      p_nombre: n, p_matricula: m, p_area_id: parseInt(a, 10), p_descripcion: d, p_foto_path: path
    });
    if (r.error) throw r.error;
    var row = Array.isArray(r.data) ? r.data[0] : r.data;
    mostrarFolio({
      folio: row.folio, codigo: row.codigo,
      area: $('area').selectedOptions[0].textContent,
      fecha: new Date().toISOString(), estado: 'pendiente'
    });
  } catch (e) { $('err1').textContent = msg(e) }
  finally { $('enviar').disabled = false; $('enviar').textContent = 'Enviar reporte' }
};
function mostrarFolio(r) {
  $('formWrap').hidden = true; var d = $('done'); d.hidden = false;
  d.innerHTML = '<svg class="ok" viewBox="0 0 52 52" width="64" height="64" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3"/><path d="M14 27l8 8 16-17" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><h2>Reporte enviado</h2>'
    + '<div class="ticket"><span>Tu folio</span><span class="folio">' + esc(r.folio) + '</span>'
    + '<span>Tu código privado</span><span class="folio" style="font-size:clamp(1.4rem,6vw,2rem)">' + esc(r.codigo) + '</span>'
    + '<span>' + esc(r.area) + ' · ' + fecha(r.fecha) + '</span><span>' + pill(r.estado) + '</span></div>'
    + '<p class="hint"><b>Guarda tu folio y tu código privado.</b> Los necesitas, junto con tu matrícula, para consultar el estado. El código no se puede recuperar después.</p>'
    + '<div class="acts2"><button id="copiar">Copiar folio y código</button><button class="ghost" id="otro">Hacer otro reporte</button></div>';
  $('copiar').onclick = function () { copiar('Folio: ' + r.folio + ' · Código: ' + r.codigo) };
  $('otro').onclick = function () { ['nombre', 'mat', 'desc', 'foto'].forEach(function (i) { $(i).value = '' }); $('area').value = ''; d.hidden = true; $('prev').innerHTML = ''; $('formWrap').hidden = false };
}

/* ---------- Consulta (folio + matrícula + código privado) ---------- */
$('buscar').onclick = async function () {
  var f = $('cf').value.trim().toUpperCase(), m = $('cm').value.trim(), c = $('cc').value.trim().toUpperCase(), out = $('res');
  out.innerHTML = '';
  if (!f || !m || !c) return $('err2').textContent = 'Escribe el folio, la matrícula y el código privado.';
  $('err2').textContent = ''; $('buscar').disabled = true;
  try {
    var r = await sb.rpc('consultar_reporte', { p_folio: f, p_matricula: m, p_codigo: c });
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) { $('err2').textContent = 'No se encontró un reporte con esos datos.'; return }
    var x = r.data[0];
    var hist = [{ e: 'pendiente', f: x.created_at }].concat((x.historial || []).map(function (h) { return { e: h.estado, f: h.fecha } }));
    out.innerHTML = '<div class="ticket"><span class="folio">' + esc(x.folio) + '</span><span>' + esc(x.area) + '</span><span>' + pill(x.estado) + '</span>' + prog(x.estado)
      + '<span>' + esc(x.descripcion) + '</span><ul class="hist">'
      + hist.map(function (h) { return '<li>' + esc(ST[h.e] || h.e) + ' · ' + fecha(h.f) + '</li>' }).join('') + '</ul></div>';
  } catch (e) { $('err2').textContent = msg(e) }
  finally { $('buscar').disabled = false }
};
$('cm').onkeydown = function (e) { if (e.key === 'Enter') $('buscar').click() };
$('cc').onkeydown = function (e) { if (e.key === 'Enter') $('buscar').click() };

/* ---------- Panel del personal ---------- */
function chk(e) { if (e && (e.status === 401 || /jwt|expired/i.test(e.message || ''))) { cerrar(); toast('Tu sesión expiró. Entra de nuevo.') } }
function cerrar() {
  auth = false; userId = ''; cache = []; filtro = 'todos';
  $('admin').hidden = true; $('login').hidden = false;
  sb.auth.signOut().catch(function () { });
}
$('entrar').onclick = async function () {
  var u = $('user').value.trim(), p = $('pin').value;
  if (!u || !p) return $('err3').textContent = 'Escribe tu correo y tu contraseña.';
  $('entrar').disabled = true;
  try {
    var r = await sb.auth.signInWithPassword({ email: u, password: p });
    if (r.error) throw new Error('Correo o contraseña incorrectos.');
    var uid = r.data.user.id;
    var pr = await sb.from('personal').select('user_id').eq('user_id', uid).maybeSingle();
    if (pr.error || !pr.data) { await sb.auth.signOut(); throw new Error('Esta cuenta no tiene permisos de personal autorizado.') }
    userId = uid; auth = true; $('pin').value = ''; $('err3').textContent = '';
    $('login').hidden = true; $('admin').hidden = false; cargarAdmin();
  } catch (e) { $('err3').textContent = msg(e) }
  finally { $('entrar').disabled = false }
};
$('salir').onclick = cerrar;
$('pin').onkeydown = function (e) { if (e.key === 'Enter') $('entrar').click() };

function mapa(x) {
  return {
    id: x.id, folio: x.folio, nombre: x.nombre, mat: x.matricula,
    area: x.areas ? x.areas.nombre : '—', desc: x.descripcion, estado: x.estado,
    fecha: x.created_at, fres: x.fecha_resuelta, foto: x.foto_path, hasFoto: !!x.foto_path
  };
}
async function cargarAdmin() {
  try {
    var r = await sb.from('reportes').select(SEL).order('created_at', { ascending: false });
    if (r.error) throw r.error;
    cache = r.data.map(mapa); renderAdmin();
  } catch (e) { chk(e); toast(msg(e)) }
}
$('resp').onclick = async function () {
  try {
    var s = await sb.from('seguimiento').select('*');
    if (s.error) throw s.error;
    var bl = new Blob([JSON.stringify({ generado: new Date().toISOString(), reportes: cache, seguimiento: s.data }, null, 1)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(bl); a.download = 'respaldo-incidencias-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href) }, 1000);
  } catch (e) { chk(e); toast(msg(e)) }
};

function renderAdmin() {
  var c = { todos: cache.length, pendiente: 0, proceso: 0, resuelta: 0 }; cache.forEach(function (r) { if (c[r.estado] !== undefined) c[r.estado]++ });
  $('stats').innerHTML = ['todos', 'pendiente', 'proceso', 'resuelta'].map(function (k) { return '<button data-f="' + k + '" aria-pressed="' + (filtro === k) + '"><b>' + c[k] + '</b>' + (k === 'todos' ? 'Todos' : ST[k]) + '</button>' }).join('');
  $('stats').querySelectorAll('button').forEach(function (b) { b.onclick = function () { filtro = b.dataset.f; renderAdmin() } });
  var q = ($('q').value || '').trim().toLowerCase();
  var l = cache.filter(function (r) { return (filtro === 'todos' || r.estado === filtro) && (!q || (r.folio + ' ' + r.nombre + ' ' + r.mat + ' ' + r.area).toLowerCase().indexOf(q) > -1) });
  $('lista').innerHTML = l.length ? l.map(function (r) {
    return '<details class="item ' + esc(r.estado) + '"><summary><b>' + esc(r.folio) + '</b>' + pill(r.estado) + '<span>' + esc(r.area) + '</span></summary><div class="body">'
      + '<p><b>' + esc(r.nombre) + '</b> (' + esc(r.mat) + ') · ' + fecha(r.fecha) + '</p><p>' + esc(r.desc) + '</p>'
      + (r.hasFoto ? '<button class="ghost vf" data-folio="' + esc(r.folio) + '">Ver fotografía</button><div></div>' : '<p class="hint">Sin fotografía.</p>')
      + '<label for="s-' + esc(r.folio) + '">Actualizar estado</label><select id="s-' + esc(r.folio) + '" data-folio="' + esc(r.folio) + '">'
      + Object.keys(ST).map(function (k) { return '<option value="' + k + '"' + (k === r.estado ? ' selected' : '') + '>' + ST[k] + '</option>' }).join('')
      + '</select>' + delBtn(r) + '</div></details>';
  }).join('') : '<p class="empty">No hay reportes en este estado.</p>';

  $('lista').querySelectorAll('.vf').forEach(function (b) {
    b.onclick = async function () {
      b.disabled = true;
      var rep = cache.find(function (x) { return x.folio === b.dataset.folio });
      try {
        var s = await sb.storage.from('evidencias').createSignedUrl(rep.foto, 300);
        if (s.error) throw s.error;
        var im = document.createElement('img'); im.alt = 'Evidencia'; im.src = s.data.signedUrl;
        b.nextElementSibling.appendChild(im); b.hidden = true;
      } catch (e) { b.disabled = false; toast(msg(e)) }
    };
  });

  $('lista').querySelectorAll('select').forEach(function (s) {
    s.onchange = async function () {
      var folio = s.dataset.folio, nuevo = s.value;
      var rep = cache.find(function (x) { return x.folio === folio });
      s.disabled = true;
      try {
        var u = await sb.from('reportes').update({ estado: nuevo }).eq('folio', folio).select(SEL).single();
        if (u.error) throw u.error;
        var h = await sb.from('seguimiento').insert({ reporte_id: rep.id, estado: nuevo, autor: userId });
        if (h.error) throw h.error;
        var i = cache.findIndex(function (x) { return x.folio === folio }); if (i > -1) cache[i] = mapa(u.data);
        toast(folio + ' ahora está ' + ST[nuevo].toLowerCase() + '.');
        renderAdmin(); var e2 = $('s-' + folio); if (e2) e2.closest('details').open = true;
      } catch (e) { chk(e); toast(msg(e)); cargarAdmin() }
    };
  });
}

/* ---------- Eliminar reporte (solo resueltos, 10 min después; lo valida la base de datos) ---------- */
function mmss(ms) { var s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2) }
function delBtn(r) {
  if (r.estado !== 'resuelta') return '';
  var t = r.fres ? new Date(r.fres).getTime() : 0, left = t + 6e5 - Date.now();
  return '<button class="ghost del" data-folio="' + esc(r.folio) + '" data-t="' + t + '"' + (left > 0 ? ' disabled' : '') + '>' + (left > 0 ? 'Eliminar disponible en ' + mmss(left) : 'Eliminar reporte') + '</button>';
}
setInterval(function () {
  document.querySelectorAll('.del').forEach(function (b) {
    if (b.dataset.busy) return;
    var left = +b.dataset.t + 6e5 - Date.now();
    if (left > 0) { b.textContent = 'Eliminar disponible en ' + mmss(left) }
    else if (b.disabled) { b.disabled = false; b.textContent = 'Eliminar reporte' }
  });
}, 1000);
$('lista').onclick = async function (e) {
  var b = e.target.closest ? e.target.closest('.del') : null; if (!b || b.disabled) return;
  if (!b.dataset.ask) {
    b.dataset.ask = '1'; b.textContent = 'Toca de nuevo para confirmar';
    setTimeout(function () { delete b.dataset.ask; if (!b.dataset.busy && !b.disabled) b.textContent = 'Eliminar reporte' }, 4000);
    return;
  }
  var folio = b.dataset.folio, rep = cache.find(function (x) { return x.folio === folio });
  b.dataset.busy = '1'; b.disabled = true; b.textContent = 'Eliminando…';
  try {
    var d = await sb.from('reportes').delete().eq('folio', folio).select('id');
    if (d.error) throw d.error;
    if (!d.data || !d.data.length) throw new Error('Todavía no se puede eliminar este reporte.');
    if (rep && rep.foto) { try { await sb.storage.from('evidencias').remove([rep.foto]) } catch (x) { } }
    cache = cache.filter(function (x) { return x.folio !== folio });
    toast('Reporte eliminado.'); renderAdmin();
  } catch (err) {
    delete b.dataset.busy; delete b.dataset.ask; b.disabled = false; b.textContent = 'Eliminar reporte';
    chk(err); toast(msg(err));
  }
};
$('q').oninput = renderAdmin;

/* ---------- Inicio ---------- */
cargarAreas();
route();
