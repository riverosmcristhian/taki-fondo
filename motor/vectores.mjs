/**
 * Imprime vectores fijos (cuentas, hojas y raíz) para la prueba cruzada
 * `coincide_con_el_motor` del contrato. Si el contrato y el motor no
 * calculan lo mismo, esa prueba falla antes de que nadie se quede sin cobrar.
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ArbolMerkle, hoja } from "./merkle.mjs";

// Direcciones deterministas: semillas 1, 2 y 3 para cuentas, 9 para el contrato.
const cuenta = (n) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();
const contrato = StrKey.encodeContract(Buffer.alloc(32, 9));

const lista = [
  { cuenta: cuenta(1), monto: 4_000_000_000n }, // 400 USDC
  { cuenta: cuenta(2), monto: 2_000_000_000n }, // 200 USDC
  { cuenta: cuenta(3), monto: 1_900_000_000n }, // 190 USDC
];
const arbol = new ArbolMerkle(contrato, 1, lista);

console.log(JSON.stringify(
  {
    contrato,
    cuentas: lista.map((a) => a.cuenta),
    montos: lista.map((a) => a.monto.toString()),
    hoja_0: hoja(contrato, 1, lista[0].cuenta, lista[0].monto).toString("hex"),
    raiz: arbol.raiz.toString("hex"),
    total: arbol.total.toString(),
  },
  null,
  2
));
