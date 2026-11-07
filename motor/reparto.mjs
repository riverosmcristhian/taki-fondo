/**
 * TAKI · Motor del reparto: de las escuchas del período a los montos de cada cuenta.
 *
 *   node reparto.mjs <escuchas.json> <entrada.json>   ← calcula los montos
 *   node periodo.mjs <entrada.json> <lista.json>      ← después: arma la raíz y las pruebas
 *
 * =====================================================================
 * LA FÓRMULA (60/40 decidida por TAKI el 6-nov-2026; curaduría del 10 %, el mismo día)
 * ---------------------------------------------------------------------
 * Cada segundo válido de escucha vale lo mismo:
 *     valor de un segundo = a_repartir ÷ segundos válidos del período
 * Ese valor se parte así:
 *     60 % para quien sonó    (si la canción tiene feat, entre sus dueños según lo firmado)
 *     40 % para quien escuchó
 * Si el segundo sonó desde una playlist que cumple las reglas, primero sale
 * el 10 % para quien la armó (oyente o artista) y el resto se parte 60/40:
 *     54 % artista · 36 % oyente · 10 % curador
 *
 * QUÉ ES UNA ESCUCHA VÁLIDA (lo que no es válido no suma para nadie)
 *   - la cuenta del oyente está verificada (login con Pollar);
 *   - duró 30 segundos o más;
 *   - no es uno de los dueños de la canción escuchando su música;
 *   - la misma canción cuenta hasta 4 veces por día y por oyente;
 *   - cada oyente suma como máximo 4 horas por día (lo que pasa de ahí no cuenta);
 *   - nunca suma más de lo que dura la canción;
 *   - la tesorería de TAKI no cuenta como oyente ni cobra como artista.
 *
 * CUÁNDO UNA PLAYLIST PAGA CURADURÍA (si no cumple, el segundo se reparte 60/40 normal)
 *   - es pública, tiene 10 canciones o más y de al menos 3 artistas distintos;
 *   - la armó una cuenta verificada (las playlists de TAKI no cobran: la tesorería ya tiene su parte);
 *   - quien escucha no es quien la armó;
 *   - quien la armó no es dueño de esa canción (sus propias canciones no le pagan curaduría);
 *   - en el período, sus playlists tuvieron 20 oyentes distintos o más. Si no llega,
 *     ese 10 % vuelve al artista y al oyente: no se pierde ni se lo queda TAKI.
 *   El segundo se le acredita a la playlist desde la que sonó, no a todas donde aparece la canción.
 *
 * EL CENTAVO QUE SOBRA
 *   El contrato rechaza la lista si no suma exactamente `a_repartir`. Cada monto
 *   se redondea hacia abajo y lo que sobra se reparte de a una unidad mínima
 *   (0,0000001 USDC) a quienes más perdieron en el redondeo (método del resto
 *   mayor; si empatan, primero la cuenta que va antes en orden alfabético).
 *
 * UNA CUENTA, UNA FILA
 *   El contrato paga una vez por cuenta y período. Si alguien es artista, oyente
 *   y curador a la vez, cobra todo en una sola fila.
 * =====================================================================
 *
 * escuchas.json:
 *   { "contrato": "C…", "periodo": 3,
 *     "aRepartir": "79000000",        ← lo que devuelve `calcular_cierre` (7 decimales)
 *     "tesoreria": "G…",
 *     "artistas":  [ { "id": "art-a", "cuenta": "G…" } ],
 *     "canciones": [ { "id": "a1", "artista": "art-a", "duracion": 210 },
 *                    { "id": "f1", "artista": "art-a", "duracion": 190,
 *                      "titulares": [ { "artista": "art-a", "bps": 7000 }, { "artista": "art-b", "bps": 3000 } ] } ],
 *                     ↑ "titulares" solo si la canción tiene feat; sin eso, el 100 % es del artista
 *     "oyentes":   [ { "cuenta": "G…", "verificado": true, "artista": "art-a" } ],
 *                     ↑ "artista" solo si esa cuenta de oyente es de un artista
 *     "playlists": [ { "id": "pl1", "curador": "G…", "publica": true, "canciones": ["a1", "b1", …] } ],
 *     "escuchas":  [ { "oyente": "G…", "cancion": "a1", "momento": "2026-11-07T20:15:00-04:00", "segundos": 210,
 *                      "playlist": "pl1" } ] }   ← "playlist" solo si sonó desde una playlist
 *
 * El día de cada escucha es la fecha local de `momento` (la hora del oyente).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =====================================================================
// CONFIGURACIÓN: las reglas del reparto
// =====================================================================
export const REGLAS = Object.freeze({
  artistasBps: 6000, //             60 % para artistas; el resto (40 %) para oyentes
  curadorBps: 1000, //              10 % de cada segundo que suena desde una playlist, para quien la armó
  segundosMinimos: 30, //           una escucha más corta no cuenta
  conteosPorCancionDia: 4, //       la misma canción cuenta hasta 4 veces al día por oyente
  segundosPorOyenteDia: 4 * 3600, // cada oyente suma como máximo 4 horas al día
  soloVerificados: true, //         solo cuentan las cuentas verificadas
  playlistMinCanciones: 10, //      una playlist paga curaduría si tiene 10 canciones o más…
  playlistMinArtistas: 3, //        …de al menos 3 artistas distintos…
  curadorMinOyentes: 20, //         …y quien la armó juntó 20 oyentes distintos o más en el período
});

const BPS = 10_000n;
const UNIDAD = 10_000_000n; // 1 USDC = 10 000 000 unidades mínimas (7 decimales)
const MOMENTO = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const sumar = (mapa, clave, valor) => mapa.set(clave, (mapa.get(clave) ?? 0) + valor);
const sumarBig = (mapa, clave, valor) => mapa.set(clave, (mapa.get(clave) ?? 0n) + valor);

// =====================================================================
// 1 · ESCUCHAS VÁLIDAS: cuántos segundos suma cada artista, oyente y curador
// =====================================================================
export function escuchasValidas(datos, reglas = REGLAS) {
  const artistas = new Map(datos.artistas.map((a) => [a.id, a]));
  const canciones = new Map(datos.canciones.map((c) => [c.id, c]));
  const oyentes = new Map(datos.oyentes.map((o) => [o.cuenta, o]));
  const cuentasDeArtista = new Set(datos.artistas.map((a) => a.cuenta));

  for (const a of datos.artistas) {
    if (a.cuenta === datos.tesoreria) throw new Error(`el artista ${a.id} usa la cuenta de la tesorería, y la tesorería no cobra del reparto`);
  }

  // Los dueños de cada canción y su parte (en puntos básicos: 10 000 = 100 %).
  const titulares = new Map();
  for (const c of datos.canciones) {
    if (!artistas.has(c.artista)) throw new Error(`la canción ${c.id} es de un artista que no está en la lista (${c.artista})`);
    if (!(Number.isInteger(c.duracion) && c.duracion > 0)) throw new Error(`la canción ${c.id} no tiene una duración válida en segundos`);
    let total = 0;
    const filas = (c.titulares ?? [{ artista: c.artista, bps: 10_000 }]).map((t) => {
      const a = artistas.get(t.artista);
      if (!a) throw new Error(`la canción ${c.id} reparte a un artista que no está en la lista (${t.artista})`);
      if (!(Number.isInteger(t.bps) && t.bps > 0)) throw new Error(`la canción ${c.id}: la parte de ${t.artista} tiene que ser un entero mayor que cero (en puntos básicos)`);
      total += t.bps;
      return { id: a.id, cuenta: a.cuenta, bps: t.bps };
    });
    if (total !== 10_000) throw new Error(`la canción ${c.id}: las partes de sus dueños suman ${total / 100} % y tienen que sumar 100 %`);
    if (new Set(filas.map((f) => f.cuenta)).size !== filas.length) throw new Error(`la canción ${c.id} nombra dos veces al mismo dueño`);
    titulares.set(c.id, filas);
  }

  // Las playlists que pueden pagar curaduría (las demás suenan igual, pero sin el 10 %).
  const playlistsQuePagan = new Map();
  for (const p of datos.playlists ?? []) {
    const lista = new Set(p.canciones ?? []);
    const artistasDistintos = new Set([...lista].map((id) => canciones.get(id)?.artista).filter(Boolean));
    const curador = oyentes.get(p.curador);
    const verificado = !reglas.soloVerificados || curador?.verificado === true || cuentasDeArtista.has(p.curador);
    if (p.publica === false) continue;
    if (p.curador === datos.tesoreria) continue; // las playlists de TAKI no cobran
    if (!verificado) continue;
    if (lista.size < reglas.playlistMinCanciones || artistasDistintos.size < reglas.playlistMinArtistas) continue;
    playlistsQuePagan.set(p.id, { curador: p.curador, canciones: lista });
  }

  // En orden de tiempo: los topes del día se llenan con lo que se escuchó primero.
  const orden = datos.escuchas
    .map((e, i) => {
      const m = MOMENTO.exec(e.momento ?? "");
      if (!m) throw new Error(`escucha ${i + 1}: el momento "${e.momento}" no tiene el formato 2026-11-07T20:15:00-04:00`);
      if (!(Number.isInteger(e.segundos) && e.segundos >= 0)) throw new Error(`escucha ${i + 1}: los segundos tienen que ser un entero`);
      return { e, i, dia: m[1], t: Date.parse(e.momento) };
    })
    .sort((x, y) => x.t - y.t || x.i - y.i);

  const descartes = { desconocida: 0, tesoreria: 0, noVerificada: 0, corta: 0, propia: 0, repetida: 0, techoDiario: 0 };
  const validas = [];
  const conteos = new Map(); //    oyente|día|canción → veces contada
  const usados = new Map(); //     oyente|día         → segundos ya sumados
  const oyentesDeCurador = new Map(); // curador → oyentes distintos que escucharon sus playlists
  let desdePlaylistSinCuraduria = 0;

  for (const { e, dia } of orden) {
    const cancion = canciones.get(e.cancion);
    const oyente = oyentes.get(e.oyente);
    if (!cancion || !oyente) { descartes.desconocida++; continue; }
    if (e.oyente === datos.tesoreria) { descartes.tesoreria++; continue; }
    if (reglas.soloVerificados && oyente.verificado !== true) { descartes.noVerificada++; continue; }
    if (e.segundos < reglas.segundosMinimos) { descartes.corta++; continue; }

    const duenos = titulares.get(e.cancion);
    if (duenos.some((t) => t.cuenta === e.oyente || t.id === oyente.artista)) { descartes.propia++; continue; }

    const claveCancion = `${e.oyente}|${dia}|${e.cancion}`;
    const veces = conteos.get(claveCancion) ?? 0;
    if (veces >= reglas.conteosPorCancionDia) { descartes.repetida++; continue; }

    const claveDia = `${e.oyente}|${dia}`;
    const usado = usados.get(claveDia) ?? 0;
    const libre = reglas.segundosPorOyenteDia - usado;
    if (libre <= 0) { descartes.techoDiario++; continue; }

    const s = Math.min(e.segundos, cancion.duracion, libre);
    conteos.set(claveCancion, veces + 1);
    usados.set(claveDia, usado + s);

    // ¿Sonó desde una playlist que paga curaduría?
    let curador = null;
    if (e.playlist) {
      const p = playlistsQuePagan.get(e.playlist);
      const pagaAqui = p && p.canciones.has(e.cancion) && p.curador !== e.oyente && !duenos.some((t) => t.cuenta === p.curador);
      if (pagaAqui) {
        curador = p.curador;
        if (!oyentesDeCurador.has(curador)) oyentesDeCurador.set(curador, new Set());
        oyentesDeCurador.get(curador).add(e.oyente);
      } else {
        desdePlaylistSinCuraduria++;
      }
    }
    validas.push({ oyente: e.oyente, s, duenos, curador });
  }

  // Quien no juntó el mínimo de oyentes distintos no cobra curaduría: ese 10 % vuelve al artista y al oyente.
  const curadoresQueCobran = new Set([...oyentesDeCurador].filter(([, set]) => set.size >= reglas.curadorMinOyentes).map(([c]) => c));
  const curadoresSinMinimo = [...oyentesDeCurador.keys()].filter((c) => !curadoresQueCobran.has(c));

  const segArtista = new Map(); //        cuenta → segundos que sonaron sus canciones (informativo)
  const segOyente = new Map(); //         cuenta → segundos válidos que escuchó
  const segOyenteCurados = new Map(); //  cuenta → de esos, los que sonaron desde una playlist que paga
  const segCurador = new Map(); //        cuenta → segundos que otros escucharon desde sus playlists
  const puntosArtista = new Map(); //     cuenta → segundos × su parte × lo que queda después de la curaduría
  let total = 0;
  let segundosCurados = 0;
  const c = BigInt(reglas.curadorBps ?? 0);

  for (const v of validas) {
    const curada = v.curador !== null && curadoresQueCobran.has(v.curador);
    const factor = curada ? BPS - c : BPS;
    for (const t of v.duenos) {
      sumar(segArtista, t.cuenta, v.s);
      sumarBig(puntosArtista, t.cuenta, BigInt(v.s) * BigInt(t.bps) * factor);
    }
    sumar(segOyente, v.oyente, v.s);
    if (curada) {
      sumar(segOyenteCurados, v.oyente, v.s);
      sumar(segCurador, v.curador, v.s);
      segundosCurados += v.s;
    }
    total += v.s;
  }

  return {
    segArtista, segOyente, segOyenteCurados, segCurador, puntosArtista,
    segundosValidos: total, segundosCurados, contadas: validas.length, descartes,
    curadoresSinMinimo, desdePlaylistSinCuraduria,
  };
}

// =====================================================================
// 2 · MONTOS: las bolsas, el valor del segundo y lo de cada cuenta
// =====================================================================
/** Reparte `bolsa` en proporción a los pesos, con el sobrante por resto mayor. */
function repartirBolsa(bolsa, pesosPorCuenta, pesoTotal) {
  const T = BigInt(pesoTotal);
  const filas = [...pesosPorCuenta].map(([cuenta, peso]) => {
    const parte = bolsa * BigInt(peso);
    return { cuenta, monto: parte / T, resto: parte % T };
  });
  let sobra = bolsa - filas.reduce((suma, f) => suma + f.monto, 0n);
  filas.sort((a, b) => (a.resto !== b.resto ? (a.resto > b.resto ? -1 : 1) : a.cuenta < b.cuenta ? -1 : a.cuenta > b.cuenta ? 1 : 0));
  for (const f of filas) {
    if (sobra === 0n) break;
    f.monto += 1n;
    sobra -= 1n;
  }
  return new Map(filas.map((f) => [f.cuenta, f.monto]));
}

