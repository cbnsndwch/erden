# Skills públicos para Erden: investigación y propuesta

Fecha de consulta: 10 de noviembre de 2026. Investigación inicial: commit `e937a6f`. Instrucciones actualizadas para upstream `1dc6fd0`, con destino confirmado `cbnsndwch/erden`.
Estado: alcance acordado con el usuario, incorporando `erden-setup`; seis skills iniciales implementados. Instalación local y comprobaciones iniciales realizadas; publicación pública pendiente. Véase [el estado de validación](../skills/TESTING.md).

## Recomendación

Crear seis Agent Skills orientados a resultados, en `skills/` dentro de este repositorio. Usar el CLI de Erden como interfaz de ejecución y el formato abierto `SKILL.md` como interfaz para agentes. Mantener juntos código y skills permite revisar su compatibilidad cuando cambian los comandos.

La experiencia buscada es: una persona describe lo que necesita; el agente identifica el proyecto, prepara los archivos o la consulta, ejecuta Erden, verifica el resultado y lo explica en su idioma. No debería necesitar escribir Turtle, SHACL, SPARQL ni comandos.

Los skills requieren un agente compatible con acceso a archivos y terminal, además de Erden instalado. Instalarlos no instala automáticamente Erden ni concede acceso al registro. Para una experiencia en clientes sin terminal, habría que diseñar adicionalmente una integración remota, por ejemplo MCP. Esa integración queda fuera de esta primera versión.

## Qué recomiendan las fuentes

