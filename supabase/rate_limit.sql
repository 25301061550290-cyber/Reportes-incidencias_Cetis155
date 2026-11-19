-- =====================================================================
-- CETis 155 · Reportes de incidencias
-- Archivo 1 de 2 · Rate limiting: límite de reportes y bloqueo de consultas
-- Orden de ejecución: este archivo primero, después rate_limit_funciones.sql
-- Ejecutar en Supabase -> SQL Editor.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) LÍMITE DE REPORTES (por matrícula y global)
--    Se llama desde el navegador ANTES de subir la foto, y también
--    desde dentro de crear_reporte (doble protección).
-- ---------------------------------------------------------------------
create index if not exists reportes_matricula_trim_created_idx
  on public.reportes (upper(trim(matricula)), created_at);

create or replace function public.verificar_limite_reportes(p_matricula text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m text := upper(trim(coalesce(p_matricula, '')));
begin
  -- Máx. 3 reportes por matrícula en la última hora
  if (select count(*) from reportes
       where upper(trim(matricula)) = m
         and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Ya enviaste varios reportes en la última hora. Inténtalo más tarde.';
  end if;

  -- Máx. 10 reportes por matrícula en el último día
  if (select count(*) from reportes
       where upper(trim(matricula)) = m
         and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Alcanzaste el límite de reportes por día.';
  end if;

  -- Tope global: máx. 100 reportes por hora entre todos
  if (select count(*) from reportes
       where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'El sistema recibió demasiados reportes. Inténtalo más tarde.';
  end if;
end;
$$;

revoke all on function public.verificar_limite_reportes(text) from public;
grant execute on function public.verificar_limite_reportes(text) to anon, authenticated;


-- ---------------------------------------------------------------------
-- 2) BLOQUEO DE CONSULTAS FALLIDAS (por folio)
--    5 fallos seguidos -> bloqueo de 15 minutos para ese folio.
-- ---------------------------------------------------------------------
create table if not exists public.intentos_consulta (
  folio           text primary key,
  fallos          int  not null default 0,
  bloqueado_hasta timestamptz,
  actualizado     timestamptz not null default now()
);

-- RLS activado y SIN políticas: nadie puede leer ni escribir directo.
-- Solo las funciones security definer de abajo tocan esta tabla.
alter table public.intentos_consulta enable row level security;
revoke all on public.intentos_consulta from anon, authenticated;

create or replace function public.consulta_bloqueada(p_folio text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from intentos_consulta
     where folio = left(upper(trim(coalesce(p_folio, ''))), 30)
       and bloqueado_hasta > now()
  );
$$;

create or replace function public.registrar_fallo_consulta(p_folio text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  f text := left(upper(trim(coalesce(p_folio, ''))), 30);
begin
  -- Limpieza: borra registros de más de 1 día para que la tabla no crezca
  delete from intentos_consulta where actualizado < now() - interval '1 day';

  insert into intentos_consulta as i (folio, fallos, actualizado)
  values (f, 1, now())
  on conflict (folio) do update set
    fallos = case when i.actualizado < now() - interval '15 minutes'
                  then 1 else i.fallos + 1 end,
    actualizado = now();

  update intentos_consulta
     set bloqueado_hasta = now() + interval '15 minutes'
   where folio = f and fallos >= 5;
end;
$$;

create or replace function public.limpiar_fallos_consulta(p_folio text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from intentos_consulta
   where folio = left(upper(trim(coalesce(p_folio, ''))), 30);
$$;

-- Estas funciones NO se exponen al público: solo las llaman
-- consultar_reporte / crear_reporte (que son security definer).
-- Si se expusieran, cualquiera podría bloquear folios ajenos.
revoke all on function public.consulta_bloqueada(text)        from public, anon, authenticated;
revoke all on function public.registrar_fallo_consulta(text)  from public, anon, authenticated;
revoke all on function public.limpiar_fallos_consulta(text)   from public, anon, authenticated;
