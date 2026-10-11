# ADR-003 — Varios profesionales en la misma agenda

**Estado**: aceptado · **Fecha**: 2026-10-11 · **Feature**:
[`018-agenda-multi-profesional`](../specs/018-agenda-multi-profesional/spec.md)

## Contexto

[ADR-002](./adr-002-conectores-de-agenda.md) metió el motor en el core detrás
de `AGENDA`: un horario, un servicio implícito y un índice único por
organización e instante. Un local con varios profesionales necesita lo
contrario en ese instante: dos personas pueden atender a la misma hora, cada
cita tiene servicio y duración propios, y no todo el equipo ve la bandeja.

La garantía de no pisarse no puede vivir en un `if` de TypeScript. Dos
peticiones a la vez (panel, agente, bot) pasarían el chequeo y las dos
escribirían.

## Decisión

**1. El no-solapamiento es un `EXCLUDE` de Postgres, no un chequeo en
código.** La migración `drizzle/0014_agenda_multi_profesional.sql` crea la
extensión con `CREATE EXTENSION IF NOT EXISTS btree_gist` y el constraint
`booking_staff_no_overlap`: rangos por profesional, citas activas que no son
de prueba. Reemplaza a `booking_org_active_slot_uq` (único por instante de
toda la organización). Drizzle no expresa el `EXCLUDE`; vive solo en ese SQL.
Se aplica con la bandera apagada o encendida. Si el rol no puede crear la
extensión, la migración falla en voz alta y el contenedor no arranca sin la
garantía.

**2. El rol sigue en `member.role`.** No hay tabla nueva de permisos. El
valor legado `member` se lee como `reception`. `withAuth` niega al `staff`
salvo que la ruta lo declare (`allowStaff`): olvidar una ruta vieja no abre
la bandeja.

**3. La foto va en `bytea`.** Una tabla aparte, no el disco de `MEDIA_DIR`:
el compose de la Ruta B no persiste ese directorio.

**4. El bloqueo de todo el local usa advisory locks.** Un bloqueo con
`staff_id` nulo no cabe en un `EXCLUDE (staff_id =)` sin impedir bloqueos
personales que sí pueden coincidir. El lock es de Postgres, no de memoria del
proceso.

## Lo que se descartó

- **Un `UNIQUE` por instante.** No cubre duraciones que se pisan a medias ni
  dos profesionales a la misma hora.
- **El chequeo de choque solo en código.** Es lo que el spec prohíbe: la
  carrera entre panel, agente y bot lo atraviesa.
- **Repartir el bloqueo del local en una fila por profesional.** No cubre a
  quien se da de alta después y hay que mantener el grupo.
- **Abortar la migración —o borrar citas— si ya había solapes.** Un `EXCLUDE`
  no admite `NOT VALID`. La columna `legacy_overlap` marca esos datos y deja
  arrancar; el costo es una booleana de un solo uso.
- **Una allow-list solo en las rutas nuevas.** Un olvido en las ~40 rutas
  viejas filtra la bandeja o el Laboratorio a un profesional.
- **La foto en `MEDIA_DIR`.** Se pierde al redeploy de la Ruta B.
- **No hacer calendario global ni catálogo.** Sin eso el local no atiende en
  paralelo ni el agente asigna profesional. El límite queda escrito: sin web
  pública, pagos, sucursales ni notificaciones.

## Consecuencias

- Quien no pone `AGENDA=on` no ve pantallas, rutas ni líneas de agenda en el
  prompt. La migración `0014` corre igual.
- Cada ruta que el profesional sí usa tiene que decirlo. Es el costo de negar
  por defecto.
- El constraint no aparece en `pnpm db:generate`. Quien regenere el esquema
  no debe borrar el SQL a mano.
- La CI del job `gates` levanta `postgres:16-alpine` (la imagen del compose,
  con `btree_gist`) y `TEST_DATABASE_URL` en las dos celdas de la matriz. El
  self-test con la app viva no entra a esa corrida.
