// Pruebas del motor del reparto (60/40, feats, curaduría del 10 % y reglas de escucha válida): `npm test`.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";
import { armarEntrada, calcularMontos, escuchasValidas, verificarMontos, REGLAS } from "./reparto.mjs";
import { publicarPeriodo } from "./periodo.mjs";

// Cuentas fijas para que las pruebas den siempre lo mismo.
const G = (n) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const CONTRATO = StrKey.encodeContract(Buffer.alloc(32, 9));
const TESORERIA = G(99);
const [ARTISTA_A, ARTISTA_B, OYENTE_1, OYENTE_2, SIN_VERIFICAR] = [G(1), G(2), G(11), G(12), G(13)];
const HORA = 3600;

function datos(escuchas, extra = {}) {
  return {
    contrato: CONTRATO,
    periodo: 2,
    aRepartir: "1000000000", // 100 USDC
    tesoreria: TESORERIA,
    artistas: [{ id: "a", cuenta: ARTISTA_A }, { id: "b", cuenta: ARTISTA_B }],
    canciones: [
      { id: "a1", artista: "a", duracion: 200 },
      { id: "b1", artista: "b", duracion: 200 },
      { id: "b-larga", artista: "b", duracion: 4 * HORA },
    ],
    oyentes: [
      { cuenta: OYENTE_1, verificado: true },
      { cuenta: OYENTE_2, verificado: true },
      { cuenta: SIN_VERIFICAR, verificado: false },
      { cuenta: ARTISTA_A, verificado: true, artista: "a" },
      { cuenta: ARTISTA_B, verificado: true }, // sin el vínculo: igual se reconoce por la cuenta
      { cuenta: TESORERIA, verificado: true },
    ],
    escuchas,
    ...extra,
  };
}
const e = (oyente, cancion, momento, segundos) => ({ oyente, cancion, momento: `2026-11-${momento}-04:00`, segundos });
const suma = (lista) => lista.reduce((a, f) => a + BigInt(f.monto), 0n);
// Sin feats ni playlists: cada segundo del artista pesa entero (10 000 × 10 000 puntos).
const simples = (segArtista, segOyente, segundosValidos) => ({
  puntosArtista: new Map([...segArtista].map(([c, s]) => [c, BigInt(s) * 100_000_000n])),
  segOyente, segOyenteCurados: new Map(), segCurador: new Map(), segundosValidos, segundosCurados: 0,
});

test("cada hora vale lo mismo: 60 % para el artista que sonó y 40 % para quien escuchó", () => {
  // 100 USDC y 1 000 horas: 0,06 por hora al artista y 0,04 por hora al oyente.
  const segArtista = new Map([[ARTISTA_A, 250 * HORA], [ARTISTA_B, 750 * HORA]]);
  const segOyente = new Map([[OYENTE_1, 40 * HORA], [OYENTE_2, 960 * HORA]]);
  const { bolsaArtistas, bolsaOyentes, lista } = calcularMontos("1000000000", simples(segArtista, segOyente, 1000 * HORA));
  assert.equal(bolsaArtistas, 600000000n);
  assert.equal(bolsaOyentes, 400000000n);
  const monto = (cuenta) => lista.find((f) => f.cuenta === cuenta).monto;
  assert.equal(monto(ARTISTA_A), 150000000n); // 250 h × 0,06 = 15,00
  assert.equal(monto(ARTISTA_B), 450000000n); // 750 h × 0,06 = 45,00
  assert.equal(monto(OYENTE_1), 16000000n); //   40 h × 0,04 = 1,60
  assert.equal(monto(OYENTE_2), 384000000n); // 960 h × 0,04 = 38,40
  assert.equal(suma(lista), 1000000000n);
});

test("la misma canción cuenta hasta 4 veces por día y por oyente", () => {
  const seis = [0, 4, 8, 12, 16, 20].map((m) => e(OYENTE_1, "a1", `07T20:${String(m).padStart(2, "0")}:00`, 200));
  const v = escuchasValidas(datos([...seis, e(OYENTE_1, "a1", "08T09:00:00", 200)]));
  assert.equal(v.segOyente.get(OYENTE_1), 5 * 200); // 4 el primer día + 1 al día siguiente
  assert.equal(v.segArtista.get(ARTISTA_A), 5 * 200);
  assert.equal(v.descartes.repetida, 2);
});