/** Lo que pesa cada oyente: sus segundos, menos el 10 % de los que sonaron desde una playlist que paga. */
export function puntosOyente(segundos, segundosCurados, reglas = REGLAS) {
  return BigInt(segundos) * BPS - BigInt(reglas.curadorBps ?? 0) * BigInt(segundosCurados ?? 0);
}

/**
 * p = { puntosArtista: Map, segOyente: Map, segOyenteCurados: Map, segCurador: Map,
 *       segundosValidos, segundosCurados }
 */
export function calcularMontos(aRepartir, p, reglas = REGLAS) {
  const enRango = (x) => Number.isInteger(x) && x >= 0 && x <= 10_000;
  if (!enRango(reglas.artistasBps)) throw new Error("artistasBps tiene que estar entre 0 y 10 000");
  if (!enRango(reglas.curadorBps ?? 0)) throw new Error("curadorBps tiene que estar entre 0 y 10 000");
  if (!(p.segundosValidos > 0)) throw new Error("no hay escuchas válidas en el período: no hay con qué repartir");
  const S = p.segundosCurados ?? 0;
  if (S > p.segundosValidos) throw new Error("hay más segundos curados que segundos válidos");

  const total = BigInt(aRepartir);
  const T = BigInt(p.segundosValidos);
  const c = BigInt(reglas.curadorBps ?? 0);

  // El 10 % de cada segundo curado, para los curadores; lo demás, 60/40.
  const bolsaCuradores = (total * c * BigInt(S)) / (BPS * T);
  const resto = total - bolsaCuradores;
  const bolsaArtistas = (resto * BigInt(reglas.artistasBps)) / BPS;
  const bolsaOyentes = resto - bolsaArtistas; // la unidad impar, si la hay, queda para los oyentes

  const pesoOyentes = puntosOyente(T, S, reglas);
  const pesoArtistas = pesoOyentes * BPS; // cada segundo se reparte entero entre los dueños de la canción
  const pesosOyente = new Map([...p.segOyente].map(([cuenta, s]) => [cuenta, puntosOyente(s, p.segOyenteCurados?.get(cuenta) ?? 0, reglas)]));

  const pagos = [
    ["artista", repartirBolsa(bolsaArtistas, p.puntosArtista, pesoArtistas)],
    ["oyente", repartirBolsa(bolsaOyentes, pesosOyente, pesoOyentes)],
    ["curador", S > 0 ? repartirBolsa(bolsaCuradores, p.segCurador, S) : new Map()],
  ];

  // Una cuenta, una fila: el contrato paga una sola vez por cuenta y período.
  const filas = new Map();
  for (const [rol, mapa] of pagos) {
    for (const [cuenta, monto] of mapa) {
      if (!filas.has(cuenta)) filas.set(cuenta, { cuenta, monto: 0n, roles: [] });
      const f = filas.get(cuenta);
      f.monto += monto;
      f.roles.push(rol);
    }
  }

  // Quien no llega a una unidad mínima no entra a la lista (el contrato no acepta montos en cero).
  const orden = (f) => (f.roles.includes("artista") ? 0 : f.roles.includes("curador") ? 1 : 2);
  const lista = [...filas.values()]
    .filter((f) => f.monto > 0n)
    .sort((a, b) => orden(a) - orden(b) || (a.monto !== b.monto ? (a.monto > b.monto ? -1 : 1) : a.cuenta < b.cuenta ? -1 : 1))
    .map(({ roles, ...f }) => ({ rol: nombrarRoles(roles), ...f }));

  return { bolsaArtistas, bolsaOyentes, bolsaCuradores, lista };
}

