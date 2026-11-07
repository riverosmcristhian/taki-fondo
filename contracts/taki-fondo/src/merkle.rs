//! Verificación de la lista del reparto con un árbol Merkle (SHA-256).
//!
//! Por qué un árbol y no pagos directos: una transacción de Soroban admite
//! unas 50 escrituras, así que pagarle a miles de cuentas en un solo paso no
//! cabe. El cálculo de fuera de la cadena publica la lista completa y una sola
//! raíz por período; cada artista u oyente cobra lo suyo probando que está en
//! esa lista. Quien nunca cobra no le cuesta nada al fondo.
//!
//! Por qué SHA-256: es el hash propio de Stellar, y cualquier navegador lo trae
//! (Web Crypto), así que el explorador puede recalcular la raíz sin librerías.
//!
//! Defensas contra los ataques clásicos de árboles Merkle:
//!
//! 1. **Separación de dominio.** Las hojas llevan el prefijo `0x00` y los nodos
//!    internos `0x01`. Sin esto, un nodo interno podría hacerse pasar por hoja.
//! 2. **Sin duplicar hojas.** Si un nivel tiene un número impar de nodos, el
//!    último sube tal cual. Duplicarlo (como hace Bitcoin) permitió el ataque
//!    CVE-2012-2459.
//! 3. **Hoja atada al contrato y al período.** Una prueba válida en un período
//!    no sirve en otro, ni en otro despliegue del contrato.
//!
//! Formato (tiene que coincidir byte a byte con `motor/merkle.mjs`):
//!
//! ```text
//! hoja = sha256(0x00 || xdr(contrato) || periodo (u32, big-endian)
//!                    || xdr(cuenta) || monto (i128, big-endian))
//! nodo = sha256(0x01 || menor(a, b) || mayor(a, b))
//! ```
//!
//! `xdr(...)` es la dirección serializada como ScVal en XDR, igual que
//! `Address.fromString(...).toScVal().toXDR()` en el SDK de JavaScript.

use soroban_sdk::{xdr::ToXdr, Address, Bytes, BytesN, Env, Vec};

pub const PREFIJO_HOJA: u8 = 0x00;
pub const PREFIJO_NODO: u8 = 0x01;

/// La hoja de una cuenta en la lista de un período.
pub fn hoja(env: &Env, contrato: &Address, periodo: u32, cuenta: &Address, monto: i128) -> BytesN<32> {
    let mut datos = Bytes::new(env);
    datos.push_back(PREFIJO_HOJA);
    datos.append(&contrato.clone().to_xdr(env));
    datos.extend_from_array(&periodo.to_be_bytes());
    datos.append(&cuenta.clone().to_xdr(env));
    datos.extend_from_array(&monto.to_be_bytes());
    env.crypto().sha256(&datos).to_bytes()
}

/// Une dos nodos. Se ordenan antes de unirlos para no depender de cuál va a
/// la izquierda: la prueba solo necesita los hermanos, no su posición.
pub fn nodo(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (a, b) = (a.to_array(), b.to_array());
    let (menor, mayor) = if a <= b { (a, b) } else { (b, a) };
    let mut datos = Bytes::new(env);
    datos.push_back(PREFIJO_NODO);
    datos.extend_from_array(&menor);
    datos.extend_from_array(&mayor);
    env.crypto().sha256(&datos).to_bytes()
}

/// Recorre la prueba desde la hoja hasta arriba y compara con la raíz.
pub fn verificar(env: &Env, prueba: &Vec<BytesN<32>>, raiz: &BytesN<32>, hoja: BytesN<32>) -> bool {
    let mut actual = hoja;
    for hermano in prueba.iter() {
        actual = nodo(env, &actual, &hermano);
    }
    &actual == raiz
}
