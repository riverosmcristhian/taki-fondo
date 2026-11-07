//! # TAKI · Fondo común
//!
//! La música sigue gratis. Lo que gana la plataforma (publicidad y fondos de
//! aliados) entra a un fondo común y, cada período, se reparte entre los
//! artistas y la gente que los escucha.
//!
//! Lo que este contrato garantiza, sin tener que creerle a TAKI:
//!
//! - **Nunca sale más de lo que entró.** Lo que se cobra en un período no
//!   puede pasar lo que había para repartir.
//! - **TAKI no pasa el 21 %.** El tope es una constante del código
//!   (`TOPE_TAKI_BPS`). El contrato no se puede actualizar: para cambiar el
//!   tope habría que desplegar otro contrato, y eso se ve.
//! - **La tesorería de TAKI no cobra del reparto.** Su parte sale al cerrar el
//!   período, y nada más.
//! - **Nadie cobra dos veces** la misma parte del mismo período.
//! - **Lo que nadie cobra vuelve al fondo**, no a TAKI, y sin volver a pagar
//!   comisión.
//!
//! Lo que el contrato NO hace, a propósito: decidir cuánto le toca a cada uno.
//! Eso lo calcula el motor de reparto fuera de la cadena (escuchas válidas,
//! antifraude), que publica la lista completa y su raíz Merkle. Cualquiera
//! puede bajar esa lista, sumarla y recalcular la raíz.
//!
//! Ciclo de un período:
//!
//! 1. `depositar`: anunciantes y aliados meten USDC al período abierto.
//! 2. `cerrar_periodo`: TAKI paga su parte a la tesorería y publica la raíz de
//!    la lista. La lista tiene que sumar exactamente lo que queda.
//! 3. `cobrar`: cada artista u oyente cobra lo suyo con su prueba. No hace
//!    falta su firma: la plata solo puede ir a la cuenta de la lista, así que
//!    TAKI puede enviar el cobro y pagar la comisión de red por él.
//! 4. `devolver_al_fondo`: pasados 90 días, lo no cobrado vuelve al período
//!    abierto. Cualquiera puede ejecutarlo.

#![no_std]

mod errores;
mod merkle;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, panic_with_error, token, Address, BytesN,
    Env, Symbol, TryFromVal, Val, Vec,
};

pub use errores::Error;

// ============================================================
// CONFIGURACIÓN FIJA (está en el código y no se puede cambiar)
// ============================================================

/// Tope de la parte de TAKI: 21 %, en puntos básicos (10 000 = 100 %).
pub const TOPE_TAKI_BPS: u32 = 2_100;

/// 100 % en puntos básicos.
const BPS_TOTAL: i128 = 10_000;

/// Plazo para cobrar un período antes de que lo no cobrado vuelva al fondo.
pub const PLAZO_COBRO_SEG: u64 = 90 * 24 * 60 * 60;

/// Largo máximo de una prueba: alcanza para listas de hasta 2^32 cuentas.
const MAX_PRUEBA: u32 = 32;

// Vida de los datos en la red (Stellar archiva lo que no se renueva).
// Un ledger cierra cada ~5 s: 17 280 ledgers ≈ 1 día.
const DIA_EN_LEDGERS: u32 = 17_280;
const TTL_UMBRAL: u32 = 30 * DIA_EN_LEDGERS;
const TTL_EXTENDER: u32 = 120 * DIA_EN_LEDGERS;

// ============================================================
// DATOS GUARDADOS
// ============================================================

#[contracttype]
#[derive(Clone)]
enum Clave {
    Admin,
    Tesoreria,
    Token,
    ComisionBps,
    Pausado,
    /// Número del período que está recibiendo plata.
    PeriodoAbierto,
    /// Lo que entró al período abierto (incluye lo devuelto de períodos viejos).
    EntradoAbierto,
    /// La parte de lo anterior que vino de períodos viejos: no paga comisión.
    DevueltoAbierto,
    /// Un período cerrado.
    Periodo(u32),
    /// Marca de que una cuenta ya cobró en un período.
    Cobro(u32, Address),
}

