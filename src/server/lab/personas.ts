/**
 * Las personas GUIONADAS (barbería) del Laboratorio (FR-030). El cliente simulado no
 * usa LLM: son secuencias fijas — determinismo total del lado del cliente.
 * El agente que responde es el REAL (mismo pipeline de US3).
 */

export type Persona = {
  key: string;
  label: string;
  description: string;
  /** Teléfono sintético estable (jamás un número real). */
  phone: string;
  contactName: string;
  script: string[];
};

export const PERSONAS: Persona[] = [
  {
    key: "saludo_catalogo",
    label: "Saludo y catálogo",
    description: "Solo saluda y pregunta qué hacen; debe guiarlo al primer paso.",
    phone: "5210000000001",
    contactName: "[Prueba] Saludo",
    script: ["Hola, buenas tardes", "¿Qué servicios tienen y cuánto cuestan?"],
  },
  {
    key: "direccion_faq",
    label: "Pregunta la dirección",
    description: "Pregunta dónde queda el local (respuesta del conocimiento).",
    phone: "5210000000002",
    contactName: "[Prueba] Dirección",
    script: ["Hola, ¿dónde están ubicados?", "¿Y hay donde estacionarse?"],
  },
  {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description: "Pregunta algo que el knowledge base no cubre (fuera_de_kb).",
    phone: "5210000000003",
    contactName: "[Prueba] Fuera del conocimiento",
    script: [
      "Hola, una pregunta",
      "¿Cuál es su política de garantías y devoluciones si no me gusta el resultado?",
      "¿Y si me da alergia el producto me lo reembolsan?",
    ],
  },
  {
    key: "jerga_corte_barba",
    label: "Jerga: corte y barba para hoy",
    description: "Escribe con jerga y abreviaturas pidiendo corte y barba para hoy en la noche.",
    phone: "5210000000004",
    contactName: "[Prueba] Jerga",
    script: ["q onda bro, un corte y barba pa hoy en la noche"],
  },
  {
    key: "handoff_cancelar",
    label: "Quiere cancelar su cita",
    description: "Cancelar no lo hace el bot: debe pasar con una persona (cancelacion).",
    phone: "5210000000005",
    contactName: "[Prueba] Cancelar",
    script: ["Hola, necesito cancelar mi cita del lunes"],
  },
  {
    key: "handoff_reprogramar",
    label: "Quiere reprogramar su cita",
    description: "Reprogramar no lo hace el bot: debe pasar con una persona (reprogramacion).",
    phone: "5210000000006",
    contactName: "[Prueba] Reprogramar",
    script: ["Hola, quiero reprogramar mi cita para otro día"],
  },
  {
    key: "handoff_llegada_tarde",
    label: "Avisa que llega tarde",
    description: "Llega tarde a su cita: debe pasar con una persona (llegada).",
    phone: "5210000000007",
    contactName: "[Prueba] Llega tarde",
    script: ["Oye, voy 10 minutos tarde a mi cita"],
  },
  {
    key: "handoff_pide_humano",
    label: "Pide hablar con una persona",
    description: "Pide explícitamente una persona (cliente).",
    phone: "5210000000008",
    contactName: "[Prueba] Pide humano",
    script: ["Hola", "Mejor quiero hablar con una persona"],
  },
  {
    key: "agenda_profesional_nombrado",
    label: "Agenda con profesional nombrado",
    description: "Pide un servicio con un profesional concreto y elige el primer horario.",
    phone: "5210000000009",
    contactName: "[Prueba] Agenda profesional",
    script: ["Hola, quiero un {{service1}} con {{staff1}} mañana", "quiero el primero"],
  },
  {
    key: "agenda_todo_en_un_mensaje",
    label: "Agenda todo en un mensaje",
    description: "Dice servicio, profesional, día y hora en un solo mensaje.",
    phone: "5210000000010",
    contactName: "[Prueba] Agenda todo junto",
    script: ["{{service1}} con {{staff1}} mañana a las 5", "la primera"],
  },
  {
    key: "agenda_cualquiera",
    label: "Agenda con quien esté libre",
    description: "Pide un servicio sin elegir profesional y elige el primer horario.",
    phone: "5210000000011",
    contactName: "[Prueba] Agenda cualquiera",
    script: ["Quiero {{service2}}, el que esté libre", "quiero el primero"],
  },
  {
    key: "agenda_cualquiera_tarde",
    label: "Agenda: da igual quién, viernes en la tarde",
    description: "No importa el profesional y pide una franja concreta.",
    phone: "5210000000012",
    contactName: "[Prueba] Agenda viernes tarde",
    script: ["Quiero {{service2}}, me da igual quién, el viernes en la tarde", "la primera"],
  },
  {
    key: "agenda_opcion_dos",
    label: "Agenda eligiendo la opción 2",
    description: "Le ofrecen horarios y elige el segundo.",
    phone: "5210000000013",
    contactName: "[Prueba] Agenda opción 2",
    script: ["Quiero {{service1}} con {{staff1}} el lunes", "la segunda opción"],
  },
  {
    key: "agenda_servicio_no_ofrecido",
    label: "Agenda con profesional que no hace el servicio",
    description: "Pide un servicio con alguien que no lo ofrece. No debe crearse cita.",
    phone: "5210000000014",
    contactName: "[Prueba] Agenda no ofrecido",
    script: ["Hola, quiero un {{service1}} con alguien que no lo ofrece"],
  },
  {
    key: "agenda_tinte_no_ofrecido",
    label: "Pide un servicio que no existe",
    description: "Pregunta por un tinte, que la barbería no ofrece. No debe crearse cita.",
    phone: "5210000000015",
    contactName: "[Prueba] Agenda tinte",
    script: ["Hola, ¿hacen tinte de cabello?"],
  },
  {
    key: "agenda_mi_cita",
    label: "Agenda y luego pregunta su cita",
    description: "Reserva y después pregunta a qué hora es su cita.",
    phone: "5210000000016",
    contactName: "[Prueba] Agenda mi cita",
    script: [
      "Quiero {{service1}} con {{staff1}} mañana",
      "la primera",
      "¿a qué hora es mi cita?",
    ],
  },
];

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  PERSONAS.map((p) => [p.key, p.label])
);