function nombrarRoles(roles) {
  if (roles.length === 1) return roles[0];
  return `${roles.slice(0, -1).join(", ")} y ${roles.at(-1)}`;
}

// =====================================================================
// 3 · LA ENTRADA DE periodo.mjs, con todo lo que hace falta para recalcularla
// =====================================================================
export function armarEntrada(datos, reglas = REGLAS) {
  const v = escuchasValidas(datos, reglas);
  const m = calcularMontos(datos.aRepartir, v, reglas);
  const pct = (bps) => `${bps / 100} %`;
  const entrada = {
    contrato: datos.contrato,
    periodo: datos.periodo,
    reparto: {
      formula:
        `Cada segundo válido vale lo mismo: ${pct(reglas.artistasBps)} para los dueños de la canción que sonó y ` +
        `${pct(10_000 - reglas.artistasBps)} para quien la escuchó. Si sonó desde una playlist que cumple las reglas, ` +
        `primero sale el ${pct(reglas.curadorBps)} para quien la armó.`,
      reglas: { ...reglas },
      aRepartir: BigInt(datos.aRepartir).toString(),
      bolsaArtistas: m.bolsaArtistas.toString(),
      bolsaOyentes: m.bolsaOyentes.toString(),
      bolsaCuradores: m.bolsaCuradores.toString(),
      segundosValidos: v.segundosValidos,
      segundosCurados: v.segundosCurados,
    },
    lista: m.lista.map((f) => ({
      ...f,
      monto: f.monto.toString(),
      segundosArtista: v.segArtista.get(f.cuenta) ?? 0,
      puntosArtista: (v.puntosArtista.get(f.cuenta) ?? 0n).toString(),
      segundosOyente: v.segOyente.get(f.cuenta) ?? 0,
      segundosOyenteCurados: v.segOyenteCurados.get(f.cuenta) ?? 0,
      segundosCurador: v.segCurador.get(f.cuenta) ?? 0,
    })),
  };
  return { entrada, contadas: v.contadas, descartes: v.descartes, curadoresSinMinimo: v.curadoresSinMinimo, desdePlaylistSinCuraduria: v.desdePlaylistSinCuraduria };
}

