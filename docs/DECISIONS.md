# Registro de decisiones (ADR)

Formato: contexto → decisión → consecuencias. Fecha de todas: 2026-10-05, salvo indicación.

## ADR-001 · Ticker `$DEPTH`
- **Contexto:** `$DFS` ya lo usan Digital Fantasy Sports, Defis Network y Defense Coin.
- **Decisión:** `$DEPTH`. Es una palabra completa, encaja con "Deep First Search" y ningún token vivo usa ese símbolo (CoinGecko, oct-2026). La única coincidencia es "Depth Token", que usa el símbolo `DEP` y está muerto.
- **Alternativas de reserva:** `$OPAQ`, `$DPTH`.
- **Pendiente:**
  - Revisar DexScreener y Basescan por tokens no listados con el mismo símbolo.
  - Búsqueda de marca en INPI, USPTO y EUIPO (análisis legal mantenido en privado).

## ADR-002 · Chain: Base
- **Contexto:** x402 está repartido entre Base y Solana. Solana lideró el volumen en ago–sep 2026 y Base, la cantidad de pagos.
- **Decisión:** Base. Es la única de las dos donde un dev solo puede construir privacidad real hoy:
  - Direcciones stealth ERC-5564/6538, cuentas 4337, EIP-7702.
  - Solidity + Foundry + OpenZeppelin.
  - La app de Coinbase lista los tokens de Base para trading desde el día 1.
  - Programas de financiamiento: Base Batches y Builder Grants.
- **Consecuencias:**
  - Coinbase opera un único secuenciador, lo que implica riesgo de censura (documentado).
  - Solana se suma como riel de pago, sin privacidad, en la v1.1, vía `@x402/svm`.

## ADR-003 · Quema sin swap: FeeJar + Firepit
- **Contexto:** un buyback por TWAP en un pool chico es manipulable, expone a MEV y necesita oráculo o admin.
- **Decisión:** se copia el patrón *UNIfication* de Uniswap:
  - Los fees en USDC se acumulan en un `FeeJar` inmutable.
  - Cualquiera los cobra quemando `threshold()` $DEPTH en el `Firepit`.
  - El umbral se duplica tras cada reclamo y se reduce a la mitad cada 3 días, dentro del rango [10k, 10M].
- **Consecuencias:**
  - No hay DEX, oráculo ni admin. Los reclamos son una carrera pública; `maxThreshold` acota cuánto quema quien llega segundo.
  - Queda una sola confianza: el `INITIALIZER` del FeeJar propone el Firepit una vez y queda fijo tras un timelock público de 14 días. Durante ese plazo cualquiera puede verificar que `Firepit.DEPTH()` sea el token oficial. (Antes se fijaba por codehash; se cambió porque cualquier arreglo al Firepit habría trabado los fees para siempre: hallazgo T-H-1.)

## ADR-004 · Solo los fees de Agent Safe, SDK e inferencia alimentan la quema
- **Contexto:** el riesgo §1960 de Tornado Cash y Samourai aparece cuando el valor del token depende de fees de mezcla.
- **Decisión:**
  - El FeeJar solo recibe fees de `BudgetVault` (0,1%, repartido 50/50 entre el jar y ops) y, a futuro, de la inferencia.
  - Un shielded pool futuro **no tendrá fee path** hacia el jar ni hacia el equipo.
- **Consecuencia:** hay menos revenue disponible para quemar, a cambio de un riesgo legal mucho menor.

## ADR-005 · Fundador 12%, bloqueado on-chain 4 años, sin poder venderlo OTC
- **Decisión:**
  - `DepthVesting` con `start = TGE + 365 días` y `duration = 3 × 365 días`: nada durante 12 meses y después liberación lineal durante 36.
  - Se usa `VestingWallet` y no `VestingWalletCliff`, que liberaría de golpe el 25% en el mes 12.
  - Se bloquean `transferOwnership` y `renounceOwnership`: en el contrato de OpenZeppelin original el beneficiario podía vender la posición sin vestear transfiriendo el wallet.
  - El beneficiario recomendado es un Safe, para poder rotar firmantes.
  - Contribuidores 3% con el mismo vesting.
  - Fundación 10% liberada en 5 años, lo que garantiza on-chain como máximo un 2% por año.

