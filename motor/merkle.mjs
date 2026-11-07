/**
 * Árbol Merkle del reparto de TAKI (SHA-256).
 *
 * ESTE ARCHIVO Y `contracts/taki-fondo/src/merkle.rs` TIENEN QUE COINCIDIR
 * BYTE A BYTE. Si tocas uno, toca el otro y corre `npm run vectores`: la
 * prueba `coincide_con_el_motor` del contrato usa los valores que imprime.
 * Un byte de diferencia y nadie puede cobrar.
 *
 *   hoja = sha256(0x00 || xdr(contrato) || periodo (u32 BE) || xdr(cuenta) || monto (i128 BE))
 *   nodo = sha256(0x01 || menor(a, b) || mayor(a, b))
 *
 * Si un nivel tiene un número impar de nodos, el último sube tal cual, sin
 * duplicarse (duplicarlo permitió el ataque CVE-2012-2459 en Bitcoin).
 */

import { createHash } from "node:crypto";
import { Address } from "@stellar/stellar-sdk";

const PREFIJO_HOJA = 0x00;
const PREFIJO_NODO = 0x01;

const sha256 = (datos) => createHash("sha256").update(datos).digest();

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** i128 en big-endian, complemento a dos, 16 bytes. */
function i128be(n) {
  let v = BigInt.asUintN(128, BigInt(n));
  const b = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/** La dirección (G… o C…) como ScVal en XDR, igual que `Address::to_xdr` en Soroban. */
const xdrDireccion = (direccion) => Address.fromString(direccion).toScVal().toXDR();

export function hoja(contrato, periodo, cuenta, monto) {
  return sha256(
    Buffer.concat([
      Buffer.from([PREFIJO_HOJA]),
      xdrDireccion(contrato),
      u32be(periodo),
      xdrDireccion(cuenta),
      i128be(monto),
    ])
  );
}

export function nodo(a, b) {
  const [menor, mayor] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.concat([Buffer.from([PREFIJO_NODO]), menor, mayor]));
}

export function verificar(prueba, raiz, h) {
  let actual = h;
  for (const hermano of prueba) actual = nodo(actual, hermano);
  return actual.equals(raiz);
}

export class ArbolMerkle {
  /**
   * @param {string} contrato  dirección C… del contrato taki-fondo
   * @param {number} periodo   número del período que se cierra
   * @param {{cuenta: string, monto: bigint}[]} lista
   */
  constructor(contrato, periodo, lista) {
    if (lista.length === 0) throw new Error("una lista vacía no se puede repartir");
    const vistas = new Set();
    for (const { cuenta, monto } of lista) {
      if (vistas.has(cuenta)) throw new Error(`la cuenta ${cuenta} está dos veces en la lista`);
      if (BigInt(monto) <= 0n) throw new Error(`monto inválido para ${cuenta}`);
      vistas.add(cuenta);
    }

    this.contrato = contrato;
    this.periodo = periodo;
    this.lista = lista.map(({ cuenta, monto }) => ({ cuenta, monto: BigInt(monto) }));

    let nivel = this.lista.map(({ cuenta, monto }) => hoja(contrato, periodo, cuenta, monto));
    this.niveles = [nivel];
    while (nivel.length > 1) {
      const siguiente = [];
      for (let i = 0; i < nivel.length; i += 2) {
        siguiente.push(i + 1 < nivel.length ? nodo(nivel[i], nivel[i + 1]) : nivel[i]);
      }
      nivel = siguiente;
      this.niveles.push(nivel);
    }
  }

  get raiz() {
    return this.niveles[this.niveles.length - 1][0];
  }

  get total() {
    return this.lista.reduce((suma, { monto }) => suma + monto, 0n);
  }

  /** Los hermanos que hacen falta para probar la cuenta en la posición `indice`. */
  prueba(indice) {
    const salida = [];
    let i = indice;
    for (let n = 0; n < this.niveles.length - 1; n++) {
      const hermano = i % 2 === 0 ? i + 1 : i - 1;
      if (hermano < this.niveles[n].length) salida.push(this.niveles[n][hermano]);
      i = Math.floor(i / 2);
    }
    return salida;
  }

  indiceDe(cuenta) {
    const i = this.lista.findIndex((a) => a.cuenta === cuenta);
    if (i < 0) throw new Error(`la cuenta ${cuenta} no está en la lista`);
    return i;
  }

  /** La lista pública del período: lo que cualquiera puede bajar y comprobar. */
  publicar() {
    return {
      contrato: this.contrato,
      periodo: this.periodo,
      hash: "sha256",
      raiz: this.raiz.toString("hex"),
      total: this.total.toString(),
      lista: this.lista.map(({ cuenta, monto }, i) => ({
        cuenta,
        monto: monto.toString(),
        prueba: this.prueba(i).map((b) => b.toString("hex")),
      })),
    };
  }
}
