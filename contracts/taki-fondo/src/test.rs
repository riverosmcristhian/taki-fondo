//! Pruebas automáticas del fondo común.
//!
//! Cada prueba arma un fondo nuevo con USDC de prueba y recorre una parte del
//! ciclo: entra la plata → se cierra el período → cada uno cobra.

extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, Vec,
};
use std::vec::Vec as StdVec;

/// 1 USDC en la unidad mínima (7 decimales, como en Stellar).
const U: i128 = 10_000_000;

struct Escenario {
    env: Env,
    fondo: TakiFondoClient<'static>,
    usdc: TokenClient<'static>,
    usdc_emisor: StellarAssetClient<'static>,
    admin: Address,
    tesoreria: Address,
}

fn escenario() -> Escenario {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let tesoreria = Address::generate(&env);
    let emisor = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(emisor);
    let usdc = TokenClient::new(&env, &sac.address());
    let usdc_emisor = StellarAssetClient::new(&env, &sac.address());

    let id = env.register(
        TakiFondo,
        (admin.clone(), tesoreria.clone(), sac.address(), TOPE_TAKI_BPS),
    );
    let fondo = TakiFondoClient::new(&env, &id);

    Escenario { env, fondo, usdc, usdc_emisor, admin, tesoreria }
}

impl Escenario {
    /// Le da USDC a una cuenta y la hace depositar en el fondo.
    fn depositar(&self, monto: i128, concepto: Symbol) -> Address {
        let origen = Address::generate(&self.env);
        self.usdc_emisor.mint(&origen, &monto);
        self.fondo.depositar(&origen, &monto, &concepto);
        origen
    }

    fn cuentas(&self, n: usize) -> StdVec<Address> {
        (0..n).map(|_| Address::generate(&self.env)).collect()
    }
}

/// Arma el árbol de una lista igual que el motor de reparto y devuelve la
/// raíz y la prueba de cada cuenta. El último nodo de un nivel impar sube sin
/// duplicarse.
fn arbol(
    env: &Env,
    contrato: &Address,
    periodo: u32,
    lista: &[(Address, i128)],
) -> (BytesN<32>, StdVec<Vec<BytesN<32>>>) {
    let mut niveles: StdVec<StdVec<BytesN<32>>> = StdVec::new();
    let mut nivel: StdVec<BytesN<32>> = lista
        .iter()
        .map(|(c, m)| merkle::hoja(env, contrato, periodo, c, *m))
        .collect();
    niveles.push(nivel.clone());

    while nivel.len() > 1 {
        let mut siguiente = StdVec::new();
        let mut i = 0;
        while i < nivel.len() {
            if i + 1 < nivel.len() {
                siguiente.push(merkle::nodo(env, &nivel[i], &nivel[i + 1]));
            } else {
                siguiente.push(nivel[i].clone());
            }
            i += 2;
        }
        nivel = siguiente;
        niveles.push(nivel.clone());
    }

    let raiz = nivel[0].clone();
    let pruebas = (0..lista.len())
        .map(|indice| {
            let mut prueba = Vec::new(env);
            let mut i = indice;
            for nivel in niveles.iter().take(niveles.len() - 1) {
                let hermano = if i % 2 == 0 { i + 1 } else { i - 1 };
                if hermano < nivel.len() {
                    prueba.push_back(nivel[hermano].clone());
                }
                i /= 2;
            }
            prueba
        })
        .collect();

    (raiz, pruebas)
}

// ============================================================
// Configuración
// ============================================================

#[test]
fn el_tope_es_21_por_ciento() {
    let e = escenario();
    assert_eq!(e.fondo.tope(), 2_100);
    let estado = e.fondo.estado();
    assert_eq!(estado.tope_bps, 2_100);
    assert_eq!(estado.comision_bps, 2_100);
    assert_eq!(estado.periodo_abierto, 1);
    assert_eq!(estado.admin, e.admin);
    assert_eq!(estado.tesoreria, e.tesoreria);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn no_se_puede_desplegar_con_comision_sobre_el_tope() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let tesoreria = Address::generate(&env);
    let token = Address::generate(&env);
    env.register(TakiFondo, (admin, tesoreria, token, TOPE_TAKI_BPS + 1));
}

