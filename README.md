# TAKI · Fondo común (contrato en Stellar)

> La música sigue gratis. Lo que gana la plataforma entra a un fondo común y,
> cada período, se reparte entre los artistas y la gente que los escucha.
> Cualquiera puede comprobarlo en la cadena.

Contrato Soroban de TAKI y su motor de reparto, hechos para el hackathon de
Stellar (noviembre de 2026).

**En la red (testnet):**
[`CA4ZGDERPPN7WRIFUGCWBKRFAZDKDYCEWAKMB2AQXQTBH32XYNYYXMXU`](https://stellar.expert/explorer/testnet/contract/CA4ZGDERPPN7WRIFUGCWBKRFAZDKDYCEWAKMB2AQXQTBH32XYNYYXMXU)

**Estado (7-nov-2026):** compila, pasa 24 pruebas del contrato y 24 del motor, y
el revisor estricto de Rust (clippy con `-D warnings`). **Está desplegado en
testnet y ya corrió dos ciclos completos**: el período 1 con montos a mano
(5-nov-2026) y el período 2 con montos calculados por la fórmula 60/40
(6-nov-2026, con escuchas de ejemplo). Cada transacción está en
[DESPLIEGUE-TESTNET.md](DESPLIEGUE-TESTNET.md).

> ⚠️ Es red de pruebas: el USDC es el de prueba de Circle y nadie cobró dinero
> real. Las escuchas del período 2 son de ejemplo, porque la app todavía no está
> publicada.

---

## Qué garantiza

| Garantía | Cómo |
|---|---|
| Nunca sale más de lo que entró | Lo cobrado en un período no puede pasar `a_repartir` |
| TAKI no se lleva más del 21 % | `TOPE_TAKI_BPS = 2_100` es una constante del código |
| El tope no se puede subir | No hay función para cambiarlo y el contrato no se puede actualizar |
| La tesorería de TAKI no cobra del reparto | `cobrar` la rechaza aunque figure en la lista |
| Nadie cobra dos veces | Marca por período y cuenta |
| La lista cuadra al centavo | `cerrar_periodo` exige que sume exactamente lo que queda |
| El redondeo favorece a la gente | La parte de TAKI se redondea hacia abajo |
| Lo no cobrado vuelve al fondo, no a TAKI | `devolver_al_fondo` a los 90 días, sin cobrar comisión otra vez |

Lo que el contrato **no** decide, a propósito: cuánto le toca a cada uno. Eso
lo calcula el motor fuera de la cadena (`motor/reparto.mjs`), que publica la
lista completa con las horas de cada cuenta. Cualquiera puede bajarla,
recalcular la raíz y recalcular cada monto.

## La fórmula del reparto (decidida el 6-nov-2026)

Lo que queda después del 21 % de TAKI se parte en dos bolsas: **60 % para
artistas y 40 % para oyentes**. Cada bolsa se divide entre el tiempo de escucha
válido del período, y eso da el precio de un segundo. Cada artista cobra los
segundos que sonaron sus canciones por ese precio; cada oyente, los segundos que
escuchó por el precio de su bolsa. Como cada escucha tiene un artista que sonó y
un oyente que escuchó, **cada hora vale lo mismo para todos**: de cada 10
centavos, 6 van al artista y 4 al oyente.

- **Canciones con feat:** la parte del artista se divide como la firmaron sus
  titulares (por ejemplo, 70/30).
- **Curadores de playlists:** reciben el 10 % de cada segundo que suena desde su
  playlist; artista y oyente lo ceden en proporción (54 / 36 / 10). Solo pagan
  las playlists públicas, de 10 canciones o más y de al menos 3 artistas, cuyo
  curador juntó 20 oyentes distintos en el período. Si no llega, ese 10 % vuelve
  al artista y al oyente: no se pierde ni se lo queda TAKI. Nadie cobra
  curaduría por sus propias canciones.

Una escucha cuenta solo si:

| Regla | Por qué |
|---|---|
| La cuenta del oyente está verificada | Sin eso, cualquiera abre mil cuentas |
| Duró 30 s o más | Saltarse una canción no es escucharla |
| No es el artista escuchando su propia música | Si no, cobraría por los dos lados |
| La misma canción cuenta hasta 4 veces por día y por oyente | Escuchar tu canción favorita varias veces está bien; ponerla en bucle, no |
| Cada oyente suma como máximo 4 horas por día | Para que dejar el celular sonando toda la noche no se lleve la bolsa |
| Nunca suma más de lo que dura la canción | La app no puede reportar 15 minutos de una canción de 3 |

Lo que no es válido no suma ni para el oyente ni para el artista. Las reglas
están en el bloque `CONFIGURACIÓN` de `motor/reparto.mjs`.

Dos detalles: cada monto se redondea hacia abajo y la fracción que sobra se
reparte de a una unidad mínima a quienes más perdieron al redondear, para que
la lista sume exactamente lo que acepta el contrato. Y si alguien cobra por más
de un lado (artista, oyente o curador), cobra todo en una sola fila, porque el
contrato paga una vez por cuenta y período.

Lo que la lista pública **no** puede probar: que las horas sean reales. Las
horas vienen de los servidores de TAKI; lo que sí se comprueba es que, con
esas horas, cada monto sale de la fórmula y nadie recibe un centavo de más.

## Funciones

| Función | Quién | Qué hace |
|---|---|---|
| `depositar(origen, monto, concepto)` | cualquiera | Mete USDC al período abierto (`publicidad`, `aliado`, `programa`…) |
| `calcular_cierre()` | lectura | Cuánto le tocaría a TAKI y cuánto se repartiría si se cerrara ahora |
| `cerrar_periodo(raiz, total_reparto)` | admin | Paga la parte de TAKI y publica la raíz de la lista |
| `cobrar(periodo, cuenta, monto, prueba)` | cualquiera | Paga a `cuenta` su parte. No pide su firma: la plata solo puede ir a ella |
| `devolver_al_fondo(periodo)` | cualquiera | Pasados 90 días, lo no cobrado vuelve al período abierto |
| `fijar_comision(bps)` | admin | Cambia la comisión, siempre entre 0 y 21 % |
| `pausar(bool)` | admin | Freno de emergencia: no entra ni sale plata |
| `cambiar_admin(nuevo)` | admin + nuevo | Pasa la administración (por ejemplo, a una multifirma) |
| `estado()`, `periodo(n)`, `ya_cobro(n, cuenta)`, `tope()` | lectura | Lo que consulta el explorador |

## La lista del reparto (árbol Merkle con SHA-256)

```
hoja = sha256(0x00 || xdr(contrato) || periodo u32 BE || xdr(cuenta) || monto i128 BE)
nodo = sha256(0x01 || menor(a, b) || mayor(a, b))
```

- SHA-256 es el hash propio de Stellar y viene en cualquier navegador: el
  explorador puede recalcular la raíz sin librerías.
- Hojas y nodos llevan prefijos distintos, y el nodo impar sube sin duplicarse
  (evita el ataque CVE-2012-2459 de Bitcoin).
- La hoja incluye el contrato y el período: una prueba no sirve en otro.
- Se usa reclamo Merkle y no un pago masivo porque una transacción de Soroban
  admite unas 50 escrituras: cada uno cobra lo suyo con su prueba.

El generador vive en `motor/merkle.mjs`. Contrato y motor tienen que coincidir
byte a byte; la prueba `coincide_con_el_motor` lo verifica con los valores de
`npm run vectores`.

## Carpetas

```
contracts/taki-fondo/src/
  lib.rs       el contrato (configuración fija arriba)
  merkle.rs    verificación de la lista
  errores.rs   errores numerados (#1 a #13)
  test.rs      24 pruebas automáticas
motor/
  reparto.mjs         la fórmula: de las escuchas del período a los montos (reglas arriba)
  merkle.mjs          arma la lista y su raíz
  periodo.mjs         genera la lista pública de un período
  verificar-lista.mjs comprueba una lista pública sin creerle a TAKI (raíz y montos)
  vectores.mjs        valores para la prueba cruzada
  ejemplos/           escuchas de ejemplo (inventadas) y lo que sale de ellas
ciclo-testnet/        período 1 (5-nov-2026, montos a mano): listas y registro de transacciones
  periodo-2/          período 2 (6-nov-2026, con la fórmula): escuchas, entrada, lista y registro
```

## Comandos

Requisitos: Rust con el destino `wasm32v1-none`, Stellar CLI 30.0.1 y Node.js
20 o más nuevo.

```bash
cargo test                 # 24 pruebas del contrato
stellar contract build     # genera target/wasm32v1-none/release/taki_fondo.wasm
cd motor && npm install && npm test   # 24 pruebas del motor (Merkle y fórmula)
```

Un período, de las escuchas a la lista pública (desde `motor/`):

```bash
node reparto.mjs ejemplos/escuchas-ejemplo.json ejemplos/entrada-ejemplo.json   # montos con la fórmula
node periodo.mjs ejemplos/entrada-ejemplo.json ejemplos/lista-ejemplo.json      # raíz y pruebas
node verificar-lista.mjs ejemplos/lista-ejemplo.json                            # lo que haría cualquiera
```

El `aRepartir` de las escuchas tiene que ser el que devuelve `calcular_cierre`
en la red; si no coincide al centavo, `cerrar_periodo` rechaza la lista.

Las llaves de prueba nunca entran a este repositorio: viven en la configuración
local de Stellar CLI, y el `.gitignore` las excluye.

## Pendiente antes de la demo

- [x] Desplegar en testnet y correr un ciclo completo (5-nov-2026)
- [x] Fórmula del reparto en el motor: 60/40 por segundos válidos (6-nov-2026)
- [x] Correr el período 2 en testnet con montos calculados por la fórmula (6-nov-2026; escuchas de ejemplo)
- [x] Feats y curaduría del 10 % en el motor (6-nov-2026)
- [ ] Que la app registre las escuchas reales (cuenta, canción, momento, segundos) y marque las cuentas verificadas
- [ ] Trustline de USDC en cada billetera que cobra (sin ella, el cobro falla): resolverlo en el registro
- [ ] Explorador adaptado a Stellar y pantalla de cobro
- [ ] Verificar el código fuente del contrato en stellar.expert

## Antes de mainnet

- [ ] Revisión externa del contrato: quien lo escribió no lo audita
- [ ] Admin en una multifirma, nunca una llave sola
