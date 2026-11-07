//! Errores del contrato. El número de cada uno es lo que aparece en el
//! explorador como `Error(Contract, #N)`: no cambiar los números ya publicados.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// El monto tiene que ser mayor que cero.
    MontoInvalido = 1,
    /// El contrato está en pausa de emergencia.
    Pausado = 2,
    /// No se puede cerrar un período en el que no entró nada.
    PeriodoVacio = 3,
    /// La lista del reparto no suma exactamente lo que hay para repartir.
    TotalNoCuadra = 4,
    /// La comisión de TAKI no puede pasar el tope del 21 %.
    ComisionSobreTope = 5,
    /// Ese período no existe o todavía no se cerró.
    PeriodoNoExiste = 6,
    /// Esa cuenta ya cobró su parte de ese período.
    YaCobro = 7,
    /// La prueba no corresponde a la lista publicada (monto, cuenta o período alterados).
    PruebaInvalida = 8,
    /// Lo cobrado en el período superaría lo que había para repartir.
    SinSaldoEnPeriodo = 9,
    /// La tesorería de TAKI y el propio contrato no pueden cobrar del reparto.
    CuentaNoPuedeCobrar = 10,
    /// Todavía no venció el plazo para cobrar ese período.
    PlazoNoVencido = 11,
    /// Lo no cobrado de ese período ya volvió al fondo común.
    PeriodoDevuelto = 12,
    /// Un cálculo se salió de rango.
    Desborde = 13,
}
