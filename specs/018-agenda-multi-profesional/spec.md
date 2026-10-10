# Feature Specification: Agenda multi-profesional (equipo, catálogo de servicios y calendario global)

**Feature Branch**: `018-agenda-multi-profesional`

**Created**: 2026-10-09

**Status**: Draft

**Input**: User description: "018 agenda multi-profesional para Style (barbería sobre Vocero). Requisitos decididos con el dueño: (1) una instancia gestiona múltiples perfiles de profesionales con oficio (barbero, colorista, manicurista…; job_title es dato de perfil, no rol de permisos); (2) roles de acceso: owner, reception, staff — staff ve y gestiona SOLO sus citas, filtrado en servidor; (3) calendario global (owner/reception) con columna por profesional, donde en un mismo horario conviven citas de distintos profesionales y se puede agendar manualmente; (4) nunca dos reservas solapadas del mismo profesional, garantizado en la BD (exclusión por staff + rango de tiempo, cubre solapamiento parcial con duraciones variables), también contra carreras panel/agente/API; (5) catálogo de servicios administrado solo por el dueño, con precio único por servicio (no hay precio por profesional); cada profesional marca qué servicios del catálogo hace y puede ajustar SOLO su duración; intento de editar precio/catálogo por staff → 403; la cita copia precio y duración al reservar; (6) perfil por profesional (foto, bio, oficio, servicios con duración y precio, horario semanal propio con fallback al de la barbería, agenda); (7) el agente de WhatsApp ofrece solo combinaciones válidas servicio+profesional, soporta 'cualquier profesional' y mantiene la regla de solo agendar horarios ofrecidos; (8) cambio aditivo: migración crea un profesional por defecto por organización y le asigna citas existentes, una instancia de un solo profesional se comporta igual que hoy; (9) gate E2E de aislamiento: A no ve/edita citas de B, staff no cambia precios, dos reservas simultáneas solapadas → exactamente una exitosa. Lecciones del proyecto previo style-agente-wa: no endpoints públicos de citas sin auth, no chequeo de choque solo en código."

## Contexto de negocio

Style es una barbería que opera sobre Vocero. El motor de agenda de la feature
015 asume **un solo calendario por negocio**: una cita por instante, una
duración global, sin noción de quién atiende ni de qué servicio se presta. Eso
sirve a un consultor que agenda reuniones, pero no a un local donde a las 10:00
un barbero hace un corte, una colorista un tinte y otro barbero una barba, cada
uno con duraciones distintas.

Esta feature extiende el motor de agenda (no lo reemplaza) para que una
instancia gestione **un equipo de profesionales**, un **catálogo de servicios**
del dueño y un **calendario global** con citas en paralelo, manteniendo la
garantía de que **un mismo profesional nunca tiene dos citas solapadas**.

### Lecciones del proyecto previo (`style-agente-wa`)

Ese proyecto ya separó cuentas de usuario y fichas de profesional, y forzó el
filtro por profesional del lado del servidor — ideas que se conservan. Pero
dejó tres huecos que esta spec prohíbe explícitamente:

1. Endpoints públicos que listaban citas (con teléfonos de clientes) y
   cambiaban su estado **sin autenticación**.
2. El chequeo de choque vivía solo en el código: dos reservas concurrentes
   podían pasar ambas.
3. El agente de WhatsApp asignaba todo al "profesional por defecto": nunca
   eligió profesional ni respetó servicios por profesional.

### Dos ejes que no se mezclan

- **Oficio** (barbero, colorista, manicurista…): qué hace la persona. Es un
  dato del perfil y determina qué servicios tiene sentido ofrecer.
- **Rol de acceso** (dueño, recepción, profesional): qué puede ver y tocar en
  el panel. Una colorista y un barbero tienen el mismo rol y la misma
  restricción: solo lo suyo.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El dueño arma su equipo y su catálogo (Priority: P1)

El dueño da de alta a sus profesionales (nombre, oficio, foto, bio, color en el
calendario), opcionalmente les crea una cuenta de acceso con rol "profesional",
y mantiene el catálogo de servicios del local: nombre, duración base, precio
único y, opcionalmente, el oficio al que aplica.