// =====================================================================
// 4 · VERIFICAR: recalcular cada monto con lo que publica la lista
// =====================================================================
/**
 * Cualquiera puede correrlo con la lista pública: no hace falta creerle a TAKI.
 * Sirve también para las listas viejas (período 2), que no traían curaduría ni feats:
 * ahí cada segundo del artista pesa entero.
 */
export function verificarMontos(publica) {
  const r = publica.reparto;
  const reglas = r.reglas;
  const errores = [];
  const T = r.segundosValidos;
  const S = r.segundosCurados ?? 0;

  const p = { puntosArtista: new Map(), segOyente: new Map(), segOyenteCurados: new Map(), segCurador: new Map(), segundosValidos: T, segundosCurados: S };
  for (const f of publica.lista) {
    const pa = f.puntosArtista !== undefined ? BigInt(f.puntosArtista) : BigInt(f.segundosArtista ?? 0) * BPS * BPS;
    if (pa > 0n) p.puntosArtista.set(f.cuenta, pa);
    if ((f.segundosOyente ?? 0) > 0) p.segOyente.set(f.cuenta, f.segundosOyente);
    if ((f.segundosOyenteCurados ?? 0) > 0) p.segOyenteCurados.set(f.cuenta, f.segundosOyenteCurados);
    if ((f.segundosCurador ?? 0) > 0) p.segCurador.set(f.cuenta, f.segundosCurador);
    if ((f.segundosOyenteCurados ?? 0) > (f.segundosOyente ?? 0)) errores.push(`${f.cuenta}: tiene más segundos curados que segundos escuchados`);
  }
  // Las cuentas que no llegaron a una unidad mínima no aparecen, así que la lista puede sumar menos, nunca más.
  const suma = (m) => [...m.values()].reduce((a, b) => a + BigInt(b), 0n);
  const pesoOyentes = puntosOyente(T, S, reglas);
  if (suma(p.segOyente) > BigInt(T)) errores.push("las horas de los oyentes suman más que las horas válidas publicadas");
  if (suma(p.puntosArtista) > pesoOyentes * BPS) errores.push("lo de los artistas suma más que las horas válidas publicadas");
  if (suma(p.segCurador) > BigInt(S) || suma(p.segOyenteCurados) > BigInt(S)) errores.push("las horas de curaduría suman más que las publicadas");

  const calculo = calcularMontos(r.aRepartir, p, reglas);
  const bolsas = [["bolsaArtistas", calculo.bolsaArtistas], ["bolsaOyentes", calculo.bolsaOyentes], ["bolsaCuradores", calculo.bolsaCuradores]];
  for (const [nombre, valor] of bolsas) {
    if ((r[nombre] ?? "0") !== valor.toString()) errores.push(`la ${nombre} publicada no sale de la regla publicada`);
  }
  const esperado = new Map(calculo.lista.map((f) => [f.cuenta, f.monto]));
  for (const f of publica.lista) {
    const e = esperado.get(f.cuenta) ?? 0n;
    if (e.toString() !== f.monto) errores.push(`${f.cuenta}: la lista dice ${usdc(f.monto)} USDC y la fórmula da ${usdc(e)} USDC`);
  }
  if (calculo.lista.length !== publica.lista.length) errores.push("la fórmula da otra cantidad de cuentas que la lista");
  if (publica.total !== undefined && r.aRepartir !== publica.total) errores.push("el total de la lista no es lo que había para repartir");

  return { ok: errores.length === 0, errores, calculo };
}