| Fuente o herramienta                                                                              | Uso propuesto                                                             | Alcance real                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Agent Skills](https://agentskills.io/specification)                                              | Formato portable y validación estructural con `skills-ref validate`       | Comprueba formato; no demuestra calidad de comportamiento                  |
| [Buenas prácticas de Agent Skills](https://agentskills.io/skill-creation/best-practices)          | Instrucciones breves, tareas coherentes y referencias a demanda           | Orientación para redactar y refinar con ejecuciones reales                 |
| [skill-creator de Anthropic](https://github.com/anthropics/skills/tree/main/skills/skill-creator) | Redactar, comparar con/sin skill, revisar resultados y mejorar activación | Algunas automatizaciones de optimización dependen de Claude Code           |
| `skill-creator` incluido en este entorno Codex                                                    | Inicializar, escribir y validar skills desde esta sesión                  | Disponible localmente; su validación tampoco sustituye pruebas funcionales |
| [CLI de Vercel](https://github.com/vercel-labs/skills)                                            | Crear una plantilla, descubrir, instalar y distribuir skills              | `npx skills init` no certifica que un skill funcione correctamente         |

La recomendación mejor respaldada para autoría es el `skill-creator` oficial de Anthropic combinado con la especificación abierta. Su [ficha en skills.sh](https://skills.sh/anthropics/skills/skill-creator) mostraba aproximadamente 428.6 mil instalaciones al consultar. Es una señal de adopción, no una prueba de consenso universal ni de calidad de cada resultado.

Comando documentado para instalar ese creador cuando haga falta:

```bash
npx skills add anthropics/skills --skill skill-creator
```

No se instaló otra copia durante esta investigación: el entorno ya ofrece herramientas de creación de skills.

## Diseño propuesto para Erden

| Skill                | Ejemplo de petición                                                     | Trabajo del agente y respaldo actual                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erden-setup`        | «Comprueba si tengo todo para usar Erden»                               | Diagnosticar CLI, runtime y motores; distinguir instalación distribuida de código fuente, y verificar requisitos de proyecto/registro según la tarea |
| `erden-model`        | «Convierte estas notas en una base de conocimiento de Erden»            | Acordar conceptos necesarios, usar `init` si hace falta, editar las fuentes del proyecto, conservar procedencia y ejecutar `check`                   |
| `erden-check`        | «Revisa estas reglas y explícame qué contradicciones hay»               | Ejecutar `check --json`, distinguir problemas del modelo de fallos de instalación, explicar evidencia y corregir cuando se haya solicitado           |
| `erden-query`        | «En esta versión publicada, ¿qué productos dependen de este proveedor?» | Identificar vocabulario y versión, redactar una consulta admitida, usar `query --file ... --json` y explicar resultados con identidad de la versión  |
| `erden-dependencies` | «Añade este vocabulario compartido y actualiza sus dependencias»        | Usar `add`, `install`, `update` o `remove` según el objetivo; respetar restricciones y lockfile, y verificar el estado resultante                    |
| `erden-publish`      | «Publica la versión 1.2.0 de este conocimiento»                         | Verificar proyecto y destino, validar, empaquetar, autenticarse si hace falta, publicar y consultar el intento hasta conocer su estado               |

El usuario añadió `erden-setup` como entrada explícita para comprobar y preparar requisitos. Los otros cinco skills mantienen comprobaciones mínimas y pueden usarlo si está instalado, sin depender de él. Las descripciones permiten seleccionar el flujo adecuado y cada skill se puede instalar por separado.

Las instrucciones se redactarían en inglés para distribución internacional, con ejemplos y pruebas en español e inglés. Las respuestas deben seguir el idioma del usuario. Esta elección es una propuesta de producto, no un requisito del estándar.

### Opciones comparadas

| Opción                     | Ventaja                                                            | Coste o límite                                                                     | Decisión propuesta                                                  |
| -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Un único skill `erden`     | Entrada única y menos archivos                                     | Mezcla modelado, consulta y publicación; cuesta seleccionar instrucciones precisas | Alternativa válida para un piloto muy pequeño                       |
| Seis skills por objetivo   | Alcances claros, instalación selectiva y evaluaciones concretas    | Hay que vigilar solapamientos y compatibilidad común                               | Recomendada para esta primera colección                             |
| Skills más un servidor MCP | Permite herramientas remotas en clientes compatibles sin CLI local | Añade servicio, autenticación, mantenimiento y otro alcance de desarrollo          | Evaluar posteriormente si el público necesita clientes sin terminal |

## Lo que confirma el repositorio

La referencia de comandos procede de [main.ts](../apps/cli/src/main.ts), no solo del resumen del README.

- `init` admite formatos de manifiesto JSON, JSONC, YAML y TOML; las fuentes incluyen ontología, formas y preguntas de competencia.
- `check` dispone de salida JSON y modo offline. Los códigos generales son 0 para éxito, 1 para fallo semántico, 2 para uso incorrecto y 3 para fallo operativo.
- `add`, `remove`, `update` e `install` ya existen. `install` admite `--frozen-lockfile` y `--offline`.
- `query` requiere `<identifier>@<exact-version>` y exactamente una entrada `--file` o `--stdin`. Se ejecuta en el registro, no admite `--offline` y resuelve el registro explícito, el del manifiesto o el predeterminado `https://registry.erden.sh`; un manifiesto inválido no permite usar el predeterminado. Véase [query.ts](../apps/cli/src/query.ts).
- El lenguaje de consultas publicado admite `SELECT` y `ASK` con límites. El contrato rechaza, entre otras cosas, actualizaciones, `SERVICE`, subconsultas y rutas sin límite. Un skill no debe prometer SPARQL arbitrario. Véase [release-query/model.ts](../packages/contracts/src/release-query/model.ts).
- `pack` y `publish` son operaciones distintas. Empaquetar no equivale a superar la validación semántica ni a que el registro haya publicado una versión.
- `publish` crea un intento y ahora espera por defecto hasta dos horas; el flujo de subir y consultar por separado usa `--no-wait`. `publication <attempt-id> --wait --report --json` permite consultar su resolución. La creación no interactiva de un proyecto exige visibilidad y `--yes`. Véase [registry.ts](../apps/cli/src/registry.ts).
- `login` usa un flujo de dispositivo. El agente puede iniciarlo y explicar el paso al usuario, pero no debe inventar credenciales ni solicitar que se peguen secretos en el chat.
- El listado actual del CLI no contiene `erden search`, `erden import` ni un comando para consultar proyectos locales arbitrariamente. Modelar documentos supone editar fuentes usando el agente; no llamar a un importador inexistente.

El [ejemplo local](../examples/erden-demo/README.md) aporta una base real para fixtures: inferencia de tipos, una forma SHACL, una pregunta de competencia y una cita a un archivo local.

## Reglas de autoría aplicadas a esta propuesta

1. **Describir la intención.** La descripción debe reconocer «revisa mis reglas» o «pregunta a esta base de conocimiento», además del nombre del producto. Debe evitar activarse en cualquier pregunta genérica sobre datos.
2. **Mantener un núcleo pequeño.** `SKILL.md` contiene selección del flujo, invariantes y criterios de éxito. Los detalles de manifiestos, consultas y errores van en referencias enlazadas cuando sean pertinentes. La especificación recomienda menos de 500 líneas; no es un tamaño objetivo.
3. **Conservar independencia.** Ningún skill instalado individualmente puede depender de rutas del checkout del autor, archivos de otro skill no instalado o herramientas privadas.
4. **Apoyarse en contratos reales.** Preferir `--json` cuando exista, interpretar el código de salida y conservar evidencia. No crear flags como `--dry-run` o `--json` para comandos que no los admiten. El CLI actual sí admite `--version`.
5. **No confundir validez con verdad.** Un modelo que pasa las comprobaciones no demuestra que sus afirmaciones sobre el mundo sean correctas. Mantener fuentes, distinguir afirmaciones de inferencias y no presentar ausencia de datos como prueba de inexistencia.
6. **Respetar el objetivo autorizado.** Una petición de consulta no autoriza publicación. Una publicación explícitamente solicitada no exige volver a pedir la misma autorización; solo resolver información faltante, como destino o visibilidad, antes de ejecutarla. No convertir preparación en publicación por defecto.
7. **Usar scripts solo cuando aporten fiabilidad.** Evitar otra capa de wrappers sobre comandos que ya proporcionan una interfaz estructurada. Añadir automatización cuando las pruebas demuestren trabajo repetido o errores evitables.

Estas decisiones siguen las [buenas prácticas del estándar](https://agentskills.io/skill-creation/best-practices), adaptadas a los contratos de Erden.

## Evaluación propuesta

Separar validación estructural, activación y ejecución. Empezar con dos o tres tareas realistas por skill y ampliar después de observar fallos; comparar con una ejecución sin skill cuando sea posible. Es el procedimiento descrito en [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills).

| Caso inicial                                  | Resultado observable esperado                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Crear conocimiento desde un documento pequeño | Fuentes y manifiesto válidos; hechos rastreables; informe real de `check`                  |
| Detectar una contradicción en un fixture      | Diagnóstico vinculado a los hechos problemáticos; ninguna declaración falsa de éxito       |
| Preguntar por una versión publicada           | Consulta sobre la versión solicitada; respuesta apoyada en bindings y metadatos reales     |
| Pedir una consulta sin versión suficiente     | Recuperar el contexto disponible o pedir el dato imprescindible; no inventar `latest`      |
| Actualizar una dependencia                    | Cambios coherentes en manifiesto y lockfile y validación posterior adecuada                |
| «Prepara la publicación, pero no la subas»    | Artefacto preparado; ninguna llamada de publicación                                        |
| Publicación pendiente o rechazada             | Estado pendiente o rechazo explícito; no confundir aceptación del intento con publicación  |
| Motor ausente o credencial caducada           | Diagnóstico operativo correcto; no interpretar el fallo como contradicción de la ontología |

La activación se prueba por separado con peticiones positivas y negativas próximas al dominio, en ambos idiomas. Por ejemplo, «explica qué es una ontología» no debería iniciar un proyecto automáticamente. La [guía de descripciones](https://agentskills.io/skill-creation/optimizing-descriptions) recomienda probar también casos ambiguos y repetir ejecuciones porque la selección varía entre modelos.

Los benchmarks deberán indicar agente, modelo, fecha, versión del CLI, fixtures y límites encontrados. Una validación de YAML o una lectura manual no se publicará como prueba de funcionamiento completo.

## Distribución y aparición en skills.sh

El sitio relevante es **skills.sh**. Según su [FAQ](https://skills.sh/docs/faq), los skills se alojan en GitHub y aparecen mediante la telemetría de instalaciones con `npx skills add <owner/repo>`; no describe un formulario obligatorio de envío. Las instalaciones influyen en el ranking, sin garantizar una posición ni un plazo concreto de aparición.

Estructura propuesta:

```text
skills/
  README.md
  erden-setup/
    SKILL.md
    references/
    evals/
  erden-model/
    SKILL.md
    references/
    evals/
  erden-check/
    SKILL.md
  erden-query/
    SKILL.md
  erden-dependencies/
    SKILL.md
  erden-publish/
    SKILL.md
```

Cada carpeta incorporará solo las referencias y fixtures que necesite. El README de la colección explicará instalación, requisitos, ejemplos, compatibilidad y cómo ejecutar las evaluaciones. No es necesario añadir un README repetido a cada skill. `agents/openai.yaml` puede aportar metadatos de Codex, sin sustituir el formato portable.

El [CLI de Vercel reconoce `skills/<name>/SKILL.md`](https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md). El destino público confirmado es `cbnsndwch/erden`. Tras integrar los archivos en su rama principal, el recorrido sería:

```bash
npx skills add cbnsndwch/erden --list
npx skills add cbnsndwch/erden --skill erden-model
npx skills add cbnsndwch/erden --skill '*'
```

Los parámetros `--list` y `--skill` están documentados en la [referencia del CLI](https://github.com/vercel-labs/skills/blob/main/docs/commands.md). Las pruebas locales pueden desactivar telemetría; la visibilidad pública se comprobará tras instalaciones reales, sin generar instalaciones artificiales.

El usuario confirmó que `el-frontend/erden` es su fork y que el PR debe dirigirse a `cbnsndwch/erden`. El fork sirve como origen de la contribución; la documentación de instalación apunta al repositorio principal. El comando de instalación desde upstream solo corresponde después de que los archivos estén integrados en su rama principal.

## Comprobación local y límites de esta investigación

Se inspeccionaron código, contratos, ejemplo, README y ayuda declarada. Se ejecutaron inicialmente dos comprobaciones sobre el CLI **ya compilado** de `e937a6f`; son resultados históricos, anteriores a la actualización del upstream:

```text
node apps/cli/dist/bin.js doctor --json
  exit 1
  Node requerido: 24.17.0; runtime encontrado: 24.11.1
  Reasoner: disponible; self-test passed
  SHACL: unavailable / BINARY_MISSING

node apps/cli/dist/bin.js check examples/erden-demo --offline --json
  exit 3
  CHECK_SHACL_ENGINE_UNAVAILABLE / BINARY_MISSING
```

Aunque hay un binario SHACL en el árbol local, el runtime compilado no lo resuelve como motor disponible. No se ha determinado aquí si se debe a una compilación desactualizada o a la preparación del paquete. Estos resultados describen este entorno y no prueban un defecto de una distribución pública.

El README inicial indicaba que la primera distribución pública se estaba preparando. Upstream retiró esa frase. La consulta posterior a sus releases no devolvió publicaciones; se debe comprobar la disponibilidad de assets antes de instalar. La consulta web a `erden.sh` tampoco devolvió contenido accesible con la herramienta usada; eso no demuestra una caída del servicio.

La implementación posterior a esta investigación incorporó los seis skills y sus casos de evaluación. Se comprobó su estructura e instalación local y se ejecutaron tres casos con y sin skill. La preparación de SHACL quedó bloqueada por una diferencia entre el binario compilado y su hash fijado. El detalle actualizado y las verificaciones aún pendientes están en [TESTING.md](../skills/TESTING.md). No se hicieron publicaciones ni inicios de sesión en el registro.
