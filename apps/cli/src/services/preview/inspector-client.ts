import { pointPickerScript } from '@codeam/shared';

/**
 * El script que el proxy inyecta en la página del preview.
 *
 * Es lo que convierte «señalar un rectángulo» en «seleccionar un elemento»:
 * resalta lo que hay bajo el dedo y, al pulsar, devuelve al dashboard QUÉ se
 * pulsó — etiqueta, clases, texto, caja y, en desarrollo con React, el fichero
 * y la línea del componente.
 *
 * Desde que hay un solo picker, el código de la página es el «Point at it» de
 * Remix (`pointPickerScript`, de `@codeam/shared`): el velo con el hueco, el
 * anillo, la etiqueta en serif («“Comprar” button»), el salto al control que
 * envuelve lo pulsado. Aquí solo se eligen las opciones de la consola: el
 * canal y el campo de siempre (`'codeam-inspector'` en `source`, el mismo
 * cable que leen la web y la app), hasta `INSPECTOR_MAX_MARKS` marcas
 * numeradas, las marcas del agente, la fuente de React, la puerta de React
 * Native (`window.__codeamInspector`) y el morado de la consola.
 *
 * ⚠️ **Esto corre dentro de la app de otra persona.** Las reglas siguen siendo
 * las mismas y viven en el script compartido: inerte hasta que lo enciendan,
 * solo obedece a los orígenes de la lista blanca (y solo desde la ventana
 * padre), describe sin extraer, y al apagarlo no queda ni un nodo suyo.
 */

export interface InspectorClientOptions {
  /**
   * Orígenes autorizados a manejar el inspector — los del dashboard.
   * Cualquier `message` de otro sitio se descarta sin responder.
   */
  allowedOrigins: string[];
}

/** El canal, para que ni nosotros ni la app confundamos mensajes ajenos. */
export const INSPECTOR_CHANNEL = 'codeam-inspector';

/** Las marcas que guarda la página: el `MAX_MARKS` de las apps. */
export const INSPECTOR_MAX_MARKS = 4;

/** El morado eléctrico de la consola. */
export const INSPECTOR_ACCENT = '#a855f7';

/**
 * Devuelve el `<script>` completo, listo para insertar.
 *
 * La lista blanca la serializa el generador (JSON, con `<` escapado): un
 * origen con una comilla, o con un `</script>`, rompería el script y dejaría
 * la página del usuario sin cargar.
 */
export function inspectorClientSource(opts: InspectorClientOptions): string {
  const script = pointPickerScript({
    channel: INSPECTOR_CHANNEL,
    channelField: 'source',
    allowedParents: opts.allowedOrigins,
    mode: 'multi',
    maxMarks: INSPECTOR_MAX_MARKS,
    accent: INSPECTOR_ACCENT,
    agentHighlights: true,
    reactSource: true,
    globalName: '__codeamInspector',
  });
  return `<script id="codeam-inspector" data-codeam="inspector">\n${script}\n</script>`;
}