**Why this priority**: Sin profesionales ni servicios no hay nada que agendar
por persona. Es la base de todo lo demás.

**Independent Test**: Con la agenda encendida, el dueño crea dos profesionales
y tres servicios desde el panel; ambos aparecen en el calendario global y en
sus perfiles. Verificable sin el agente de WhatsApp.

**Acceptance Scenarios**:

1. **Given** una instancia recién migrada, **When** el dueño abre el equipo,
   **Then** ve un profesional por defecto que conserva todas las citas
   anteriores.
2. **Given** el dueño en el catálogo, **When** crea "Corte clásico — 30 min —
   $X", **Then** el servicio queda disponible para asignarse a profesionales.
3. **Given** un profesional sin cuenta de acceso, **When** el dueño lo invita
   con un correo, **Then** se crea una cuenta con rol "profesional" vinculada a
   ese perfil, y solo a ese.
4. **Given** el dueño desactiva un servicio, **When** se consultan horarios,
   **Then** ese servicio deja de ofrecerse para todos los profesionales, y las
   citas ya agendadas conservan su precio y duración.
5. **Given** el dueño desactiva a un profesional, **When** se consultan
   horarios, **Then** ese profesional deja de ofrecerse, su historial se
   conserva y su cuenta de acceso deja de poder entrar.

---

### User Story 2 - Nunca dos citas solapadas del mismo profesional (Priority: P1)

Venga la reserva del panel, del agente de WhatsApp o de un cerebro externo, y
aunque lleguen al mismo tiempo, un profesional jamás queda con dos citas que se
pisen, ni siquiera parcialmente (un servicio de 60 min a las 10:00 bloquea uno
de 30 min a las 10:15). Distintos profesionales sí comparten horario.

**Why this priority**: Es la garantía central del negocio. Una doble reserva
es un cliente plantado; fue el bug latente del proyecto previo.

**Independent Test**: Lanzar dos reservas simultáneas solapadas para el mismo
profesional → exactamente una se crea y la otra recibe "horario ocupado".
Lanzar dos reservas al mismo horario para profesionales distintos → ambas se
crean.

**Acceptance Scenarios**:

1. **Given** el barbero A con cita 10:00–11:00, **When** alguien intenta
   reservar a A de 10:15 a 10:45, **Then** se rechaza como horario ocupado.
2. **Given** el barbero A con cita 10:00–11:00, **When** se reserva a la
   colorista B de 10:00 a 11:30, **Then** se acepta.
3. **Given** dos solicitudes concurrentes para A a las 16:00 (una del panel,
   otra del agente), **When** ambas se confirman, **Then** exactamente una
   queda agendada y la otra recibe un error claro y recuperable.
4. **Given** una cita cancelada de A a las 10:00, **When** se reserva a A a las
   10:00, **Then** se acepta (las canceladas y las de prueba no ocupan).
5. **Given** A con un bloqueo personal 13:00–14:00, o un bloqueo de todo el
   local, **When** se intenta reservar a A dentro de ese rango, **Then** se
   rechaza.

---

### User Story 3 - Cada profesional ve y maneja solo lo suyo (Priority: P1)

Un profesional entra al panel y ve **su** agenda: sus citas, sus bloqueos, su
perfil. Puede agendar citas para sí mismo, cancelarlas, marcarlas como
realizadas o no-show. No puede ver, abrir ni modificar citas de otros
profesionales por ninguna vía (listado, detalle, búsqueda, exportación o URL
directa).

**Why this priority**: Es el pedido explícito del dueño y una regla de
privacidad: el aislamiento entre profesionales debe ser verificable.

**Independent Test**: Con dos profesionales sembrados, A inicia sesión y
solicita el detalle de una cita de B por su identificador → acceso denegado; su
listado nunca contiene citas de B.

**Acceptance Scenarios**:

1. **Given** A autenticado, **When** abre "Mi agenda", **Then** ve solo sus
   citas y bloqueos, más los bloqueos de todo el local.
2. **Given** A autenticado, **When** pide la cita de B por URL o identificador,
   **Then** recibe acceso denegado sin revelar datos de la cita.
