// Pruebas del generador de la lista del reparto: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ArbolMerkle, hoja, verificar } from "./merkle.mjs";

const contrato = StrKey.encodeContract(Buffer.alloc(32, 9));
const cuentas = (n) => Array.from({ length: n }, () => Keypair.random().publicKey());

test("todas las pruebas verifican, con listas pares e impares", () => {
  for (const n of [1, 2, 3, 5, 8, 33]) {
    const lista = cuentas(n).map((cuenta, i) => ({ cuenta, monto: BigInt(i + 1) }));
    const arbol = new ArbolMerkle(contrato, 1, lista);
    lista.forEach(({ cuenta, monto }, i) => {
      assert.ok(verificar(arbol.prueba(i), arbol.raiz, hoja(contrato, 1, cuenta, monto)), `n=${n} i=${i}`);
    });
  }
});

test("un monto alterado o un período distinto no verifican", () => {
  const lista = cuentas(4).map((cuenta) => ({ cuenta, monto: 100n }));
  const arbol = new ArbolMerkle(contrato, 1, lista);
  const { cuenta } = lista[2];
  assert.ok(!verificar(arbol.prueba(2), arbol.raiz, hoja(contrato, 1, cuenta, 101n)));
  assert.ok(!verificar(arbol.prueba(2), arbol.raiz, hoja(contrato, 2, cuenta, 100n)));
});

test("la lista pública trae la raíz, el total y una prueba por cuenta", () => {
  const lista = cuentas(3).map((cuenta) => ({ cuenta, monto: 10n }));
  const publica = new ArbolMerkle(contrato, 7, lista).publicar();
  assert.equal(publica.total, "30");
  assert.equal(publica.hash, "sha256");
  assert.equal(publica.lista.length, 3);
  assert.match(publica.raiz, /^[0-9a-f]{64}$/);
});

test("rechaza cuentas repetidas y montos en cero", () => {
  const [a] = cuentas(1);
  assert.throws(() => new ArbolMerkle(contrato, 1, [{ cuenta: a, monto: 1n }, { cuenta: a, monto: 2n }]));
  assert.throws(() => new ArbolMerkle(contrato, 1, [{ cuenta: a, monto: 0n }]));
});
