# Agenda con varios profesionales

Con `AGENDA=on` el local agenda en paralelo: cada cita es de un profesional y
de un servicio, recepción ve el día de todos y cada profesional entra a lo
suyo. Apagada, no hay pantallas ni rutas de agenda. Sigue siendo opcional y
apagada por defecto.

## Camino corto

1. Deja `AGENDA=on` y arranca. La migración `0014` corre sola al subir el
   contenedor.
2. **Ajustes → Profesionales**: alta con nombre y oficio. La cuenta se crea
   aparte, con correo y contraseña temporal (mínimo 8 caracteres). No sale
   ningún correo: se la entregas tú.
3. **Ajustes → Servicios**: nombre, duración y precio. La moneda es MXN.
   Enlaza el servicio a quien lo ofrece; la duración propia es opcional.
4. Recepción abre **Calendario** y agenda. El profesional, al entrar, cae en
   **Mi agenda**.

## Quién ve qué

El rol vive en la cuenta (`member.role`). Una cuenta vieja con rol `member`
se lee como recepción. El oficio del perfil no da ni quita acceso.

| | Dueño | Recepción | Profesional |
|---|---|---|---|
| Calendario de todos | sí | sí | no |
| Mi agenda | sí | no | sí, solo la propia |
| Alta de profesionales y de cuentas | sí | no | no |
| Catálogo: crear y cambiar precios | sí | no | no |
| Ver servicios y su precio | sí | sí | sí |
| Duración propia de un servicio | cualquiera | no | solo la suya |
| Horario de otro profesional | sí | no | no; el suyo sí |
| Bandeja, contactos, Laboratorio | sí | sí | no |
| Bloquear el local entero | sí | sí | no |

## El horario se hereda

Un profesional con `weeklyHours` vacío (`null`) usa el horario del local. Si
pones el suyo, se recorta a las horas de apertura: lo que caiga fuera no
genera huecos. Volver a dejarlo vacío restaura la herencia.

## «Cualquiera»

Omitir el profesional, mandarlo vacío o mandar `any` significa cualquiera:
entre quienes ofrecen ese servicio y tienen horario, el motor elige al que
menos citas activas lleva ese día (a igualdad, el de menor posición). La
oferta ya nombra a esa persona. Si el cliente pidió a alguien por su nombre,
no se le cambia en silencio.

## Si Postgres no deja crear la extensión

El no-solapamiento es el constraint `booking_staff_no_overlap` (rangos por
profesional, extensión `btree_gist`), no un chequeo del programa. La
migración ejecuta `CREATE EXTENSION IF NOT EXISTS btree_gist`. La imagen
`postgres:16-alpine` del compose la trae. Si el rol de la base no puede
crearla, la migración falla en voz alta y el contenedor no arranca: sin esa
garantía no hay agenda. Un superusuario la habilita una vez
(`CREATE EXTENSION btree_gist;`) y se vuelve a migrar. El detalle está en el
[quickstart §1](../specs/018-agenda-multi-profesional/quickstart.md).