3. **Given** A autenticado, **When** intenta cancelar o mover una cita de B,
   **Then** se rechaza y la cita no cambia.
4. **Given** A autenticado, **When** agenda una cita manual, **Then** solo
   puede asignarse a sí mismo y solo con servicios que él ofrece.
5. **Given** A autenticado, **When** intenta abrir el calendario global, la
   configuración del local, el catálogo o el equipo, **Then** no tiene acceso.

---

### User Story 4 - Calendario global para dueño y recepción (Priority: P1)

El dueño y recepción ven un calendario del día (y de la semana) con una columna
por profesional, donde conviven citas de distintos profesionales en el mismo
horario. Desde ahí agendan: eligen profesional, servicio y cliente, y la
duración se completa sola según el profesional y el servicio.

**Why this priority**: Es la herramienta diaria de operación del local y el
punto donde se toman las reservas presenciales y telefónicas.

**Independent Test**: Recepción agenda tres citas a las 10:00 con tres
profesionales distintos; las tres aparecen lado a lado y ninguna se rechaza.

**Acceptance Scenarios**:

1. **Given** recepción en el calendario global, **When** elige la columna de A
   a las 11:00 y el servicio "Barba", **Then** la cita se crea con la duración
   efectiva de A para "Barba" y el precio del catálogo.
2. **Given** recepción, **When** intenta asignar a A un servicio que A no
   ofrece, **Then** se rechaza.
3. **Given** el calendario global, **When** se filtra por profesional u oficio,
   **Then** solo se muestran las columnas correspondientes.
4. **Given** una cita creada por el agente de WhatsApp, **When** se refresca el
   calendario, **Then** aparece en la columna del profesional asignado sin
   recargar la página.

---

### User Story 5 - Perfil del profesional con sus servicios y su horario (Priority: P2)

Cada profesional tiene un perfil con foto, bio, oficio, los servicios que
ofrece (con duración y precio visibles), su horario semanal y su agenda. El
profesional elige qué servicios del catálogo hace y puede ajustar **solo la
duración** de cada uno; el precio es único por servicio y lo controla
exclusivamente el dueño.

**Why this priority**: Da autonomía al profesional sin ceder control
comercial, y alimenta la disponibilidad que ofrecen el panel y el agente.

**Independent Test**: A marca "Corte clásico" con 45 min (el catálogo dice
30); al pedir horarios de A para ese servicio, los huecos son de 45 min y el
precio mostrado es el del catálogo. Un intento de A de cambiar el precio es
rechazado y el precio no cambia.

**Acceptance Scenarios**:

1. **Given** A en su perfil, **When** marca un servicio del catálogo, **Then**
   queda ofrecido con la duración base.
2. **Given** A en su perfil, **When** ajusta la duración de un servicio,
   **Then** su duración efectiva cambia y la del catálogo no.
3. **Given** A autenticado, **When** intenta modificar el precio, el nombre o
   la existencia de un servicio del catálogo, **Then** recibe acceso denegado y
   nada cambia.
4. **Given** A sin horario propio, **When** se calculan sus huecos, **Then** se
   usa el horario general del local.
5. **Given** A con horario propio (p. ej. martes a sábado), **When** se
   calculan sus huecos, **Then** se usa el suyo y nunca excede el horario de
   apertura del local.
6. **Given** el dueño sube el precio de un servicio, **When** se miran las
   citas ya agendadas, **Then** conservan el precio con el que se reservaron.

---

### User Story 6 - El agente de WhatsApp agenda con profesional y servicio (Priority: P2)

El agente identifica el servicio que pide el cliente y, si lo menciona, el
profesional. Ofrece solo horarios reales de combinaciones válidas
(servicio que ese profesional ofrece). Si el cliente dice "me da igual quién",
ofrece huecos de cualquier profesional que haga ese servicio y la reserva queda
asignada al profesional del hueco elegido. Mantiene la regla vigente: solo se
reserva un horario que el sistema ofreció en esa conversación.

**Why this priority**: Es el canal de mayor volumen, pero depende de que las
historias P1 existan.