## ADR-006 · Pagos de agentes por burners en tramos (no ERC-1271 por pago)
- **Contexto:** en x402 `exact`, firma el `from`. Validar un contrato con ERC-1271 es una función `view`, así que no puede llevar la contabilidad del gasto.
- **Decisión:**
  - El vault fondea un burner por comerciante, hasta `trancheCap`, y el burner firma un EIP-3009 normal.
  - Funciona con cualquier facilitador.
  - Si se filtra la clave de un burner, la pérdida máxima es `trancheCap`.
- **Consecuencia (comunicada así en la web y el whitepaper):** cada comerciante ve un pagador distinto, pero el fondeo vault→burner es público. La desvinculación total llega con el shielded pool (Fase 2).

## ADR-007 · Cliente x402 propio en lugar de `@x402/fetch`
- **Decisión:** cliente v2 mínimo hecho con viem.
- **Motivos:**
  - Gate de política obligatorio entre leer el 402 y firmar.
  - Sin reintentos automáticos.
  - No se acepta la v1.
  - No se devuelven `extensions` ni `resource`.
- **Pendiente:** test de conformidad contra `@x402/core`/`@x402/evm` y contra el facilitador de CDP en Base Sepolia (hecho en local con el paquete oficial; falta en Base Sepolia).

## ADR-008 · Geo-bloqueo y lanzamiento
- **Subasta pública:**
  - Bloqueada para EE.UU., Ontario y países sancionados.
  - En la UE: o se mantiene por debajo de €1M, o se notifica un white paper MiCA en iXBRL a través de una entidad.
- **Airdrop:**
  - Solo con wallet, sin email ni KYC, para conservar la exención MiCA de oferta gratuita.
  - Snapshot no anunciado de antemano.
- **Quema:** se activa solo con el producto funcionando (FAQ de la SEC del 25-sep-2026).

## ADR-009 · No comprar stand (por ahora)
- **Contexto:**
  - Un stand cuesta entre $20k y $80k.
  - Ningún fair launch exitoso estudiado compró stand.
  - Un founder solo no puede atenderlo.
- **Decisión:** ir a ETHDenver (17–21 feb 2027) con el BUIDLathon gratis, más CFPs (EthCC, Cypherpunk Congress) y Zcon7 con beca. Se reevalúa un stand chico (~$5–10k, tier de entrada de ETHDenver) recién cuando haya demo en mainnet y usuarios.

## ADR-010 · Web sin terceros
- **Decisión:**
  - Fuentes servidas desde el propio sitio.
  - CSP estricta con Trusted Types.
  - Cero cookies, analytics y scripts externos.
  - Hosting en Cloudflare Pages o Netlify por los headers de seguridad (GitLab Pages no permite configurarlos).

## ADR-011 · Integrar un pool de privacidad de terceros, no operar uno propio (2026-10-05)
- **Contexto:**
  - Los casos de Samourai (5 y 4 años de prisión) y de Tornado Cash (Storm, culpable por §1960; Pertsev, 64 meses en Países Bajos) se apoyaron en lo mismo: el desarrollador **operaba** el servicio (coordinador, interfaz, relayers), **cobraba** por él, **sabía** del uso criminal y **no tenía controles**.
  - La jueza del caso Storm no exigió custodia de fondos para aplicar §1960.
- **Decisión:**
  - Deep First Search **no despliega ni opera** un shielded pool.
  - En la Fase 2 se **integra** un pool de terceros con controles: association sets, screening de depósitos, `ragequit`, límites. El candidato es Privacy Pools (0xbow), si lo despliegan en Base.
  - Se integra como un usuario más: sin interfaz propia del pool, sin relayers, sin fees y sin token vinculado.