#[test]
fn la_comision_se_puede_bajar_pero_nunca_pasar_el_tope() {
    let e = escenario();
    assert_eq!(e.fondo.try_fijar_comision(&2_101), Err(Ok(Error::ComisionSobreTope)));
    e.fondo.fijar_comision(&1_000);
    assert_eq!(e.fondo.estado().comision_bps, 1_000);

    e.depositar(1_000 * U, symbol_short!("aliado"));
    assert_eq!(e.fondo.calcular_cierre().parte_taki, 100 * U);
}

// ============================================================
// 1. Entra la plata
// ============================================================

#[test]
fn los_depositos_se_suman_al_periodo_abierto() {
    let e = escenario();
    e.depositar(700 * U, Symbol::new(&e.env, "publicidad"));
    e.depositar(300 * U, symbol_short!("aliado"));

    assert_eq!(e.fondo.estado().entrado_abierto, 1_000 * U);
    assert_eq!(e.usdc.balance(&e.fondo.address), 1_000 * U);
}

#[test]
fn no_se_deposita_cero_ni_negativo() {
    let e = escenario();
    let origen = Address::generate(&e.env);
    assert_eq!(
        e.fondo.try_depositar(&origen, &0, &symbol_short!("aliado")),
        Err(Ok(Error::MontoInvalido))
    );
    assert_eq!(
        e.fondo.try_depositar(&origen, &-5, &symbol_short!("aliado")),
        Err(Ok(Error::MontoInvalido))
    );
}

// ============================================================
// 2. Se cierra el período
// ============================================================

#[test]
fn al_cerrar_taki_cobra_exactamente_el_21_por_ciento() {
    let e = escenario();
    e.depositar(1_000 * U, symbol_short!("aliado"));

    let raiz = BytesN::from_array(&e.env, &[7; 32]);
    let periodo = e.fondo.cerrar_periodo(&raiz, &(790 * U));

    assert_eq!(periodo, 1);
    assert_eq!(e.usdc.balance(&e.tesoreria), 210 * U);
    assert_eq!(e.usdc.balance(&e.fondo.address), 790 * U);

    let p = e.fondo.periodo(&1);
    assert_eq!(p.entrado, 1_000 * U);
    assert_eq!(p.parte_taki, 210 * U);
    assert_eq!(p.a_repartir, 790 * U);
    assert_eq!(p.raiz, raiz);

    // Se abrió el período 2, vacío.
    let estado = e.fondo.estado();
    assert_eq!(estado.periodo_abierto, 2);
    assert_eq!(estado.entrado_abierto, 0);
}

#[test]
fn el_redondeo_favorece_a_artistas_y_oyentes() {
    let e = escenario();
    // 21 % de 999 unidades = 209,79 → TAKI recibe 209 y el reparto 790.
    e.depositar(999, symbol_short!("aliado"));
    let r = e.fondo.calcular_cierre();
    assert_eq!(r.parte_taki, 209);
    assert_eq!(r.a_repartir, 790);
    assert_eq!(r.parte_taki + r.a_repartir, r.entrado);
}

#[test]
fn la_lista_tiene_que_sumar_exactamente_lo_que_queda() {
    let e = escenario();
    e.depositar(1_000 * U, symbol_short!("aliado"));
    let raiz = BytesN::from_array(&e.env, &[7; 32]);

    assert_eq!(
        e.fondo.try_cerrar_periodo(&raiz, &(791 * U)),
        Err(Ok(Error::TotalNoCuadra))
    );
    assert_eq!(
        e.fondo.try_cerrar_periodo(&raiz, &(789 * U)),
        Err(Ok(Error::TotalNoCuadra))
    );
}

#[test]
fn no_se_cierra_un_periodo_vacio() {
    let e = escenario();
    let raiz = BytesN::from_array(&e.env, &[7; 32]);
    assert_eq!(e.fondo.try_cerrar_periodo(&raiz, &0), Err(Ok(Error::PeriodoVacio)));
}