**Independent Test**: En el Laboratorio, una persona pide "corte con Juan
mañana" y otra "barba, el que esté libre"; ambas terminan con cita asignada al
profesional correcto y con la duración efectiva correcta.

**Acceptance Scenarios**:

1. **Given** un cliente que pide un servicio con un profesional nombrado,
   **When** el agente ofrece horarios, **Then** todos son huecos libres de ese
   profesional para ese servicio.
2. **Given** un cliente que pide un servicio que el profesional nombrado no
   ofrece, **When** el agente responde, **Then** lo indica y propone
   profesionales que sí lo ofrecen.
3. **Given** "cualquier profesional", **When** el cliente elige un hueco,
   **Then** la cita queda con el profesional al que pertenecía ese hueco.
4. **Given** que el hueco se ocupó entre la oferta y la confirmación, **When**
   el cliente confirma, **Then** el agente informa que ya no está libre y
   ofrece alternativas, sin crear la cita.
5. **Given** una conversación de prueba del Laboratorio, **When** se reserva,
   **Then** la cita es de prueba y nunca ocupa horarios reales.

---

### Edge Cases

- **Instancia de un solo profesional**: tras la migración, todo se comporta
  igual que hoy (mismo horario, mismas citas, mismo agente). El agente no
  pregunta por profesional si solo hay uno.
- **Profesional sin servicios ofrecidos**: no aparece en la oferta del agente
  ni acepta reservas hasta que marque al menos uno.
- **Servicio que ningún profesional ofrece**: el agente no lo ofrece y lo dice.
- **Duración que no cabe antes del cierre**: un servicio de 90 min no se ofrece
  a las 19:00 si el profesional termina a las 20:00.
- **Cambio de duración con citas futuras**: las citas ya agendadas conservan su
  duración; el cambio aplica a reservas nuevas.
- **Profesional desactivado con citas futuras**: el dueño ve esas citas
  señaladas para reasignarlas o cancelarlas; no se borran.
- **Reasignar una cita a otro profesional** (dueño/recepción): se valida que el
  destino ofrezca el servicio y esté libre en todo el rango.
- **Cuenta de profesional que pierde el vínculo** con su perfil: no ve ninguna
  cita (por defecto, nada) en lugar de ver todas.
- **Zona horaria**: horarios, huecos y vistas por día se calculan en la zona
  horaria del local, también en los cambios de horario de verano.
- **Cerebro externo** (`/api/bot/*`): las mismas reglas de servicio,
  profesional y no-solapamiento aplican; no hay atajo.
- **Fallo del proveedor de IA**: el turno degrada sin reservar; nunca se crea
  una cita a medias.

## Requirements *(mandatory)*

### Functional Requirements

**Equipo y roles**

- **FR-001**: El sistema MUST permitir al dueño crear, editar y desactivar
  perfiles de profesional con: nombre visible, oficio, foto, bio, teléfono
  opcional, color en el calendario, orden y estado activo.
- **FR-002**: El sistema MUST distinguir tres roles de acceso: dueño, recepción
  y profesional. El oficio MUST NOT conceder ni restringir permisos.
- **FR-003**: Una cuenta con rol profesional MUST estar vinculada a exactamente
  un perfil de profesional, y un perfil MUST tener como máximo una cuenta. Un
  perfil puede existir sin cuenta.
- **FR-004**: Desactivar un profesional MUST conservar su historial, retirarlo
  de toda oferta de horarios y revocar el acceso de su cuenta.

**Aislamiento**

- **FR-005**: Para el rol profesional, toda lectura y escritura de citas y
  bloqueos MUST restringirse en el servidor a su propio perfil, en todas las
  vías (listado, detalle, búsqueda, actualización en tiempo real,
  exportación, API). La restricción MUST NOT depender de lo que envíe el
  cliente.
- **FR-006**: Una cuenta de profesional sin perfil vinculado MUST NOT ver
  ninguna cita.
- **FR-007**: El rol profesional MUST NOT acceder al calendario global, al
  catálogo, a la gestión del equipo ni a la configuración del local.
- **FR-008**: Ninguna cita, perfil con datos de contacto o cambio de estado de
  cita MUST ser accesible sin autenticación.