test("cada oyente suma como máximo 4 horas por día; lo que pasa no cuenta para nadie", () => {
  const v = escuchasValidas(datos([
    e(OYENTE_1, "b-larga", "07T08:00:00", 4 * HORA - 100), // quedan 100 s del día
    e(OYENTE_1, "a1", "07T12:30:00", 200), //                  cuenta solo 100 s
    e(OYENTE_1, "b1", "07T12:40:00", 200), //                  ya no cuenta
    e(OYENTE_1, "a1", "08T10:00:00", 200), //                  otro día: cuenta entera
  ]));
  assert.equal(v.segOyente.get(OYENTE_1), 4 * HORA + 200);
  assert.equal(v.segArtista.get(ARTISTA_A), 100 + 200);
  assert.equal(v.descartes.techoDiario, 1);
});

test("una escucha de menos de 30 s no cuenta", () => {
  const v = escuchasValidas(datos([e(OYENTE_1, "a1", "07T20:00:00", 29), e(OYENTE_1, "a1", "07T20:01:00", 30)]));
  assert.equal(v.segOyente.get(OYENTE_1), 30);
  assert.equal(v.descartes.corta, 1);
});

test("el artista escuchando su propia música no suma; escuchando a otros, sí", () => {
  const v = escuchasValidas(datos([
    e(ARTISTA_A, "a1", "07T20:00:00", 200), // propia (por el vínculo)
    e(ARTISTA_B, "b1", "07T20:00:00", 200), // propia (por la cuenta)
    e(ARTISTA_A, "b1", "07T20:05:00", 200), // de otro: cuenta
  ]));
  assert.equal(v.descartes.propia, 2);
  assert.equal(v.segOyente.get(ARTISTA_A), 200);
  assert.equal(v.segArtista.get(ARTISTA_B), 200);
  assert.equal(v.segArtista.get(ARTISTA_A), undefined);
});

test("solo cuentan las cuentas verificadas", () => {
  const d = datos([e(SIN_VERIFICAR, "a1", "07T20:00:00", 200)]);
  assert.equal(escuchasValidas(d).descartes.noVerificada, 1);
  assert.throws(() => armarEntrada(d), /no hay escuchas válidas/);
});

test("una escucha nunca suma más de lo que dura la canción", () => {
  const v = escuchasValidas(datos([e(OYENTE_1, "a1", "07T20:00:00", 900)]));
  assert.equal(v.segOyente.get(OYENTE_1), 200);
});

test("la tesorería no escucha para el reparto ni puede cobrar como artista", () => {
  const v = escuchasValidas(datos([e(TESORERIA, "a1", "07T20:00:00", 200), e(OYENTE_1, "a1", "07T20:00:00", 200)]));
  assert.equal(v.descartes.tesoreria, 1);
  assert.equal(v.segArtista.get(ARTISTA_A), 200);
  const conTesoreria = datos([], { artistas: [{ id: "a", cuenta: TESORERIA }, { id: "b", cuenta: ARTISTA_B }] });
  assert.throws(() => escuchasValidas(conTesoreria), /tesorería/);
});

test("la lista suma exactamente lo que hay y el sobrante va a quien más perdió al redondear", () => {
  // 11 unidades: 6 para artistas, 5 para tres oyentes iguales → 2, 2 y 1.
  const iguales = new Map([[OYENTE_1, 10], [OYENTE_2, 10], [G(14), 10]]);
  const { lista } = calcularMontos("11", simples(new Map([[ARTISTA_A, 30]]), iguales, 30));
  assert.equal(suma(lista), 11n);
  const oyentes = lista.filter((f) => f.rol === "oyente").map((f) => f.monto);
  assert.deepEqual(oyentes.sort(), [1n, 2n, 2n].sort());

  // Con segundos dispares y montos raros, siempre cuadra al centavo.
  const segundos = [7, 13, 101, 997, 3, 1];
  const segArtista = new Map(segundos.map((s, i) => [G(20 + i), s]));
  const segOyente = new Map(segundos.map((s, i) => [G(40 + i), s]));
  const T = segundos.reduce((a, s) => a + s, 0);
  for (const a of ["7", "79000000", "123456789", "1000000001"]) {
    const r = calcularMontos(a, simples(segArtista, segOyente, T));
    assert.equal(suma(r.lista), BigInt(a), `a repartir ${a}`);
    assert.ok(r.lista.every((f) => f.monto > 0n));
  }
});