// =====================================================================
// FORMATO para la consola
// =====================================================================
export function usdc(unidades) {
  const v = BigInt(unidades);
  let dec = (v % UNIDAD).toString().padStart(7, "0").replace(/0+$/, "");
  if (dec.length < 2) dec = dec.padEnd(2, "0");
  return `${v / UNIDAD},${dec}`;
}

export function tiempo(segundos) {
  const h = Math.floor(segundos / 3600);
  const min = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  return h ? `${h} h ${min} min` : min ? `${min} min ${s} s` : `${s} s`;
}

/** Cuánto vale una hora de escucha, y cuánto se lleva cada uno, con y sin playlist. */
export function valorHora(aRepartir, segundosValidos, reglas = REGLAS) {
  const hora = (BigInt(aRepartir) * 3600n) / BigInt(segundosValidos);
  const a = BigInt(reglas.artistasBps);
  const c = BigInt(reglas.curadorBps ?? 0);
  const parte = (x) => usdc(x);
  return {
    hora: parte(hora),
    normal: { artista: parte((hora * a) / BPS), oyente: parte((hora * (BPS - a)) / BPS) },
    playlist: {
      artista: parte((hora * (BPS - c) * a) / (BPS * BPS)),
      oyente: parte((hora * (BPS - c) * (BPS - a)) / (BPS * BPS)),
      curador: parte((hora * c) / BPS),
    },
  };
}

