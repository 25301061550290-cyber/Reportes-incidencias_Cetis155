-- =====================================================================
-- CETis 155 · Reportes de incidencias
-- Esquema de la base de datos (tablas, restricciones, trigger, bucket)
--
-- Orden de ejecución en un proyecto nuevo de Supabase:
--   1) schema.sql                  (este archivo)
--   2) rate_limit.sql
--   3) rate_limit_funciones.sql
--   4) politicas_rls.sql
--
-- No incluye datos: el catálogo de áreas se llena aparte y las cuentas
-- del personal se crean en Authentication y se registran en "personal".
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0) Extensión para hash SHA-256 (digest) y aleatorios seguros
--    (gen_random_bytes), usadas por crear_reporte y consultar_reporte.
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------
-- 1) Catálogo de áreas afectadas
-- ---------------------------------------------------------------------
create table if not exists public.areas (
  id     serial primary key,
  nombre text not null unique,
  grupo  text                       -- agrupa las opciones del <select>
);


-- ---------------------------------------------------------------------
-- 2) Personal autorizado (cuentas de Supabase Auth con acceso al panel)
-- ---------------------------------------------------------------------
create table if not exists public.personal (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nombre  text not null
);


-- ---------------------------------------------------------------------
-- 3) Reportes de incidencias
--    * codigo_hash: SHA-256 del código privado; el código nunca se guarda.
--    * Las restricciones CHECK validan los datos en el servidor aunque
--      alguien se salte el JavaScript de la página.
-- ---------------------------------------------------------------------
create sequence if not exists public.folio_seq start 1;

create table if not exists public.reportes (
  id             uuid primary key default gen_random_uuid(),
  folio          text not null unique,
  codigo_hash    text not null,
  nombre         text not null check (char_length(nombre) between 3 and 120),
  matricula      text not null check (char_length(matricula) between 4 and 30),
  area_id        integer references public.areas(id),
  descripcion    text not null check (char_length(descripcion) between 10 and 2000),
  foto_path      text check (foto_path is null
                             or foto_path ~ '^reportes/[0-9a-f-]{36}\.jpg$'),
  estado         text not null default 'pendiente'
                      check (estado in ('pendiente', 'proceso', 'resuelta')),
  created_at     timestamptz not null default now(),
  fecha_resuelta timestamptz
);


-- ---------------------------------------------------------------------
-- 4) Seguimiento: historial de cambios de estado de cada reporte
--    Al borrar un reporte se borra su historial (on delete cascade).
-- ---------------------------------------------------------------------
create table if not exists public.seguimiento (
  id          uuid primary key default gen_random_uuid(),
  reporte_id  uuid not null references public.reportes(id) on delete cascade,
  comentario  text,
  estado      text not null,
  autor       uuid references auth.users(id),
  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 5) Trigger: fecha_resuelta se calcula en la base de datos
--    (el cliente no puede falsearla; la regla de borrado a los 10 min
--     de politicas_rls.sql depende de este valor).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_fecha_resuelta()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.estado = 'resuelta' and old.estado is distinct from 'resuelta' then
    new.fecha_resuelta := now();
  elsif new.estado <> 'resuelta' then
    new.fecha_resuelta := null;
  else
    new.fecha_resuelta := old.fecha_resuelta;   -- se conserva la fecha original
  end if;
  return new;
end $function$;

drop trigger if exists trg_fecha_resuelta on public.reportes;
create trigger trg_fecha_resuelta
  before update on public.reportes
  for each row execute function public.set_fecha_resuelta();


-- ---------------------------------------------------------------------
-- 6) Storage: bucket privado para las fotos de evidencia
--    Privado, máx. 2 MB, solo JPEG/PNG. Las políticas de acceso están
--    en politicas_rls.sql.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidencias', 'evidencias', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png'];

-- Nota: el índice reportes_matricula_trim_created_idx y la tabla
-- intentos_consulta se crean en rate_limit.sql.
