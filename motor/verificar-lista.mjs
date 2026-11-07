/**
 * Comprueba una lista pública del reparto sin creerle a TAKI:
 * recalcula cada hoja, verifica cada prueba, suma el total y compara la raíz.
 * Si la lista publica las horas de cada cuenta (bloque "reparto"), además
 * recalcula cada monto con la fórmula (60/40 y la curaduría del 10 %) y avisa si alguno no coincide.
 *
 *   node verificar-lista.mjs <lista.json>
 *
 * Después, compara la raíz y el total con lo que dice el contrato:
 *   stellar contract invoke --id <contrato> --network testnet -- periodo --periodo <n>
 */

import { readFileSync } from "node:fs";
import { hoja, verificar } from "./merkle.mjs";
import { verificarMontos, valorHora, tiempo, usdc } from "./reparto.mjs";

const archivo = process.argv[2];
if (!archivo) {
  console.error("uso: node verificar-lista.mjs <lista.json>");
  process.exit(1);
}

const publica = JSON.parse(readFileSync(archivo, "utf8"));
const raiz = Buffer.from(publica.raiz, "hex");
let total = 0n;
let errores = 0;

for (const fila of publica.lista) {
  const h = hoja(publica.contrato, publica.periodo, fila.cuenta, BigInt(fila.monto));
  const prueba = fila.prueba.map((x) => Buffer.from(x, "hex"));
  const ok = verificar(prueba, raiz, h);
  if (!ok) errores++;
  total += BigInt(fila.monto);
  console.log(`${ok ? "✔" : "✘"} ${fila.rol ?? ""} ${fila.cuenta} ${usdc(fila.monto)} USDC`);
}

const cuadra = total.toString() === publica.total;
console.log(`\nTotal de la lista: ${usdc(total)} USDC ${cuadra ? "✔ coincide" : "✘ NO coincide"} con el total publicado`);
console.log(`Raíz: ${publica.raiz}`);
if (errores || !cuadra) {
  console.log(`\n✘ ${errores} prueba(s) no verifican.`);
  process.exit(1);
}
console.log("\n✔ Todas las pruebas llevan a la misma raíz.");

// ---------- Los montos, recalculados con la fórmula ----------
const r = publica.reparto;
if (!r) {
  console.log("\nEsta lista no publica las horas de escucha (el período 1 se armó a mano para probar el contrato): solo se comprueba la raíz.");
} else {
  console.log(`\nFórmula publicada: ${r.formula}`);
  const vh = valorHora(r.aRepartir, r.segundosValidos, r.reglas);
  console.log(`Escucha válida: ${tiempo(r.segundosValidos)} · cada hora vale ${vh.hora}: ${vh.normal.artista} al artista y ${vh.normal.oyente} al oyente`);
  if (r.segundosCurados) console.log(`Desde playlists que pagan: ${tiempo(r.segundosCurados)} · esa hora: ${vh.playlist.artista} al artista, ${vh.playlist.oyente} al oyente y ${vh.playlist.curador} al curador`);
  const montos = verificarMontos(publica);
  if (!montos.ok) {
    for (const e of montos.errores) console.log(`✘ ${e}`);
    console.log("\n✘ Los montos NO salen de la fórmula con las horas publicadas.");
    process.exit(1);
  }
  console.log("✔ Cada monto sale de la fórmula con las horas publicadas.");
}