test("un artista que también escuchó a otros cobra en una sola fila", () => {
  const { entrada } = armarEntrada(datos([e(OYENTE_1, "a1", "07T20:00:00", 200), e(ARTISTA_A, "b1", "07T20:00:00", 200)]));
  const filas = entrada.lista.filter((f) => f.cuenta === ARTISTA_A);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].rol, "artista y oyente");
  assert.doesNotThrow(() => publicarPeriodo(entrada)); // el árbol no acepta cuentas repetidas
});

test("el orden en que llegan las escuchas no cambia el resultado", () => {
  const escuchas = [
    e(OYENTE_1, "a1", "07T20:00:00", 200), e(OYENTE_1, "a1", "07T20:04:00", 200), e(OYENTE_1, "a1", "07T20:08:00", 200),
    e(OYENTE_1, "a1", "07T20:12:00", 200), e(OYENTE_1, "a1", "07T20:16:00", 200), e(OYENTE_2, "b1", "07T21:00:00", 150),
    e(OYENTE_1, "b-larga", "07T21:00:00", 4 * HORA),
  ];
  const a = armarEntrada(datos(escuchas)).entrada;
  const b = armarEntrada(datos([...escuchas].reverse())).entrada;
  assert.deepEqual(a, b);
});

test("cualquiera recalcula los montos con la lista pública, y una lista alterada no pasa", () => {
  const escuchas = [
    e(OYENTE_1, "a1", "07T20:00:00", 200), e(OYENTE_1, "b1", "07T20:04:00", 180),
    e(OYENTE_2, "b1", "07T21:00:00", 200), e(ARTISTA_A, "b1", "07T22:00:00", 95),
  ];
  const publica = publicarPeriodo(armarEntrada(datos(escuchas)).entrada);
  assert.equal(publica.total, "1000000000");
  assert.ok(verificarMontos(publica).ok);

  const horasInfladas = structuredClone(publica);
  horasInfladas.lista.find((f) => f.cuenta === OYENTE_1).segundosOyente += 60;
  assert.ok(!verificarMontos(horasInfladas).ok);

  const montoCambiado = structuredClone(publica);
  montoCambiado.lista[0].monto = String(BigInt(montoCambiado.lista[0].monto) + 1n);
  assert.ok(!verificarMontos(montoCambiado).ok);

  const otraRegla = structuredClone(publica);
  otraRegla.reparto.reglas.artistasBps = 7000;
  assert.ok(!verificarMontos(otraRegla).ok);
});

test("las reglas son las que decidió TAKI", () => {
  assert.equal(REGLAS.artistasBps, 6000);
  assert.equal(REGLAS.conteosPorCancionDia, 4);
  assert.equal(REGLAS.segundosPorOyenteDia, 4 * HORA);
  assert.equal(REGLAS.segundosMinimos, 30);
  assert.equal(REGLAS.curadorBps, 1000);
  assert.equal(REGLAS.playlistMinCanciones, 10);
  assert.equal(REGLAS.playlistMinArtistas, 3);
  assert.equal(REGLAS.curadorMinOyentes, 20);
});

// ---------------------------------------------------------------------
// Feats y curaduría de playlists
// ---------------------------------------------------------------------
const CURADOR = G(12); // OYENTE_2 arma la playlist
// Reglas de playlist bajadas para que las pruebas sean chicas; el 10 % es el de verdad.
const chicas = { ...REGLAS, playlistMinCanciones: 2, playlistMinArtistas: 2, curadorMinOyentes: 1 };
const pl = (id, curador, canciones, extra = {}) => ({ id, curador, publica: true, canciones, ...extra });
const ep = (oyente, cancion, momento, segundos, playlist) => ({ ...e(oyente, cancion, momento, segundos), playlist });
const montoDe = (lista, cuenta) => lista.find((f) => f.cuenta === cuenta)?.monto;