- **Consecuencias:**
  - Dependemos del calendario de un tercero.
  - Se elimina el riesgo legal más alto del roadmap.
  - Si no hay pool en Base, la privacidad del pagador se queda en "un pagador por comerciante" y así se comunica.

## ADR-012 · Geo-bloqueo ampliado y anti-fraccionamiento (2026-10-05)
- **Venta pública:** se bloquean **EE.UU., Argentina**, Ontario y países sancionados.
  - Argentina se suma porque ofrecer a residentes argentinos sin autorización de la CNV podría ser oferta pública de valores (Ley 26.831).
- **Anti-fraccionamiento:** el agente paga lo que factura el comerciante. **Nunca divide un pago para quedar bajo umbrales de reporte** (CTR, Travel Rule, TFR €1.000): hacerlo a propósito puede configurar *structuring* (31 USC 5324). El SDK paga exactamente un requerimiento por request y no fragmenta.
- **Screening de sanciones:** el SDK trae `staticListScreen` y `oracleScreen`, que fallan cerrados ante un error. Se recomienda activarlos por defecto en las integraciones.

## ADR-013 · Venta pública: pendiente de decisión (2026-10-05)
- **Opción A (actual):** subasta de precio único por el 15%, con geo-bloqueo y entidad. Financia la liquidez propia, pero es la parte con más riesgo de ser tratada como oferta de valores.
- **Opción B:** **sin venta**. Airdrop + recompensas + liquidez sembrada con fees acumulados. Reduce mucho el riesgo de valores, pero sembrar un pool con tokens propios sigue siendo vender a través del pool, y hay menos liquidez inicial.
- **Decisión:** se toma en la fase F3, con la opinión legal. Hasta entonces, **ninguna preventa, SAFT ni promesa de tokens** a nadie, tampoco a inversores en side letters.

## ADR-014 · El mensaje principal es seguridad; la privacidad se comunica por niveles (2026-10-05)
- **Contexto:** "We make them private" sobrevendía. Hoy los montos, los destinatarios y el fondeo de los pagadores son rastreables on-chain: es higiene de pseudonimato, no privacidad tipo Zcash.
- **Decisión:**
  - Claim principal: **"Safe rails for the agent economy" / "x402 made agents pay. We make them safe."**
  - La privacidad se comunica como **exposure control**, en tres niveles:
    - **Nivel 0 (hoy):** pagador distinto por comerciante; los datos de la compra no van al facilitador ni a la cadena.
    - **Nivel 1 (próximo):** pagadores fondeados vía un exchange regulado del owner. Privado frente al público, competidores y analistas; visible para el exchange y las autoridades. La credencial del exchange **nunca** está en el agente: un proceso del owner envía tramos acotados.
    - **Nivel 2 (después):** pool de privacidad de terceros con controles (ADR-011).
  - La web muestra qué cambia y qué sigue siendo **público**. Se eliminó "pre-flight simulation" porque no está implementado.

## ADR-001 (actualización 2026-10-05) · Verificación del ticker y de las marcas
- **DexScreener:** `$DEPTH` existe como tokens muy chicos en otras cadenas (Abstract "Depth Token", "Chainrom" en Robinhood Chain y Arc, un token de pump.fun en Solana; liquidez de US$0 a ~10k). **Ninguno en Base.** `$OPAQ` y `$DPTH` no tienen pares.
- **USPTO** (búsqueda previa, no profesional):
  - Sin marca exacta "DEEP FIRST SEARCH" ni "AGENT SAFE".
  - Hay una marca viva **"DEEP SEARCH"** (clase 042, SaaS): evaluar el riesgo de confusión con un profesional.
  - "DEPTH" tiene cientos de registros en varias clases.
- **Decisión:** se mantiene `$DEPTH` por ahora. Antes del TGE: búsqueda profesional y elección final entre `$DEPTH` (más fuerte) y `$DPTH`/`$OPAQ` (libres en todas las cadenas). Falta revisar "Safe" (Safe Ecosystem Foundation) para el nombre "Agent Safe".
