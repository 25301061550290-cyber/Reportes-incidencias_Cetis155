-- =====================================================================
-- CETis 155 · Reportes de incidencias
-- Archivo 2 de 2 · Funciones públicas con rate limiting integrado
-- Requiere haber ejecutado antes rate_limit.sql
-- Ejecutar en Supabase -> SQL Editor.
--
-- Notas de seguridad:
--  * Ambas funciones son SECURITY DEFINER: el alumno (rol anon) no tiene
--    acceso directo a las tablas, solo a estas funciones.
--  * El código privado se genera con gen_random_bytes (aleatorio seguro)
--    y se guarda como hash SHA-256; nunca en texto plano.
--  * Cuando el código es incorrecto NO se lanza excepción: se devuelven
--    cero filas, para que el fallo registrado persista (una excepción
--    deshace la transacción).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) crear_reporte
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_reporte(p_nombre text, p_matricula text, p_area_id integer, p_descripcion text, p_foto_path text DEFAULT NULL::text)
 RETURNS TABLE(folio text, codigo text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_folio text;
  v_codigo text := '';
  i int;
begin
  -- Rechaza si la matrícula (o el sistema) excedió el límite
  perform public.verificar_limite_reportes(p_matricula);

  v_folio := 'INC-' || extract(year from now())::int || '-' ||
             lpad(nextval('folio_seq')::text, 4, '0');
  for i in 1..8 loop
    v_codigo := v_codigo || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                 (get_byte(gen_random_bytes(1),0) % 32) + 1, 1);
  end loop;

  insert into reportes (folio, codigo_hash, nombre, matricula,
                        area_id, descripcion, foto_path)
  values (v_folio, encode(digest(v_codigo,'sha256'),'hex'),
          p_nombre, p_matricula, p_area_id, p_descripcion, p_foto_path);

  return query select v_folio, v_codigo;
end $function$;


-- ---------------------------------------------------------------------
-- 2) consultar_reporte (bloqueo tras 5 fallos por folio)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consultar_reporte(p_folio text, p_matricula text, p_codigo text)
 RETURNS TABLE(folio text, estado text, area text, descripcion text, created_at timestamp with time zone, historial jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  -- Si el folio está bloqueado, se corta antes de comparar nada
  if public.consulta_bloqueada(p_folio) then
    raise exception 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.';
  end if;

  return query
  select r.folio::text, r.estado::text, a.nombre::text, r.descripcion::text,
         r.created_at::timestamptz,
         coalesce((select jsonb_agg(jsonb_build_object(
            'estado', s.estado, 'comentario', s.comentario,
            'fecha', s.created_at) order by s.created_at)
          from seguimiento s where s.reporte_id = r.id), '[]'::jsonb)
  from reportes r left join areas a on a.id = r.area_id
  where r.folio = upper(trim(p_folio))
    and upper(trim(r.matricula)) = upper(trim(p_matricula))
    and r.codigo_hash = encode(digest(upper(trim(p_codigo)),'sha256'),'hex');

  -- FOUND es true si el SELECT devolvió filas
  if found then
    perform public.limpiar_fallos_consulta(p_folio);
  else
    perform public.registrar_fallo_consulta(p_folio);
  end if;
end $function$;
