# 04 · Modelos de tokenomics no inflacionarios: qué funcionó y qué no

> Investigación web, octubre 2026. Fuentes de noticias y agregadores que a veces se contradicen; se marca dónde.

## Funcionó: buybacks pagados con revenue grande y poca presión de unlocks

- **Hyperliquid (HYPE).** ~97–99% de los fees van al Assistance Fund, que compra HYPE en mercado. Al 26-sep-2026: más de 47,5M HYPE comprados y quemados por ~$1,32B. Sin VC; 31% airdropeado a ~94k usuarios reales. [TokenPost](https://www.tokenpost.com/news/investing/24401), [DEXTools](https://www.dextools.io/news/hyperliquid-hype-unlock-july-2026-buyback-fund-onchain-data)
- **BNB auto-burn.** Fórmula `N×1000/(P+K)`, no decisión discrecional. Supply en ~133M rumbo a 100M. [CryptoSlate](https://cryptoslate.com/press-releases/bnb-chain-completes-36th-quarterly-token-burn-marks-third-burn-of-2026/)
- **Raydium.** 12% fijo de los swap fees recompra RAY automáticamente; ~$190M → ~69M RAY. Un análisis encontró que solo BNB y RAY redujeron supply neto entre 11 tokens con buyback. [Raydium docs](https://docs.raydium.io/ray/ray-buybacks), [scorecard (no peer-reviewed)](https://github.com/Ricosworks1/governance-research-reports/releases/tag/governance-buyback-effectiveness-scorecard-20260921)
- **Sky (ex-MKR) Smart Burn Engine.** ~$96,8M en FY2025, ~$1M/día en 2026. [Tokenomics.com](https://tokenomics.com/articles/sky-tokenomics-how-the-smart-burn-engine-destroys-102m-in-sky-per-year)
- **Bitcoin.** Cap de 21M creíble porque nadie lo puede cambiar.

## Mixto o fallido

- **Jupiter.** ~$70M en buybacks en 2025 con 53M JUP desbloqueándose por mes. JUP −77%; buybacks suspendidos. [KuCoin](https://www.kucoin.com/news/flash/jupiter-halts-70m-buyback-plan-amid-persistent-jup-price-decline)
- **Pump.fun.** 100% del revenue a buybacks cubría solo ~2% del volumen diario. En abr-2026 quemó 36% del supply y bajó a 50% del revenue fijado en contrato. [CoinDesk](https://www.coindesk.com/markets/2026/04/29/pump-fun-burns-36-of-pump-supply-in-usd370-million-wipe-locks-50-revenue-into-ongoing-buybacks)
- **Aave.** Presupuesto fijo en dólares (~$50M/año) a la tesorería, no quemado; recortado a $30M cuando bajaron los fees. **Usar porcentaje, no monto fijo.** [The Defiant](https://thedefiant.io/news/defi/aave-confirms-aavenomics-3-0-live-buybacks-dao-spending-cut)
- **ETH (EIP-1559).** La quema depende de la demanda de fees; post-Dencun los fees de rollups cayeron 10–100x y ETH volvió a inflacionar ~0,7–0,8%/año. **La quema era un % de fees cuya tasa el propio protocolo recortó.** [Decrypt](https://decrypt.co/229992/ethereum-not-sound-money-eth-fees-deflation)
- **Ethena fee switch.** Condicionado a mínimos; las fuentes no coinciden en si se activó en Q1-2026. Verificar antes de citar.

**Patrón:** los buybacks funcionan cuando (a) se pagan con revenue real y recurrente, (b) se ejecutan automáticamente por fórmula, (c) son grandes frente a unlocks y emisiones y (d) los tokens se **queman**, no se guardan. Messari: los buybacks solos no sostienen el precio; el crecimiento de revenue sí. [BeInCrypto](https://beincrypto.com/messari-token-buyback-programs-fail/)

## Modos de falla
- **Taxes de transferencia y reflections** (SafeMoon): rompen integraciones con DEX, CEX y bridges; fraude.
- **Quemas sin revenue**: reacomodan números, no agregan valor.
- **Buybacks mientras desbloquean VCs**: unlocks 10–20x más grandes que los buybacks (JUP).
- **Buybacks con principal de tesorería o deuda**: se cortan cuando se acaba la plata y dejan una señal negativa.
- **Espirales de muerte**: recompensas pagadas en el propio token → baja el precio → más venta.

## Seguridad sin emisiones
- La seguridad solo con fees es frágil en una L1 propia: los fees son ~0,69% del revenue de los mineros de BTC (ago-2026). [Cointelegraph](https://cointelegraph.com/markets/bitcoin-miners-earn-under-07-of-revenue-from-fees-in-new-10-year-low)
- **Pedir prestada la seguridad:** lanzar como ERC-20 (L2) o SPL. El token no necesita presupuesto de validadores.
- **Si hacen falta incentivos, usar un pool fijo creado en el génesis**, liberado con decaimiento; lo que sobra al final se quema. El supply total nunca crece.

## Normas de fair launch 2025–2026
- Sin ronda privada ni VC, o inversores al mismo precio y condiciones que el público.
- Airdrop retroactivo grande (~25–31%) a usuarios reales verificados, con filtro sybil y sin temporada de farming de puntos.
- Venta pública por LBP o estilo MetaDAO: precio fijo, mínimo o reembolso total, fondos en tesorería gobernada por mercado. [MetaDAO docs](https://docs.metadao.fi/)
- Liquidez bloqueada o quemada por contrato; mint y freeze authority renunciadas.
- Tokens del equipo con cliff, nada desbloqueado al lanzamiento, calendario público.

## Advertencias legales
- **EE.UU.:** la taxonomía de la SEC de mar-2026 tiene cinco clases; solo los "digital securities" son securities per se, pero el marketing y la distribución pueden crear exposición. El safe harbor del CLARITY Act pide ~4 años de operación y nadie con >20%. [Ballard Spahr](https://www.ballardspahr.com/insights/alerts-and-articles/2026/03/sec-and-cftc-clarify-when-digital-assets-are-and-are-not-securities)
- **Quemar es más seguro que pagar.** Buy-and-burn automático se parece menos a un dividendo que pagar stablecoins a stakers. Evitar lenguaje de "inversión" o "retornos".
- **Privacidad:** AMLR prohíbe a exchanges regulados soportar monedas con anonimato desde el 10-jul-2027; XMR ya fue deslistado de 73 exchanges. Privacidad opcional y en la app, no en el token. [Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/eu-ban-privacy-coins-anonymous-120215953.html)

→ Diseño final en [TOKENOMICS.md](../TOKENOMICS.md).