- **FR-009**: El rol profesional MUST acceder únicamente a su agenda, su
  perfil y los datos del cliente (nombre y contacto) de sus propias citas. MUST
  NOT acceder al inbox, a las conversaciones, al listado de contactos, a leads
  ni al Laboratorio, ni recibir sus eventos en tiempo real. *(Decisión del
  dueño 2026-10-09, opción A; ampliar a "conversaciones de sus clientes" queda
  como evolución futura.)*

**Catálogo de servicios**

- **FR-010**: Solo el dueño MUST poder crear, editar, desactivar servicios y
  fijar su nombre, duración base, precio único y oficio opcional.
- **FR-011**: Cada servicio MUST tener un único precio; MUST NOT existir precio
  por profesional.
- **FR-012**: Un profesional MUST poder marcar y desmarcar qué servicios del
  catálogo ofrece y ajustar solo la duración de cada uno. El dueño MUST poder
  hacer lo mismo sobre cualquier profesional.
- **FR-013**: Cualquier intento de un profesional de modificar precio, nombre,
  existencia o estado de un servicio del catálogo MUST ser rechazado con acceso
  denegado y sin efecto.
- **FR-014**: La duración efectiva de un servicio para un profesional MUST ser
  la propia del profesional si la definió; si no, la del catálogo.
- **FR-015**: Al reservar, la cita MUST copiar el servicio, la duración
  efectiva y el precio vigente; cambios posteriores al catálogo o a la duración
  MUST NOT alterar citas existentes.

**Horarios y bloqueos**

- **FR-016**: Cada profesional MUST poder tener un horario semanal propio; si
  no lo tiene, MUST usarse el horario general del local. El horario efectivo
  MUST NOT exceder el horario de apertura del local.
- **FR-017**: El sistema MUST soportar bloqueos de un profesional y bloqueos de
  todo el local; ambos excluyen horarios.
- **FR-018**: Un profesional MUST poder gestionar su propio horario y sus
  propios bloqueos; el dueño MUST poder gestionar los de todos.

**Reservas y no-solapamiento**

- **FR-019**: Toda cita MUST tener un profesional y un servicio asignados.
- **FR-020**: El sistema MUST garantizar que un profesional nunca tenga dos
  citas activas cuyos intervalos se solapen, incluido el solapamiento parcial.
  La garantía MUST residir en la capa de persistencia, de modo que ningún par
  de solicitudes concurrentes (panel, agente, cerebro externo) pueda violarla.
- **FR-021**: Las citas canceladas y las de prueba MUST NOT ocupar horarios.
- **FR-022**: Un conflicto de horario MUST traducirse a un error recuperable
  ("horario ocupado") para quien reservó, nunca a un fallo genérico.
- **FR-023**: Una reserva MUST rechazarse si el profesional no ofrece el
  servicio, está inactivo, el intervalo cae fuera de su horario efectivo o
  choca con un bloqueo.
- **FR-024**: Dueño y recepción MUST poder crear, mover, reasignar y cancelar
  citas de cualquier profesional; el profesional solo las propias.

**Calendario global**

- **FR-025**: Dueño y recepción MUST ver un calendario por día y por semana
  con una columna por profesional activo, filtrable por profesional y oficio.
- **FR-026**: Las citas creadas por cualquier vía MUST aparecer en el
  calendario y en la agenda del profesional sin recargar la página.

**Perfil**

- **FR-027**: El perfil de cada profesional MUST mostrar foto, bio, oficio,
  servicios ofrecidos con duración efectiva y precio del catálogo, horario
  efectivo y su agenda.
- **FR-028**: La foto de perfil MUST almacenarse dentro de la propia instancia,
  sin servicios de almacenamiento de terceros (Constitución II).

**Agente de WhatsApp y cerebro externo**

- **FR-029**: El agente MUST ofrecer solo horarios de combinaciones válidas de
  servicio y profesional activos.
- **FR-030**: El agente MUST soportar "cualquier profesional": los horarios
  ofrecidos MUST recordar a qué profesional pertenecen, y la cita MUST quedar
  con ese profesional.