#[test]
fn solo_el_admin_cierra_el_periodo() {
    let e = escenario();
    e.depositar(1_000 * U, symbol_short!("aliado"));
    let raiz = BytesN::from_array(&e.env, &[7; 32]);
    e.fondo.cerrar_periodo(&raiz, &(790 * U));

    let firmas = e.env.auths();
    assert_eq!(firmas.len(), 1);
    assert_eq!(firmas[0].0, e.admin);
}

// ============================================================
// 3. Cada uno cobra lo suyo
// ============================================================

/// Período completo: entran 1000, TAKI cobra 210 y cuatro cuentas se reparten 790.
fn periodo_completo(e: &Escenario) -> (StdVec<(Address, i128)>, StdVec<Vec<BytesN<32>>>) {
    e.depositar(700 * U, Symbol::new(&e.env, "publicidad"));
    e.depositar(300 * U, symbol_short!("aliado"));

    let c = e.cuentas(4);
    let lista: StdVec<(Address, i128)> = std::vec![
        (c[0].clone(), 400 * U), // artista A
        (c[1].clone(), 200 * U), // artista B
        (c[2].clone(), 120 * U), // oyente 1
        (c[3].clone(), 70 * U),  // oyente 2
    ];
    let (raiz, pruebas) = arbol(&e.env, &e.fondo.address, 1, &lista);
    e.fondo.cerrar_periodo(&raiz, &(790 * U));
    (lista, pruebas)
}

#[test]
fn entro_exactamente_lo_que_salio() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);

    for (i, (cuenta, monto)) in lista.iter().enumerate() {
        e.fondo.cobrar(&1, cuenta, monto, &pruebas[i]);
        assert_eq!(e.usdc.balance(cuenta), *monto);
        assert!(e.fondo.ya_cobro(&1, cuenta));
    }

    let p = e.fondo.periodo(&1);
    assert_eq!(p.cobrado, 790 * U);
    assert_eq!(p.parte_taki + p.cobrado, p.entrado);
    assert_eq!(e.usdc.balance(&e.fondo.address), 0);
}

#[test]
fn cobrar_no_pide_la_firma_del_oyente() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);

    // Desde aquí no hay ninguna firma disponible: si `cobrar` pidiera una,
    // fallaría. Así TAKI puede enviar el cobro y pagar la comisión de red.
    e.env.set_auths(&[]);
    let (oyente, monto) = &lista[2];
    e.fondo.cobrar(&1, oyente, monto, &pruebas[2]);
    assert_eq!(e.usdc.balance(oyente), *monto);
}

#[test]
fn nadie_cobra_dos_veces() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);
    let (artista, monto) = &lista[0];

    e.fondo.cobrar(&1, artista, monto, &pruebas[0]);
    assert_eq!(
        e.fondo.try_cobrar(&1, artista, monto, &pruebas[0]),
        Err(Ok(Error::YaCobro))
    );
    assert_eq!(e.usdc.balance(artista), *monto);
}

#[test]
fn un_monto_inflado_se_rechaza() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);
    let (oyente, monto) = &lista[3];

    assert_eq!(
        e.fondo.try_cobrar(&1, oyente, &(monto + 1), &pruebas[3]),
        Err(Ok(Error::PruebaInvalida))
    );
}

#[test]
fn la_prueba_de_otra_cuenta_no_sirve() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);
    let intruso = Address::generate(&e.env);

    assert_eq!(
        e.fondo.try_cobrar(&1, &intruso, &lista[0].1, &pruebas[0]),
        Err(Ok(Error::PruebaInvalida))
    );
}

#[test]
fn la_prueba_de_un_periodo_no_sirve_en_otro() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);

    // Período 2 con la misma raíz que el 1: la hoja incluye el número de
    // período, así que la prueba del 1 no cuadra aquí.
    e.depositar(1_000 * U, symbol_short!("aliado"));
    let raiz_1 = e.fondo.periodo(&1).raiz;
    e.fondo.cerrar_periodo(&raiz_1, &(790 * U));

    let (cuenta, monto) = &lista[0];
    assert_eq!(
        e.fondo.try_cobrar(&2, cuenta, monto, &pruebas[0]),
        Err(Ok(Error::PruebaInvalida))
    );
}

