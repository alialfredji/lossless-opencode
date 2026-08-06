

# lossless-opencode

[![npm](https://img.shields.io/npm/v/lossless-opencode)](https://www.npmjs.com/package/lossless-opencode)
[![tests](https://img.shields.io/badge/tests-181%20passing-brightgreen)](https://github.com/alialfredji/lossless-opencode)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Plugin de gestión de contexto sin pérdida para OpenCode con resúmenes jerárquicos, historial DAG y recuperación BM25.

## ¿Qué es LCM?

LCM significa Lossless Context Management (Gestión de Contexto Sin Pérdida). En lugar de truncar de forma destructiva el contexto antiguo, comprime el historial en una jerarquía de resúmenes almacenados como un DAG en niveles de profundidad creciente, manteniendo los datos originales recuperables.

La recuperación BM25 mantiene los detalles relevantes anteriores accesibles, para que el modelo pueda recuperar el contexto exacto cuando los resúmenes por sí solos no sean suficientes.

## Instalación

Instala desde npm:

```bash
bun add lossless-opencode
```

Luego, agrégalo a tu configuración de OpenCode (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": [
    "lossless-opencode"
  ]
}
```

Con opciones personalizadas:

```json
{
  "plugin": [
    ["lossless-opencode", {
      "lcm": {
        "model": "anthropic/claude-sonnet-4-20250514",
        "maxContextTokens": 120000,
        "freshTailSize": 64
      }
    }]
  ]
}
```

Todas las opciones de configuración van bajo la clave `lcm`. Consulta la sección [Configuración](#configuration) a continuación para ver todas las opciones disponibles.

## Cómo Funciona

LCM almacena cada mensaje de la conversación en SQLite, indexa el texto de mensajes y resúmenes con FTS5/BM25 y compacta el historial más antiguo en un DAG de resúmenes en lugar de un único resumen plano.

```text
User Message
    |
    v
chat.message hook
    |
    v
Persist to DB -----> Track Session
    |
    v
messages.transform hook
    |
    v
Check Compaction Thresholds
    |
    +-------------------------------+
    | threshold met                 |
    v                               |
Compaction Engine                   |
    |                               |
    v                               |
Summarize Messages                  |
    |                               |
    v                               |
Store in DAG -----> Update FTS <----+
    |
    v
Assemble Context
    |
    v
BM25 Retrieve Relevant
    |
    v
Format XML
    |
    v
Return Transformed Messages
```

Flujo de alto nivel:

1. Persistir los mensajes entrantes en SQLite.
2. Detectar contenido de tamaño excesivo y reemplazarlo con un marcador de posición para archivos grandes.
3. Indexar mensajes y resúmenes para la búsqueda BM25.
4. Resumir el historial no resumido una vez que se superen los umbrales de mensajes o tokens.
5. Condensar resúmenes hacia arriba en un DAG a medida que crece la profundidad.
6. Volver a ensamblar el contexto a partir de los resúmenes raíz, los resúmenes hoja y la cola reciente dentro del presupuesto de tokens.
7. Exponer herramientas de recuperación para que el modelo pueda profundizar en el historial exacto cuando sea necesario.

Ideas centrales:

- Resumen jerárquico: los resúmenes hoja cubren mensajes en bruto, los resúmenes más profundos condensan resúmenes anteriores.
- Historial DAG: los enlaces de resúmenes padre-hijo preservan la estructura en lugar de aplanar todo.
- Recuperación BM25: `lcm_grep` y `lcm_expand_query` recuperan detalles exactos anteriores desde el historial persistente.

## Configuración

Configura el plugin bajo la clave `lcm`. Los valores predeterminados provienen de `DEFAULT_CONFIG` en `src/types.ts` y se reexportan a través de `src/config/defaults.ts`.

| Key | Type | Default | Notas |
|---|---|---|---|
| `dataDir` | `string` | `".lcm"` | Directorio de ejecución para la base de datos SQLite y los archivos de registro/salida. |
| `maxContextTokens` | `number` | `120000` | Presupuesto global de tokens para el contexto LCM ensamblado. |
| `softTokenThreshold` | `number` | `100000` | Umbral preferido antes de que aumente la presión de compactación. |
| `hardTokenThreshold` | `number` | `150000` | Umbral agresivo antes de un comportamiento de compactación más estricto. |
| `freshTailSize` | `number` | `64` | Máximo de mensajes recientes no resumidos que se mantienen en texto completo. |
| `maxLeafSummaryTokens` | `number` | `1200` | Tamaño objetivo para resúmenes de profundidad 0. |
| `maxCondensedSummaryTokens` | `number` | `2000` | Tamaño objetivo para resúmenes condensados. |
| `leafSummaryBudget` | `number` | `1200` | Presupuesto de tokens utilizado al fragmentar mensajes en bruto para la generación de resúmenes. |
| `condensedSummaryBudget` | `number` | `2000` | Presupuesto utilizado para la truncación determinista / compactación de nivel superior. |
| `maxSummaryDepth` | `number` | `5` | Profundidad máxima del DAG antes de la truncación determinista. |
| `summaryMaxOverageFactor` | `number` | `3` | Factor de excedente de resumen permitido. Presente en la estructura de configuración para ajuste fino. |
| `compactionBatchSize` | `number` | `10` | Clave de configuración de tamaño de lote expuesta por el plugin. |
| `aggressiveThreshold` | `number` | `3` | Profundidad en o por encima de la cual la compactación se vuelve agresiva. |
| `model` | `string` | `""` | Una cadena vacía significa derivar el modelo de la sesión activa de OpenCode. Los valores no vacíos deben tener el formato `provider:model` o `provider/model`. |
| `enableIntegrity` | `boolean` | `true` | Habilita el estado de configuración relacionado con la integridad. |
| `enableFts` | `boolean` | `true` | Habilita el estado de configuración relacionado con la búsqueda de texto completo. |
| `largeFileThreshold` | `number` | `50000` | Umbral de tokens para la extracción de archivos grandes. |
| `dbPath` | `string` | `".lcm/lcm.db"` | Ruta de la base de datos SQLite. Las rutas relativas se resuelven desde el directorio de configuración del plugin. |
| `summarizeAfterMessages` | `number` | `20` | Activar el resumen después de esta cantidad de mensajes no resumidos. |
| `summarizeAfterTokens` | `number` | `20000` | Activar el resumen después de esta cantidad de tokens no resumidos. |

## Herramientas

### `lcm_grep`

Búsqueda de texto completo BM25 en todo el historial de conversaciones persistente.

Argumentos:

- `query: string` obligatorio
- `limit?: number` predeterminado `10`
- `type?: "messages" | "summaries" | "all"` predeterminado `"all"`

Ejemplos:

```text
lcm_grep(query="foreign key failure")
lcm_grep(query="reset session", type="summaries", limit=5)
```

### `lcm_describe`

Muestra el estado de la sesión: mensajes totales, cola reciente, conteos del DAG de resúmenes, uso del presupuesto de tokens, conteos de FTS y nivel de compactación.

Argumentos: ninguno.

Ejemplo:

```text
lcm_describe()
```

### `lcm_expand_query`

Expande un resumen, un rango de mensajes o una consulta de búsqueda en el contenido almacenado completo.

Argumentos:

- `target: string` obligatorio. Acepta un UUID de resumen, `messages:N-M` o una consulta de búsqueda de texto libre.
- `format?: "full" | "condensed"` predeterminado `"full"`

Ejemplos:

```text
lcm_expand_query(target="messages:10-25")
lcm_expand_query(target="550e8400-e29b-41d4-a716-446655440000", format="condensed")
lcm_expand_query(target="migration error")
```

## Comandos

El plugin registra dos comandos de gestión de sesiones a través del gancho de herramientas de OpenCode:

- `lcm_new` — genera un nuevo ID de sesión e inicia una sesión rastreada nueva.
- `lcm_reset` — elimina los mensajes, resúmenes y registros de archivos grandes para la sesión actual.

## Arquitectura

Resumen de módulos:

- `src/index.ts` — punto de entrada del plugin, configuración de ganchos, registro de herramientas.
- `src/pipeline.ts` — pipeline principal de transformación de mensajes.
- `src/messages/persistence.ts` — persistencia de mensajes y consultas de mensajes no resumidos.
- `src/compaction/engine.ts` — orquestación de resúmenes, condensación, truncación determinista.
- `src/context/assembler.ts` — selección de contexto dentro del presupuesto.
- `src/context/formatter.ts` — formato de resúmenes estilo XML y de archivos grandes.
- `src/search/indexer.ts` — indexación FTS5 y recuperación BM25.
- `src/summaries/dag-store.ts` — almacenamiento de resúmenes, aristas y reconstrucción del árbol DAG.
- `src/files/large-file-handler.ts` — detección y almacenamiento de contenido de tamaño excesivo.
- `src/session/manager.ts` — utilidades del ciclo de vida de la sesión, más `lcm_new` y `lcm_reset`.
- `src/db/database.ts` / `src/db/migrations.ts` — configuración y esquema de SQLite.
- `src/integrity/checker.ts` — verificadores de integridad y utilidades de reparación.
- `src/summarization/summarizer.ts` — construcción de prompts, fragmentación y llamadas de resumen a LLM.
- `src/errors/handler.ts` — utilidades de reintentos, métodos de respaldo y registro de errores.

## Solución de Problemas

- El plugin se carga pero se ignora la configuración: usa la matriz `plugin` con una entrada `lossless-opencode` y coloca los ajustes bajo `lcm`.
- Error de validación de modelo inesperado: `model` debe estar vacío o coincidir con `provider:model` / `provider/model`.
- `.lcm` aparece constantemente en git: agrega `.lcm/` a `.gitignore` en los repositorios de consumo también si es necesario.
- La búsqueda no devuelve resultados útiles: confirma que la sesión tiene historial persistente y que FTS está habilitado en la configuración.
- La compactación nativa sigue ocurriendo: LCM establece un presupuesto de tokens alto para OpenCode, pero OpenCode aún necesita que el plugin esté cargado para que se ejecute la compactación personalizada.
- El reinicio de sesión falla con datos de ejecución antiguos: elimina el directorio local `.lcm/` e inicia una sesión nueva.

## Desarrollo

Instalación:

```bash
bun install
```

Ejecutar pruebas:

```bash
bun test
```

Ejecutar verificación de tipos:

```bash
bun run typecheck
```

Ejecutar benchmarks:

```bash
bun run bench
```

No hay un paso de compilación separado. Bun ejecuta el punto de entrada de TypeScript directamente a través de `main: "src/index.ts"`.

## Créditos

- Inspirado por el paper LCM: [Lossless Context Management for Agentic AI](https://arxiv.org/abs/2502.14258)
- Inspiración de la implementación de referencia: [lossless-claw](https://github.com/martian-engineering/lossless-claw)

## Licencia

MIT