- **FR-031**: Se MUST mantener la regla vigente: solo se reserva un horario
  ofrecido previamente en la misma conversación, ahora incluyendo profesional
  y servicio.
- **FR-032**: Si solo existe un profesional activo, el agente MUST NOT
  preguntar por profesional.
- **FR-033**: Las mismas reglas MUST aplicar a las reservas hechas por un
  cerebro externo.

**Compatibilidad y verificación**

- **FR-034**: La migración MUST ser aditiva y re-ejecutable: crear un
  profesional por defecto por organización, asignarle las citas existentes y
  dejar a las instancias de un solo profesional comportándose igual que hoy.
- **FR-035**: La funcionalidad MUST vivir detrás de la bandera de agenda
  existente; con la bandera apagada, ninguna superficie nueva es visible.
- **FR-036**: El arnés E2E MUST incluir un guion de aislamiento con dos
  profesionales que verifique: lectura cruzada denegada, escritura cruzada
  denegada, profesional no puede cambiar precios, y dos reservas concurrentes
  solapadas producen exactamente una cita.

### Key Entities

- **Profesional**: persona que presta servicios. Nombre visible, oficio, foto,
  bio, color, orden, estado activo, horario semanal opcional. Pertenece a una
  organización; puede tener una cuenta de acceso.
- **Cuenta de acceso (miembro)**: usuario con rol dueño, recepción o
  profesional; si es profesional, apunta a un perfil.
- **Servicio**: elemento del catálogo del dueño. Nombre, duración base,
  precio único, oficio opcional, estado activo.
- **Servicio del profesional**: qué servicios ofrece cada profesional, con su
  duración propia opcional. No tiene precio.
- **Cita**: profesional, servicio, cliente, conversación, inicio, duración y
  precio copiados al reservar, estado, origen (manual o agente), marca de
  prueba.
- **Bloqueo**: intervalo no disponible, de un profesional o de todo el local.
- **Horario ofrecido**: hueco presentado al cliente en una conversación, que
  ahora recuerda profesional y servicio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En 100 pares de reservas concurrentes solapadas sobre el mismo
  profesional, el 100 % termina con exactamente una cita; cero dobles
  reservas.
- **SC-002**: En el guion de aislamiento, el 100 % de los intentos de un
  profesional de leer o modificar citas ajenas, o de cambiar precios, se
  rechaza sin efecto.
- **SC-003**: Recepción agenda una cita presencial (profesional, servicio,
  cliente, horario) en menos de 30 segundos desde el calendario global.
- **SC-004**: Un profesional ve su agenda del día en un solo paso tras
  iniciar sesión.
- **SC-005**: En el Laboratorio, al menos el 95 % de las conversaciones de
  agendamiento terminan con la cita asignada al profesional y servicio
  correctos, con la duración correcta.
- **SC-006**: Tras la migración, una instancia de un solo profesional pasa sin
  cambios el self-test de agenda existente.
- **SC-007**: Una cita creada por el agente aparece en el calendario global en
  menos de 5 segundos.

## Assumptions

- Recepción tiene en la agenda los mismos permisos operativos que el dueño
  (ver y agendar para todos), pero no administra catálogo, equipo ni precios.
- El profesional puede editar su propio horario semanal y bloqueos; el dueño
  puede sobrescribirlos. Si el dueño prefiere controlar los horarios, se
  restringe sin cambiar el modelo.
- Los estados de cita son los vigentes de la feature 015 (agendada, realizada,
  no-show, cancelada).
- No hay precio por profesional ni descuentos en esta feature; la cita guarda
  el precio de referencia, sin cobro ni pagos.
- Una cita tiene un solo servicio. Combos ("corte + barba") se modelan como un
  servicio del catálogo.
- Los conectores de reunión (Zoom, Google) de la feature 015 no aplican al
  uso presencial; se conservan sin cambios.
- Notificaciones al profesional (WhatsApp o correo) por cita nueva quedan
  fuera de alcance.
- La página pública de reservas web queda fuera de alcance; las reservas
  entran por panel, agente y cerebro externo.
- Una instancia sirve a un solo local (sin sucursales).