#[test]
fn la_tesoreria_de_taki_no_cobra_del_reparto() {
    let e = escenario();
    e.depositar(1_000 * U, symbol_short!("aliado"));

    // Aunque alguien meta a la tesorería en la lista, el contrato no le paga.
    let artista = Address::generate(&e.env);
    let lista = std::vec![(artista, 690 * U), (e.tesoreria.clone(), 100 * U)];
    let (raiz, pruebas) = arbol(&e.env, &e.fondo.address, 1, &lista);
    e.fondo.cerrar_periodo(&raiz, &(790 * U));

    assert_eq!(
        e.fondo.try_cobrar(&1, &e.tesoreria, &(100 * U), &pruebas[1]),
        Err(Ok(Error::CuentaNoPuedeCobrar))
    );
    assert_eq!(e.usdc.balance(&e.tesoreria), 210 * U);
}

#[test]
fn una_lista_inflada_no_saca_mas_de_lo_que_hay() {
    let e = escenario();
    e.depositar(1_000 * U, symbol_short!("aliado"));

    // La lista promete 1000 aunque solo hay 790 para repartir.
    let c = e.cuentas(2);
    let lista = std::vec![(c[0].clone(), 600 * U), (c[1].clone(), 400 * U)];
    let (raiz, pruebas) = arbol(&e.env, &e.fondo.address, 1, &lista);
    e.fondo.cerrar_periodo(&raiz, &(790 * U));

    e.fondo.cobrar(&1, &c[0], &(600 * U), &pruebas[0]);
    assert_eq!(
        e.fondo.try_cobrar(&1, &c[1], &(400 * U), &pruebas[1]),
        Err(Ok(Error::SinSaldoEnPeriodo))
    );
    assert_eq!(e.usdc.balance(&e.fondo.address), 190 * U);
}

#[test]
fn no_se_cobra_de_un_periodo_que_no_cerro() {
    let e = escenario();
    let cuenta = Address::generate(&e.env);
    assert_eq!(
        e.fondo.try_cobrar(&1, &cuenta, &U, &Vec::new(&e.env)),
        Err(Ok(Error::PeriodoNoExiste))
    );
}

#[test]
fn listas_impares_y_grandes_funcionan() {
    for n in [1usize, 3, 5, 7, 33] {
        let e = escenario();
        // Entra lo justo para que cada una de las n cuentas reciba 1 USDC.
        // 21 % de comisión: entrado * 0,79 = n → se baja la comisión a 0.
        e.fondo.fijar_comision(&0);
        e.depositar(n as i128 * U, symbol_short!("aliado"));

        let lista: StdVec<(Address, i128)> =
            e.cuentas(n).into_iter().map(|c| (c, U)).collect();
        let (raiz, pruebas) = arbol(&e.env, &e.fondo.address, 1, &lista);
        e.fondo.cerrar_periodo(&raiz, &(n as i128 * U));

        for (i, (cuenta, monto)) in lista.iter().enumerate() {
            e.fondo.cobrar(&1, cuenta, monto, &pruebas[i]);
        }
        assert_eq!(e.usdc.balance(&e.fondo.address), 0, "lista de {n}");
    }
}

// ============================================================
// 4. Lo no cobrado vuelve al fondo
// ============================================================