/// Un período cerrado, tal como queda en la cadena.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Periodo {
    /// Todo lo que entró al período.
    pub entrado: i128,
    /// La parte de `entrado` que vino de períodos anteriores sin cobrar.
    pub de_periodos_anteriores: i128,
    /// Lo que se pagó a la tesorería de TAKI al cerrar.
    pub parte_taki: i128,
    /// Lo que quedó para artistas y oyentes: `entrado - parte_taki`.
    pub a_repartir: i128,
    /// Lo que ya se cobró.
    pub cobrado: i128,
    /// Raíz Merkle de la lista del reparto.
    pub raiz: BytesN<32>,
    /// Momento del cierre (segundos Unix del ledger).
    pub cerrado_en: u64,
    /// Si lo no cobrado ya volvió al fondo.
    pub devuelto_al_fondo: bool,
}

/// Foto del contrato para el explorador.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Estado {
    pub admin: Address,
    pub tesoreria: Address,
    pub token: Address,
    pub tope_bps: u32,
    pub comision_bps: u32,
    pub pausado: bool,
    pub periodo_abierto: u32,
    pub entrado_abierto: i128,
    pub devuelto_abierto: i128,
}

/// Cómo quedaría el reparto si el período se cerrara ahora.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reparto {
    pub periodo: u32,
    pub entrado: i128,
    pub parte_taki: i128,
    pub a_repartir: i128,
}

// ============================================================
// EVENTOS (lo que lee el explorador)
// ============================================================

/// Entró plata al fondo. `concepto`: publicidad, aliado, programa…
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposito {
    #[topic]
    pub periodo: u32,
    pub origen: Address,
    pub monto: i128,
    pub concepto: Symbol,
}

/// Se cerró un período y se publicó la raíz del reparto.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cierre {
    #[topic]
    pub periodo: u32,
    pub entrado: i128,
    pub parte_taki: i128,
    pub a_repartir: i128,
    pub raiz: BytesN<32>,
}

/// Una cuenta cobró su parte.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cobro {
    #[topic]
    pub periodo: u32,
    #[topic]
    pub cuenta: Address,
    pub monto: i128,
}

/// Lo no cobrado de un período volvió al fondo.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Devolucion {
    #[topic]
    pub periodo: u32,
    pub monto: i128,
    pub al_periodo: u32,
}

/// Cambió la comisión de TAKI (siempre dentro del tope).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CambioComision {
    pub bps: u32,
}

/// Se activó o desactivó la pausa de emergencia.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CambioPausa {
    pub pausado: bool,
}

/// Cambió quién administra el contrato (ej. paso a una multifirma).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CambioAdmin {
    pub nuevo: Address,
}

// ============================================================
// AYUDANTES
// ============================================================

fn leer<V: TryFromVal<Env, Val>>(env: &Env, clave: &Clave) -> V {
    // Todo lo de la instancia se escribe en el constructor: nunca falta.
    env.storage().instance().get(clave).unwrap()
}

fn guardar<V: soroban_sdk::IntoVal<Env, Val>>(env: &Env, clave: &Clave, valor: &V) {
    env.storage().instance().set(clave, valor);
}

fn renovar_instancia(env: &Env) {
    env.storage().instance().extend_ttl(TTL_UMBRAL, TTL_EXTENDER);
}

fn renovar(env: &Env, clave: &Clave) {
    env.storage().persistent().extend_ttl(clave, TTL_UMBRAL, TTL_EXTENDER);
}

fn exigir_admin(env: &Env) {
    let admin: Address = leer(env, &Clave::Admin);
    admin.require_auth();
}

fn no_pausado(env: &Env) -> Result<(), Error> {
    let pausado: bool = leer(env, &Clave::Pausado);
    if pausado {
        Err(Error::Pausado)
    } else {
        Ok(())
    }
}

