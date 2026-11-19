-- =====================================================================
-- CETis 155 · Reportes de incidencias
-- Seguridad a nivel de fila (RLS) y políticas de acceso
--
-- Modelo de acceso:
--  * Alumnos (rol "anon"): NO tienen acceso directo a reportes,
--    seguimiento ni personal. Solo pueden:
--      - leer el catálogo de áreas,
--      - subir una foto a la carpeta evidencias/reportes/,
--      - llamar a las funciones crear_reporte, consultar_reporte y
--        verificar_limite_reportes (ver rate_limit_funciones.sql).
--  * Personal (rol "authenticated" Y registrado en la tabla "personal"):
--    puede ver y actualizar reportes, ver/agregar seguimiento, ver y
--    borrar evidencias, y eliminar reportes resueltos hace más de 10 min.
--  * Una cuenta autenticada que NO esté en "personal" no puede nada.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) Función auxiliar: ¿el usuario actual es personal autorizado?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.es_personal()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from personal where user_id = auth.uid());
$function$;


-- ---------------------------------------------------------------------
-- 2) RLS activado en todas las tablas
-- ---------------------------------------------------------------------
alter table public.areas             enable row level security;
alter table public.personal          enable row level security;
alter table public.reportes          enable row level security;
alter table public.seguimiento       enable row level security;
alter table public.intentos_consulta enable row level security;
-- intentos_consulta: sin políticas a propósito (solo la tocan funciones
-- security definer del archivo rate_limit.sql).


-- ---------------------------------------------------------------------
-- 3) Tabla areas: catálogo público de solo lectura
-- ---------------------------------------------------------------------
drop policy if exists "areas públicas" on public.areas;
create policy "areas públicas" on public.areas
  for select to public
  using (true);


-- ---------------------------------------------------------------------
-- 4) Tabla personal: cada quien solo ve su propio registro
-- ---------------------------------------------------------------------
drop policy if exists "personal se ve a sí mismo" on public.personal;
create policy "personal se ve a sí mismo" on public.personal
  for select to authenticated
  using (user_id = auth.uid());


-- ---------------------------------------------------------------------
-- 5) Tabla reportes (los alumnos NO tienen políticas: no hay INSERT ni
--    SELECT directo; crean y consultan solo mediante las funciones)
-- ---------------------------------------------------------------------
drop policy if exists "personal ve reportes" on public.reportes;
create policy "personal ve reportes" on public.reportes
  for select to authenticated
  using (es_personal());

drop policy if exists "personal actualiza reportes" on public.reportes;
create policy "personal actualiza reportes" on public.reportes
  for update to authenticated
  using (es_personal())
  with check (es_personal());

-- Solo se pueden eliminar reportes resueltos hace más de 10 minutos
drop policy if exists "personal elimina reportes" on public.reportes;
create policy "personal elimina reportes" on public.reportes
  for delete to authenticated
  using (
    es_personal()
    and estado = 'resuelta'
    and fecha_resuelta is not null
    and fecha_resuelta <= (now() - interval '10 minutes')
  );


-- ---------------------------------------------------------------------
-- 6) Tabla seguimiento (historial de estados)
-- ---------------------------------------------------------------------
drop policy if exists "personal ve seguimiento" on public.seguimiento;
create policy "personal ve seguimiento" on public.seguimiento
  for select to authenticated
  using (es_personal());

drop policy if exists "personal agrega seguimiento" on public.seguimiento;
create policy "personal agrega seguimiento" on public.seguimiento
  for insert to authenticated
  with check (es_personal());


-- ---------------------------------------------------------------------
-- 7) Storage: bucket "evidencias" (fotos de los reportes)
-- ---------------------------------------------------------------------
-- Cualquiera puede SUBIR, pero solo dentro de la carpeta reportes/
drop policy if exists "público sube evidencias" on storage.objects;
create policy "público sube evidencias" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'evidencias'
    and (storage.foldername(name))[1] = 'reportes'
  );

-- Solo el personal puede VER y BORRAR las fotos
drop policy if exists "personal ve evidencias" on storage.objects;
create policy "personal ve evidencias" on storage.objects
  for select to authenticated
  using (bucket_id = 'evidencias' and es_personal());

drop policy if exists "personal borra evidencias" on storage.objects;
create policy "personal borra evidencias" on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidencias' and es_personal());