test("si sonó desde una playlist, el 10 % de ese segundo va a quien la armó y el resto se parte 60/40", () => {
  // 100 USDC y 400 s: cada segundo vale 0,25. Desde la playlist: 0,135 artista, 0,09 oyente, 0,025 curador.
  const d = datos([ep(OYENTE_1, "a1", "07T20:00:00", 200, "pl"), e(OYENTE_1, "b1", "07T20:05:00", 200)],
    { playlists: [pl("pl", CURADOR, ["a1", "b1"])] });
  const { entrada } = armarEntrada(d, chicas);
  const l = entrada.lista;
  assert.equal(montoDe(l, ARTISTA_A), "270000000"); // 200 s × 0,135 = 27
  assert.equal(montoDe(l, ARTISTA_B), "300000000"); // 200 s × 0,15  = 30 (sin playlist)
  assert.equal(montoDe(l, OYENTE_1), "380000000"); //  200 × 0,09 + 200 × 0,10 = 38
  assert.equal(montoDe(l, CURADOR), "50000000"); //    200 × 0,025 = 5
  assert.equal(l.find((f) => f.cuenta === CURADOR).rol, "curador");
  assert.equal(entrada.reparto.bolsaCuradores, "50000000");
  assert.equal(suma(l), 1000000000n);
});

test("una canción con feat se reparte entre sus dueños según lo firmado, y ninguno suma escuchándola", () => {
  const conFeat = { id: "f1", artista: "a", duracion: 200, titulares: [{ artista: "a", bps: 7000 }, { artista: "b", bps: 3000 }] };
  const base = datos([]);
  const d = { ...base, canciones: [...base.canciones, conFeat],
    escuchas: [e(OYENTE_1, "f1", "07T20:00:00", 200), e(ARTISTA_B, "f1", "07T20:05:00", 200)] };
  const { entrada, descartes } = armarEntrada(d);
  assert.equal(descartes.propia, 1); // el del feat escuchando la canción no suma
  assert.equal(montoDe(entrada.lista, ARTISTA_A), "420000000"); // 60 USDC × 70 %
  assert.equal(montoDe(entrada.lista, ARTISTA_B), "180000000"); // 60 USDC × 30 %
  const malSumado = { ...d, canciones: [...base.canciones, { ...conFeat, titulares: [{ artista: "a", bps: 7000 }, { artista: "b", bps: 2000 }] }] };
  assert.throws(() => armarEntrada(malSumado), /tienen que sumar 100 %/);
});

test("no pagan curaduría: las canciones propias del curador, su propia escucha ni las playlists de TAKI", () => {
  const d = datos([
    ep(OYENTE_1, "a1", "07T20:00:00", 200, "de-a"), //  canción del propio curador (ARTISTA_A): normal
    ep(OYENTE_1, "b1", "07T20:05:00", 200, "de-a"), //  canción de otro: paga a ARTISTA_A
    ep(ARTISTA_A, "b1", "07T20:10:00", 200, "de-a"), // el curador escuchando su playlist: normal
    ep(OYENTE_2, "a1", "07T20:15:00", 200, "taki"), //  playlist de TAKI: normal
  ], { playlists: [pl("de-a", ARTISTA_A, ["a1", "b1"]), pl("taki", TESORERIA, ["a1", "b1"])] });
  const { entrada } = armarEntrada(d, chicas);
  assert.equal(entrada.reparto.segundosCurados, 200);
  const filaA = entrada.lista.find((f) => f.cuenta === ARTISTA_A);
  assert.equal(filaA.rol, "artista, oyente y curador");
  assert.equal(filaA.segundosCurador, 200);
});

