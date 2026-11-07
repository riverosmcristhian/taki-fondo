/**
 * Arma la lista pública de un período y su raíz.
 *
 *   node periodo.mjs <entrada.json> <salida.json>
 *
 * entrada.json (la escribe `reparto.mjs` a partir de las escuchas):
 *   { "contrato": "C…", "periodo": 2,
 *     "reparto": { "reglas": {…}, "aRepartir": "…", "segundosValidos": … },
 *     "lista": [ { "rol": "artista", "cuenta": "G…", "monto": "35000000",
 *                  "segundosArtista": 1025, "segundosOyente": 0 }, … ] }
 *
 * Los montos van en la unidad mínima de USDC (7 decimales: 1 USDC = 10 000 000).
 * La salida es lo que se publica: con ella cualquiera puede recalcular la raíz
 * y, si trae el bloque "reparto", también cada monto (`verificar-lista.mjs`).
 * El total tiene que ser exactamente el `a_repartir` que da `calcular_cierre`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArbolMerkle } from "./merkle.mjs";

export function publicarPeriodo(datos) {
  const arbol = new ArbolMerkle(datos.contrato, datos.periodo, datos.lista);
  const publica = arbol.publicar();
  if (datos.reparto && publica.total !== datos.reparto.aRepartir) {
    throw new Error(`la lista suma ${publica.total} y había ${datos.reparto.aRepartir} para repartir: el contrato la rechazaría`);
  }

  // Cada fila conserva su rol y sus segundos (artista / oyente) para el explorador y el verificador.
  const lista = publica.lista.map((fila, i) => {
    const { cuenta, monto, ...extra } = datos.lista[i];
    return { rol: extra.rol ?? null, ...extra, ...fila };
  });
  return {
    contrato: publica.contrato,
    periodo: publica.periodo,
    hash: publica.hash,
    raiz: publica.raiz,
    total: publica.total,
    ...(datos.reparto && { reparto: datos.reparto }),
    lista,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [entrada, salida] = process.argv.slice(2);
  if (!entrada || !salida) {
    console.error("uso: node periodo.mjs <entrada.json> <salida.json>");
    process.exit(1);
  }
  const publica = publicarPeriodo(JSON.parse(readFileSync(entrada, "utf8")));
  writeFileSync(salida, JSON.stringify(publica, null, 2) + "\n");
  console.log(JSON.stringify({ raiz: publica.raiz, total: publica.total, cuentas: publica.lista.length }));
}