#[test]
fn lo_no_cobrado_vuelve_al_fondo_sin_pagar_comision_otra_vez() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);

    // Solo cobra el artista A (400). Quedan 390 sin cobrar.
    e.fondo.cobrar(&1, &lista[0].0, &lista[0].1, &pruebas[0]);

    // Antes del plazo no se puede.
    assert_eq!(e.fondo.try_devolver_al_fondo(&1), Err(Ok(Error::PlazoNoVencido)));

    let cierre = e.fondo.periodo(&1).cerrado_en;
    e.env.ledger().set_timestamp(cierre + PLAZO_COBRO_SEG);
    assert_eq!(e.fondo.devolver_al_fondo(&1), 390 * U);

    // Ya nadie cobra del período 1.
    assert_eq!(
        e.fondo.try_cobrar(&1, &lista[1].0, &lista[1].1, &pruebas[1]),
        Err(Ok(Error::PeriodoDevuelto))
    );
    assert_eq!(e.fondo.try_devolver_al_fondo(&1), Err(Ok(Error::PeriodoDevuelto)));

    // Período 2: entran 100 nuevos. TAKI cobra 21 % solo de esos 100.
    e.depositar(100 * U, symbol_short!("aliado"));
    let r = e.fondo.calcular_cierre();
    assert_eq!(r.entrado, 490 * U);
    assert_eq!(r.parte_taki, 21 * U);
    assert_eq!(r.a_repartir, 469 * U);
}

// ============================================================
// Pausa y administración
// ============================================================

#[test]
fn con_la_pausa_no_entra_ni_sale_plata() {
    let e = escenario();
    let (lista, pruebas) = periodo_completo(&e);
    e.fondo.pausar(&true);

    let origen = Address::generate(&e.env);
    e.usdc_emisor.mint(&origen, &U);
    assert_eq!(
        e.fondo.try_depositar(&origen, &U, &symbol_short!("aliado")),
        Err(Ok(Error::Pausado))
    );
    assert_eq!(
        e.fondo.try_cobrar(&1, &lista[0].0, &lista[0].1, &pruebas[0]),
        Err(Ok(Error::Pausado))
    );

    e.fondo.pausar(&false);
    e.fondo.cobrar(&1, &lista[0].0, &lista[0].1, &pruebas[0]);
    assert_eq!(e.usdc.balance(&lista[0].0), lista[0].1);
}

// ============================================================
// Prueba cruzada con el motor de reparto (motor/vectores.mjs)
// ============================================================

fn desde_hex(env: &Env, hex: &str) -> BytesN<32> {
    let mut b = [0u8; 32];
    for i in 0..32 {
        b[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &b)
}

#[test]
fn coincide_con_el_motor() {
    // Valores impresos por `npm run vectores` en motor/. Si cambias el formato
    // de la hoja en cualquiera de los dos lados, esto falla.
    let env = Env::default();
    let contrato = Address::from_str(&env, "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L");
    let lista = [
        (Address::from_str(&env, "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"), 4_000_000_000i128),
        (Address::from_str(&env, "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U"), 2_000_000_000i128),
        (Address::from_str(&env, "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG"), 1_900_000_000i128),
    ];

    assert_eq!(
        merkle::hoja(&env, &contrato, 1, &lista[0].0, lista[0].1),
        desde_hex(&env, "8468df5f5565d3766d00a9d44c36c3dda10ac8dae3d2056c542194b01cf2f9a2")
    );
    let (raiz, pruebas) = arbol(&env, &contrato, 1, &lista);
    assert_eq!(
        raiz,
        desde_hex(&env, "f4f3bcee3baeadb4530ffccd657b0e7cf9c4651b1ac0abac6c1dda87b1a43892")
    );
    for (i, (cuenta, monto)) in lista.iter().enumerate() {
        let h = merkle::hoja(&env, &contrato, 1, cuenta, *monto);
        assert!(merkle::verificar(&env, &pruebas[i], &raiz, h));
    }
}

#[test]
fn el_admin_se_puede_pasar_a_otra_cuenta() {
    let e = escenario();
    let multifirma = Address::generate(&e.env);
    e.fondo.cambiar_admin(&multifirma);

    // Firmaron los dos: el admin actual y el nuevo.
    let firmantes: StdVec<Address> = e.env.auths().into_iter().map(|(a, _)| a).collect();
    assert_eq!(firmantes.len(), 2);
    assert!(firmantes.contains(&e.admin));
    assert!(firmantes.contains(&multifirma));

    assert_eq!(e.fondo.estado().admin, multifirma);
}