fn usdc(env: &Env) -> token::TokenClient<'_> {
    let token: Address = leer(env, &Clave::Token);
    token::TokenClient::new(env, &token)
}

/// La parte de TAKI se calcula solo sobre la plata nueva del período y se
/// redondea hacia abajo: el centavo que sobra queda para artistas y oyentes.
fn calcular(env: &Env) -> Result<Reparto, Error> {
    let entrado: i128 = leer(env, &Clave::EntradoAbierto);
    let devuelto: i128 = leer(env, &Clave::DevueltoAbierto);
    let comision: u32 = leer(env, &Clave::ComisionBps);

    let nuevo = entrado.checked_sub(devuelto).ok_or(Error::Desborde)?;
    let parte_taki = nuevo
        .checked_mul(comision as i128)
        .ok_or(Error::Desborde)?
        .checked_div(BPS_TOTAL)
        .ok_or(Error::Desborde)?;
    let a_repartir = entrado.checked_sub(parte_taki).ok_or(Error::Desborde)?;

    Ok(Reparto {
        periodo: leer(env, &Clave::PeriodoAbierto),
        entrado,
        parte_taki,
        a_repartir,
    })
}

// ============================================================
// CONTRATO
// ============================================================

#[contract]
pub struct TakiFondo;

#[contractimpl]
impl TakiFondo {
    /// Se ejecuta una sola vez, al desplegar.
    pub fn __constructor(env: Env, admin: Address, tesoreria: Address, token: Address, comision_bps: u32) {
        if comision_bps > TOPE_TAKI_BPS {
            panic_with_error!(&env, Error::ComisionSobreTope);
        }
        guardar(&env, &Clave::Admin, &admin);
        guardar(&env, &Clave::Tesoreria, &tesoreria);
        guardar(&env, &Clave::Token, &token);
        guardar(&env, &Clave::ComisionBps, &comision_bps);
        guardar(&env, &Clave::Pausado, &false);
        guardar(&env, &Clave::PeriodoAbierto, &1u32);
        guardar(&env, &Clave::EntradoAbierto, &0i128);
        guardar(&env, &Clave::DevueltoAbierto, &0i128);
        renovar_instancia(&env);
    }

    // ---------- 1. Entra la plata ----------

    /// Un anunciante o aliado mete USDC al período abierto.
    pub fn depositar(env: Env, origen: Address, monto: i128, concepto: Symbol) -> Result<(), Error> {
        origen.require_auth();
        no_pausado(&env)?;
        if monto <= 0 {
            return Err(Error::MontoInvalido);
        }

        let entrado: i128 = leer(&env, &Clave::EntradoAbierto);
        let entrado = entrado.checked_add(monto).ok_or(Error::Desborde)?;
        guardar(&env, &Clave::EntradoAbierto, &entrado);

        usdc(&env).transfer(&origen, env.current_contract_address(), &monto);

        let periodo: u32 = leer(&env, &Clave::PeriodoAbierto);
        Deposito { periodo, origen, monto, concepto }.publish(&env);
        renovar_instancia(&env);
        Ok(())
    }

    // ---------- 2. Se cierra el período ----------