// =====================================================================
// LÍNEA DE COMANDOS
// =====================================================================
const MOTIVOS = {
  repetida: "pasaron las 4 veces de esa canción en el día",
  corta: "duraron menos de 30 s",
  propia: "eran un dueño de la canción escuchando su música",
  techoDiario: "pasaron las 4 horas del día",
  noVerificada: "eran de cuentas sin verificar",
  tesoreria: "eran de la tesorería de TAKI",
  desconocida: "eran de una canción u oyente que no está en el archivo",
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archivo, salida] = process.argv.slice(2);
  if (!archivo || !salida) {
    console.error("uso: node reparto.mjs <escuchas.json> <entrada.json>");
    process.exit(1);
  }
  const datos = JSON.parse(readFileSync(archivo, "utf8"));
  const { entrada, contadas, descartes, curadoresSinMinimo, desdePlaylistSinCuraduria } = armarEntrada(datos);
  const r = entrada.reparto;
  const vh = valorHora(r.aRepartir, r.segundosValidos);
  writeFileSync(salida, JSON.stringify(entrada, null, 2) + "\n");

  const descartadas = Object.values(descartes).reduce((a, b) => a + b, 0);
  console.log(`Período ${entrada.periodo} · a repartir ${usdc(r.aRepartir)} USDC`);
  console.log(`  Artistas:   ${usdc(r.bolsaArtistas)} USDC`);
  console.log(`  Oyentes:    ${usdc(r.bolsaOyentes)} USDC`);
  console.log(`  Curadores:  ${usdc(r.bolsaCuradores)} USDC`);
  console.log(`  Escucha válida: ${tiempo(r.segundosValidos)} (${tiempo(r.segundosCurados)} desde playlists que pagan) → cada hora vale ${vh.hora}`);
  console.log(`    hora normal:       ${vh.normal.artista} al artista · ${vh.normal.oyente} al oyente`);
  console.log(`    hora de playlist:  ${vh.playlist.artista} al artista · ${vh.playlist.oyente} al oyente · ${vh.playlist.curador} al curador`);
  console.log(`\nEscuchas: ${contadas + descartadas} · contadas ${contadas} · descartadas ${descartadas}`);
  for (const [motivo, n] of Object.entries(descartes)) if (n) console.log(`  ${n} ${MOTIVOS[motivo]}`);
  if (desdePlaylistSinCuraduria) console.log(`  ${desdePlaylistSinCuraduria} sonaron desde una playlist que no paga curaduría (se reparten 60/40)`);
  for (const c of curadoresSinMinimo) console.log(`  ${c.slice(0, 6)}…${c.slice(-4)} no juntó ${REGLAS.curadorMinOyentes} oyentes distintos: su 10 % vuelve al artista y al oyente`);
  console.log("");
  for (const f of entrada.lista) {
    const horas = [
      f.segundosArtista && `${tiempo(f.segundosArtista)} sonando`,
      f.segundosOyente && `${tiempo(f.segundosOyente)} escuchando`,
      f.segundosCurador && `${tiempo(f.segundosCurador)} desde sus playlists`,
    ].filter(Boolean).join(" + ");
    console.log(`  ${f.rol.padEnd(26)} ${f.cuenta.slice(0, 6)}…${f.cuenta.slice(-4)}  ${usdc(f.monto).padStart(10)} USDC  (${horas})`);
  }
  // la ruta a periodo.mjs se muestra desde la carpeta donde se corrió el comando
  const periodo = relative(process.cwd(), fileURLToPath(new URL("./periodo.mjs", import.meta.url))).replace(/\\/g, "/");
  console.log(`\nEscrito ${salida}. Siguiente paso: node ${periodo} ${salida} <lista.json>`);
}
