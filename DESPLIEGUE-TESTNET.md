# TAKI · Fondo común en Stellar testnet

Desplegado y probado el 5 de noviembre de 2026. Es la **red de pruebas** de
Stellar: el USDC es el de prueba de Circle y no vale dinero. Ningún usuario real
cobró nada.

## El contrato

| | |
|---|---|
| Contrato | [`CA4ZGDERPPN7WRIFUGCWBKRFAZDKDYCEWAKMB2AQXQTBH32XYNYYXMXU`](https://stellar.expert/explorer/testnet/contract/CA4ZGDERPPN7WRIFUGCWBKRFAZDKDYCEWAKMB2AQXQTBH32XYNYYXMXU) |
| Despliegue | [`af36f0a3…`](https://stellar.expert/explorer/testnet/tx/af36f0a365a2f6f3b03eb018f9bfca5589d802b233e0be3ad49c2d69837f2692) |
| Código (wasm hash) | `e5f0b1ff153d93099a2d21f40bbe902a638b1068a8ba7495d3314c0f435770ed` |
| Moneda | USDC de prueba de Circle, contrato `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (emisor `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) |
| Tope y comisión de TAKI | 21 % (`tope_bps` 2100, `comision_bps` 2100) |

## Las cuentas de prueba

Son llaves de prueba guardadas en la configuración local de Stellar CLI, fuera
de este repositorio: aquí solo están las direcciones públicas. **No sirven para
mainnet.**

| Nombre en Stellar CLI | Papel | Dirección |
|---|---|---|
| `taki-admin` | Administra el contrato y envía los cobros | `GANAPJTYCLKDWKAMGYITL4P2M7NBYJJDSOJTMA4ED7KF6OMY4HUM2SA3` |
| `taki-tesoreria` | Recibe la parte de TAKI | `GDRNNUE5NP6ZRG5J6VDBJF4JKP65RVMNRLMTUZP2KZUYFHKICVSI5UBE` |
| `taki-anunciante` | Paga publicidad | `GDEHPA6DU34B52Z5KZ63OPVMBNQWQ3GDD3CLKBNPYQZHMDVWHBKELPEU` |
| `taki-aliado` | Pone fondos | `GCG4KHY444WEKECGVGLUVV5EGKAK72TMY25HVHQ2P2KTEH2FHNJ7OH2I` |
| `taki-artista-a` | Artista | `GCDSDYLWOGQ5ROUKGWVZEEFY7PRC236DN5X6KC75SPG5TW44X76Z6G6V` |
| `taki-artista-b` | Artista | `GCXTZV5224GGDMKS6GBXPGERNZLAFQ7DI2SN3I5FGRYUBVVNPRIX4V3Z` |
| `taki-oyente-1` | Oyente | `GCWGAH4YKXY24UXJFP3X23JVMQ4QNOSMZ4ZBXAQ7HYYA2AAT35Z7VNPF` |
| `taki-oyente-2` | Oyente | `GDSS5UNQUW6UPK2QPLGI5XNCWEFXIQWP7LJPVS2VJS5K6MQGPQ4RKVY4` |

## El ciclo completo (período 1)

| Paso | Qué pasó | Transacción |
|---|---|---|
| 1 | El anunciante deposita 6,00 USDC (`publicidad`) | [`cb2cf6e5…`](https://stellar.expert/explorer/testnet/tx/cb2cf6e536c1ac09031610570f27138efb86b3a357d2b714c21f38954a325889) |
| 2 | El aliado deposita 4,00 USDC (`aliado`) | [`97bc3d25…`](https://stellar.expert/explorer/testnet/tx/97bc3d25476497e171073b42ceecd7e1c50e0cf6c296b71a11246657e884ae75) |
| 3 | **Cierre:** TAKI recibe 2,10 (21 %) y se publica la raíz de la lista | [`3bed023d…`](https://stellar.expert/explorer/testnet/tx/3bed023dac97d5a040b233effc8dd42a6efe778c73d0ddb8429a03b9e7684fe9) |
| 4 | Artista A cobra 3,50 | [`2fa2bd0f…`](https://stellar.expert/explorer/testnet/tx/2fa2bd0fc9dd3e3dce97aeabf2c821b707451af047e060cb10214878acc27312) |
| 5 | Artista B cobra 2,00 | [`ba0084c0…`](https://stellar.expert/explorer/testnet/tx/ba0084c01f1a0ecf17e484d3129aa0747c7a3b07825b27a6c81f9776fd0739b5) |
| 6 | Oyente 1 cobra 1,50 | [`919cd4d5…`](https://stellar.expert/explorer/testnet/tx/919cd4d5bcbeea0560b7ca291e96aae0be4c324dade7d7de640aeb8efd1ddd7e) |
| 7 | Oyente 2 cobra 0,90 | [`6f2046e6…`](https://stellar.expert/explorer/testnet/tx/6f2046e6a9f499988c56c54aeb4aec30fe8ccf6aa3d107ea4120371cf88334b1) |

Los cuatro cobros los envió y los pagó `taki-admin`. Ninguno de los artistas ni
de los oyentes firmó nada.

**Los montos del período 1 se fijaron a mano** (3,50 / 2,00 / 1,50 / 0,90) solo
para probar el contrato: la única condición era sumar 7,90. No salen de ninguna
fórmula. Desde el 6-nov-2026 los calcula `motor/reparto.mjs` (60 % artistas,
40 % oyentes, por segundos válidos de escucha); el período 2 fue el primero
calculado así (ver más abajo).

**Cuadre:** entraron 10,00 USDC. Salieron 2,10 a TAKI y 3,50 + 2,00 + 1,50 + 0,90
= 7,90 a artistas y oyentes. Al contrato le quedan 0.

Además se comprobó en la red que un segundo cobro del oyente 1 se rechaza con
`Error(Contract, #7)` (`YaCobro`).

## El período 2, el primero con la fórmula (6-nov-2026)

Mismo contrato y mismas cuentas. Los montos salen de `motor/reparto.mjs`: 60 %
para artistas y 40 % para oyentes, en proporción a los segundos válidos de escucha.

⚠️ **Las escuchas son de ejemplo**: TAKI todavía no tiene una app que las
registre. Son las de `motor/ejemplos/escuchas-ejemplo.json`, con fechas dentro
del período. Lo que sí es real en testnet: los depósitos, el cierre, los cobros
y que cada monto sale de la fórmula.

| Paso | Qué pasó | Transacción |
|---|---|---|
| 0 | El anunciante y el aliado compran 6 y 4 USDC de prueba con XLM de testnet | [`bbcc5783…`](https://stellar.expert/explorer/testnet/tx/bbcc5783fd0cb963ae948769cbd1634f1e08e229c21a4a7c77252cdb333181e1) · [`387f78e0…`](https://stellar.expert/explorer/testnet/tx/387f78e0c3cffee1155260dbefa0ad9eaf7aa36f95db6dc6462edd8546f3abbc) |
| 1 | El anunciante deposita 6,00 USDC (`publicidad`) | [`df0e9430…`](https://stellar.expert/explorer/testnet/tx/df0e9430be3099e64aad84d85544cb5e31d95efb5f8795008d7d43432c943441) |
| 2 | El aliado deposita 4,00 USDC (`aliado`) | [`e78df892…`](https://stellar.expert/explorer/testnet/tx/e78df892a3a5d665704c3458d99512cef241dcd5dec950ac5507527535b5aecd) |
| 3 | `calcular_cierre`: 7,90 a repartir (lectura, sin transacción) | — |
| 4 | El motor aplica la fórmula: 19 escuchas, 15 contadas, 53 min 5 s válidos | — |
| 5 | **Cierre:** TAKI recibe 2,10 (21 %) y se publica la raíz `6ad622c8…8006` | [`9c0539b3…`](https://stellar.expert/explorer/testnet/tx/9c0539b33fee0d67c612dace5fe448c46e3d4b409e2f6d2cc4c844c9711658de) |
| 6 | Artista B cobra 3,2145683 (36 min sonando) | [`135e10ec…`](https://stellar.expert/explorer/testnet/tx/135e10ecbdabfebdfe70cfe86d25bb416dcbcb6a37c7d7fb39313057cd3897ca) |
| 7 | Artista A cobra 1,9222920 (17 min 5 s sonando + 6 min 40 s escuchando a B) | [`02e7d6ec…`](https://stellar.expert/explorer/testnet/tx/02e7d6ec8a6d21dfc65577627d4fd366522e7ebfeaa2078ed86618a239c56e71) |
| 8 | Oyente 1 cobra 1,4187755 (23 min 50 s escuchando) | [`046426e4…`](https://stellar.expert/explorer/testnet/tx/046426e480ac956dce4a64467b014fc94dd2f6ab6d033473e9a7f35c84dc48d2) |
| 9 | Oyente 2 cobra 1,3443642 (22 min 35 s escuchando) | [`55e45ad7…`](https://stellar.expert/explorer/testnet/tx/55e45ad7b386ca253a0bb33395fb61d0debee8d3e0008667895c4284772696e4) |

**Por qué descartó 4 escuchas:** una duró 15 segundos, una era el artista A
escuchando su propia canción y dos eran la quinta y sexta vez que el oyente 2
ponía la misma canción en el mismo día. Además, una escucha que la app reportó
como de 15 minutos contó solo los 3 min 30 s que dura la canción.

**Cuadre:** entraron 10,00 USDC. Salieron 2,10 a TAKI y 3,2145683 + 1,9222920 +
1,4187755 + 1,3443642 = 7,90 a artistas y oyentes. Al contrato le quedan 0.
Los saldos finales, leídos del contrato de USDC, suman los dos períodos: artista A
5,422292 · artista B 5,2145683 · oyente 1 2,9187755 · oyente 2 2,2443642 ·
tesorería 4,20.

También se comprobó que:
- un segundo cobro del oyente 1 en el período 2 se rechaza con `Error(Contract, #7)`;
- si a la lista publicada se le duplican las horas del oyente 2, `verificar-lista.mjs`
  la rechaza: "Los montos NO salen de la fórmula con las horas publicadas".

Archivos: `ciclo-testnet/periodo-2/` (`escuchas.json`, `entrada.json`, `lista.json`,
`registro.txt`). Las capturas de cada paso para el video están en
`../video-reparto/material/` (ver su `INDICE.md`).

## Cómo comprobarlo sin creerle a TAKI

1. Abrir el contrato en stellar.expert y ver sus eventos: `deposito`, `cierre`, `cobro`.
2. Recalcular la lista pública del período:
   ```bash
   node motor/verificar-lista.mjs ciclo-testnet/periodo-2/lista.json
   ```
   Recalcula la hoja de cada cuenta, verifica las cuatro pruebas, comprueba que
   la lista suma 7,90 y lleva a la raíz `6ad622c8…8006`, y recalcula cada monto
   con la fórmula y las horas publicadas. Con `ciclo-testnet/lista-periodo-1.json`
   (raíz `17517a3b…0c1b`) solo comprueba la raíz, porque esos montos fueron a mano.
3. Comparar con lo que guardó el contrato:
   ```bash
   stellar contract invoke --id CA4ZGDERPPN7WRIFUGCWBKRFAZDKDYCEWAKMB2AQXQTBH32XYNYYXMXU --network testnet --source taki-admin -- periodo --periodo 2
   ```

## Archivos del ciclo

- `ciclo-testnet/entrada-periodo-1.json`: la lista que entró al motor.
- `ciclo-testnet/lista-periodo-1.json`: la lista pública, con la raíz y una prueba por cuenta.
- `ciclo-testnet/registro.txt`: cada llamada con su transacción.

## Repetir el ciclo (por ejemplo, para grabar el video de la demo)

Se puede reutilizar el mismo contrato: el período 3 ya está abierto. Hace falta
volver a darles USDC de prueba al anunciante y al aliado (paso 0 del período 2).
Los comandos son los de `ciclo-testnet/periodo-2/registro.txt`, con `--periodo 3`:
escuchas → `node motor/reparto.mjs` → `node motor/periodo.mjs` → `cerrar_periodo`
→ un `cobrar` por cuenta. El `aRepartir` de las escuchas tiene que ser el que
devuelve `calcular_cierre`.

Si la Stellar Development Foundation reinicia testnet, el contrato y las cuentas
desaparecen y hay que volver a desplegar. Ese despliegue toma unos minutos.