    /// TAKI cierra el período: cobra su parte (dentro del tope) y publica la
    /// raíz de la lista. `total_reparto` es la suma de la lista y tiene que
    /// ser exactamente lo que queda para artistas y oyentes.
    pub fn cerrar_periodo(env: Env, raiz: BytesN<32>, total_reparto: i128) -> Result<u32, Error> {
        exigir_admin(&env);
        no_pausado(&env)?;

        let r = calcular(&env)?;
        if r.entrado <= 0 {
            return Err(Error::PeriodoVacio);
        }
        if total_reparto != r.a_repartir {
            return Err(Error::TotalNoCuadra);
        }

        let devuelto: i128 = leer(&env, &Clave::DevueltoAbierto);
        let clave = Clave::Periodo(r.periodo);
        env.storage().persistent().set(
            &clave,
            &Periodo {
                entrado: r.entrado,
                de_periodos_anteriores: devuelto,
                parte_taki: r.parte_taki,
                a_repartir: r.a_repartir,
                cobrado: 0,
                raiz: raiz.clone(),
                cerrado_en: env.ledger().timestamp(),
                devuelto_al_fondo: false,
            },
        );
        renovar(&env, &clave);

        // Se abre el período siguiente, vacío.
        guardar(&env, &Clave::PeriodoAbierto, &(r.periodo + 1));
        guardar(&env, &Clave::EntradoAbierto, &0i128);
        guardar(&env, &Clave::DevueltoAbierto, &0i128);

        if r.parte_taki > 0 {
            let tesoreria: Address = leer(&env, &Clave::Tesoreria);
            usdc(&env).transfer(&env.current_contract_address(), &tesoreria, &r.parte_taki);
        }

        Cierre {
            periodo: r.periodo,
            entrado: r.entrado,
            parte_taki: r.parte_taki,
            a_repartir: r.a_repartir,
            raiz,
        }
        .publish(&env);
        renovar_instancia(&env);
        Ok(r.periodo)
    }

    // ---------- 3. Cada uno cobra lo suyo ----------

    /// Paga a `cuenta` su parte del período, si figura en la lista.
    /// No pide la firma de la cuenta: la plata solo puede ir a ella.
    pub fn cobrar(
        env: Env,
        periodo: u32,
        cuenta: Address,
        monto: i128,
        prueba: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        no_pausado(&env)?;
        if monto <= 0 {
            return Err(Error::MontoInvalido);
        }

        let contrato = env.current_contract_address();
        let tesoreria: Address = leer(&env, &Clave::Tesoreria);
        if cuenta == tesoreria || cuenta == contrato {
            return Err(Error::CuentaNoPuedeCobrar);
        }

        let clave = Clave::Periodo(periodo);
        let mut p: Periodo = env
            .storage()
            .persistent()
            .get(&clave)
            .ok_or(Error::PeriodoNoExiste)?;
        if p.devuelto_al_fondo {
            return Err(Error::PeriodoDevuelto);
        }

        let clave_cobro = Clave::Cobro(periodo, cuenta.clone());
        if env.storage().persistent().has(&clave_cobro) {
            return Err(Error::YaCobro);
        }

        if prueba.len() > MAX_PRUEBA {
            return Err(Error::PruebaInvalida);
        }
        let h = merkle::hoja(&env, &contrato, periodo, &cuenta, monto);
        if !merkle::verificar(&env, &prueba, &p.raiz, h) {
            return Err(Error::PruebaInvalida);
        }

        let cobrado = p.cobrado.checked_add(monto).ok_or(Error::Desborde)?;
        if cobrado > p.a_repartir {
            return Err(Error::SinSaldoEnPeriodo);
        }
        p.cobrado = cobrado;
        env.storage().persistent().set(&clave, &p);
        renovar(&env, &clave);
        env.storage().persistent().set(&clave_cobro, &true);
        renovar(&env, &clave_cobro);

        usdc(&env).transfer(&contrato, &cuenta, &monto);

        Cobro { periodo, cuenta, monto }.publish(&env);
        renovar_instancia(&env);
        Ok(())
    }

    // ---------- 4. Lo no cobrado vuelve al fondo ----------