test("una playlist chica, privada o de un solo artista no paga curaduría", () => {
  const escuchas = [ep(OYENTE_1, "b1", "07T20:00:00", 200, "pl")];
  const casos = [
    pl("pl", CURADOR, ["a1", "b1"]), //                    2 canciones: con las reglas de verdad hacen falta 10
    pl("pl", CURADOR, ["a1", "b1"], { publica: false }), // privada
    pl("pl", CURADOR, ["b1", "b-larga"]), //               un solo artista
  ];
  for (const [i, lista] of casos.entries()) {
    const reglas = i === 0 ? { ...REGLAS, curadorMinOyentes: 1 } : chicas;
    const { entrada, desdePlaylistSinCuraduria } = armarEntrada(datos(escuchas, { playlists: [lista] }), reglas);
    assert.equal(entrada.reparto.segundosCurados, 0, `caso ${i}`);
    assert.equal(entrada.reparto.bolsaCuradores, "0", `caso ${i}`);
    assert.equal(desdePlaylistSinCuraduria, 1, `caso ${i}`);
  }
});

test("si el curador no junta 20 oyentes distintos, su 10 % vuelve al artista y al oyente", () => {
  const veinte = Array.from({ length: 20 }, (_, i) => G(100 + i));
  const conOyentes = (n) => {
    const base = datos(veinte.slice(0, n).map((o) => ep(o, "b1", "07T20:00:00", 200, "pl")), {
      playlists: [pl("pl", CURADOR, ["a1", "b1"])],
    });
    return { ...base, oyentes: [...base.oyentes, ...veinte.map((cuenta) => ({ cuenta, verificado: true }))] };
  };
  const reglas = { ...chicas, curadorMinOyentes: 20 };
  const con19 = armarEntrada(conOyentes(19), reglas);
  assert.equal(con19.entrada.reparto.segundosCurados, 0);
  assert.deepEqual(con19.curadoresSinMinimo, [CURADOR]);
  assert.equal(montoDe(con19.entrada.lista, ARTISTA_B), "600000000"); // el 60 % entero
  const con20 = armarEntrada(conOyentes(20), reglas);
  assert.equal(con20.entrada.reparto.segundosCurados, 20 * 200);
  assert.equal(montoDe(con20.entrada.lista, CURADOR), "100000000"); // 10 USDC
  assert.equal(montoDe(con20.entrada.lista, ARTISTA_B), "540000000"); // 54 USDC
});

test("con curaduría y feats, cualquiera recalcula la lista pública; si alguien la toca, no pasa", () => {
  const conFeat = { id: "f1", artista: "a", duracion: 200, titulares: [{ artista: "a", bps: 5000 }, { artista: "b", bps: 5000 }] };
  const base = datos([]);
  const d = { ...base, canciones: [...base.canciones, conFeat], playlists: [pl("pl", CURADOR, ["a1", "b1", "f1"])],
    escuchas: [ep(OYENTE_1, "f1", "07T20:00:00", 190, "pl"), ep(OYENTE_1, "b1", "07T20:05:00", 77, "pl"), e(OYENTE_2, "a1", "07T20:00:00", 133)] };
  const publica = publicarPeriodo(armarEntrada(d, chicas).entrada);
  assert.ok(verificarMontos(publica).ok, verificarMontos(publica).errores.join("; "));

  const masCuraduria = structuredClone(publica);
  masCuraduria.lista.find((f) => f.cuenta === CURADOR).segundosCurador += 30;
  assert.ok(!verificarMontos(masCuraduria).ok);

  const otroPorcentaje = structuredClone(publica);
  otroPorcentaje.reparto.reglas.curadorBps = 2000;
  assert.ok(!verificarMontos(otroPorcentaje).ok);

  const featInflado = structuredClone(publica);
  const filaA = featInflado.lista.find((f) => f.cuenta === ARTISTA_A);
  filaA.puntosArtista = String(BigInt(filaA.puntosArtista) + 10_000_000n);
  assert.ok(!verificarMontos(featInflado).ok);
});

test("la lista ya publicada del período 2 (sin curaduría ni feats) sigue verificando", () => {
  const publica = JSON.parse(readFileSync(new URL("../ciclo-testnet/periodo-2/lista.json", import.meta.url), "utf8"));
  assert.ok(verificarMontos(publica).ok);
});