    /// Pasado el plazo, lo que nadie cobró de un período pasa al período
    /// abierto. No paga comisión otra vez. Cualquiera puede ejecutarlo.
    pub fn devolver_al_fondo(env: Env, periodo: u32) -> Result<i128, Error> {
        no_pausado(&env)?;

        let clave = Clave::Periodo(periodo);
        let mut p: Periodo = env
            .storage()
            .persistent()
            .get(&clave)
            .ok_or(Error::PeriodoNoExiste)?;
        if p.devuelto_al_fondo {
            return Err(Error::PeriodoDevuelto);
        }
        let vence = p.cerrado_en.checked_add(PLAZO_COBRO_SEG).ok_or(Error::Desborde)?;
        if env.ledger().timestamp() < vence {
            return Err(Error::PlazoNoVencido);
        }

        let resto = p.a_repartir.checked_sub(p.cobrado).ok_or(Error::Desborde)?;
        p.devuelto_al_fondo = true;
        env.storage().persistent().set(&clave, &p);
        renovar(&env, &clave);

        let entrado: i128 = leer(&env, &Clave::EntradoAbierto);
        let devuelto: i128 = leer(&env, &Clave::DevueltoAbierto);
        guardar(&env, &Clave::EntradoAbierto, &entrado.checked_add(resto).ok_or(Error::Desborde)?);
        guardar(&env, &Clave::DevueltoAbierto, &devuelto.checked_add(resto).ok_or(Error::Desborde)?);

        let al_periodo: u32 = leer(&env, &Clave::PeriodoAbierto);
        Devolucion { periodo, monto: resto, al_periodo }.publish(&env);
        renovar_instancia(&env);
        Ok(resto)
    }

    // ---------- Administración ----------

    /// Cambia la comisión de TAKI. Nunca puede pasar el tope del 21 %.
    pub fn fijar_comision(env: Env, bps: u32) -> Result<(), Error> {
        exigir_admin(&env);
        if bps > TOPE_TAKI_BPS {
            return Err(Error::ComisionSobreTope);
        }
        guardar(&env, &Clave::ComisionBps, &bps);
        CambioComision { bps }.publish(&env);
        renovar_instancia(&env);
        Ok(())
    }

    /// Pausa de emergencia: con la pausa activa no entra ni sale plata.
    pub fn pausar(env: Env, pausado: bool) {
        exigir_admin(&env);
        guardar(&env, &Clave::Pausado, &pausado);
        CambioPausa { pausado }.publish(&env);
        renovar_instancia(&env);
    }

    /// Pasa la administración a otra cuenta (por ejemplo, una multifirma).
    /// Firman los dos: el admin actual y el nuevo.
    pub fn cambiar_admin(env: Env, nuevo: Address) {
        exigir_admin(&env);
        nuevo.require_auth();
        guardar(&env, &Clave::Admin, &nuevo);
        CambioAdmin { nuevo }.publish(&env);
        renovar_instancia(&env);
    }

    // ---------- Lectura (para el explorador) ----------

    /// Foto del contrato.
    pub fn estado(env: Env) -> Estado {
        Estado {
            admin: leer(&env, &Clave::Admin),
            tesoreria: leer(&env, &Clave::Tesoreria),
            token: leer(&env, &Clave::Token),
            tope_bps: TOPE_TAKI_BPS,
            comision_bps: leer(&env, &Clave::ComisionBps),
            pausado: leer(&env, &Clave::Pausado),
            periodo_abierto: leer(&env, &Clave::PeriodoAbierto),
            entrado_abierto: leer(&env, &Clave::EntradoAbierto),
            devuelto_abierto: leer(&env, &Clave::DevueltoAbierto),
        }
    }

    /// El tope de TAKI, en puntos básicos (2100 = 21 %).
    pub fn tope(_env: Env) -> u32 {
        TOPE_TAKI_BPS
    }

    /// Cómo quedaría el reparto si el período abierto se cerrara ahora.
    /// El motor de reparto lo usa para saber cuánto tiene que sumar la lista.
    pub fn calcular_cierre(env: Env) -> Result<Reparto, Error> {
        calcular(&env)
    }

    /// Un período cerrado.
    pub fn periodo(env: Env, periodo: u32) -> Result<Periodo, Error> {
        env.storage()
            .persistent()
            .get(&Clave::Periodo(periodo))
            .ok_or(Error::PeriodoNoExiste)
    }

    /// Si una cuenta ya cobró en un período.
    pub fn ya_cobro(env: Env, periodo: u32, cuenta: Address) -> bool {
        env.storage().persistent().has(&Clave::Cobro(periodo, cuenta))
    }
}
