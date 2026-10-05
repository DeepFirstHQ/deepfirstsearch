# 03 · Por qué fracasaron: qué NO hacer

> Investigación web, octubre 2026. Precios y drawdowns a la fecha de cada fuente.
> Sin buena fuente actual (verificar antes de citar): Incognito, Beam, Dusk, Firo, Story.

## Casos

### Privacidad: fracasos legales y de listado
- **Tornado Cash.** Sancionado por OFAC en 2022; en *Van Loon* (nov-2024) el Quinto Circuito dijo que los contratos inmutables no son "propiedad" bloqueable y el Tesoro lo deslistó en mar-2025. **Igual** Roman Storm fue condenado (ago-2025) por conspiración para operar un transmisor de dinero sin licencia; retrial en abril 2027. **Que el código no sea responsable no protege a los devs.** [Forbes](https://www.forbes.com/sites/digital-assets/2025/03/24/tornado-cash-sanctions-lifted-in-major-policy-shift/), [CoinDesk](https://www.coindesk.com/policy/2025/08/06/roman-storm-guilty-of-unlicensed-money-transmitting-conspiracy-in-partial-verdict)
- **Samourai Wallet.** Ambos fundadores se declararon culpables (§1960): 5 y 4 años, $237M decomisados. La fiscalía se apoyó en que el equipo **operaba la infraestructura del coordinador, cobraba fees y lo promocionaba para evadir**. [CoinDesk](https://www.coindesk.com/policy/2025/11/06/samourai-wallet-developer-sentenced-to-5-years-in-prison-for-unlicensed-money-transmitting)
- **Delistings de privacy coins.** Binance (XMR, 2024), Kraken EEA, OKX (XMR, ZEC, DASH). **AMLR UE desde el 10-jul-2027.** Dubái prohíbe; Corea y Japón lo hacen prácticamente imposible. **Un token privado por defecto no se puede listar.** [thirdweb](https://blog.thirdweb.com/eu-privacy-coin-ban-2027-what-the-amlr-means-for-web3-builders/)

### Privacidad: fracasos técnicos
- **Secret Network (SCRT).** Privacidad apoyada en Intel SGX. Investigadores de [SGX.Fail](https://sgx.fail/) extrajeron la **consensus seed**, una llave maestra que descifra todo el estado desde el génesis. >95% bajo su ATH. **Una sola llave + un solo vendor de hardware = un bug expone todo.** [Blockworks](https://blockworks.com/news/secret-network-crypto-transactions-not-so-secret-after-all)
- **Oasis (ROSE).** TEE/SGX, ~99% bajo ATH. Tecnología funcionando, sin producto del lado de la demanda.
- **Haven Protocol (XHV).** Tres exploits mintearon ~9M xUSD falsos; **como los montos eran ocultos, no se podía auditar cuánto se había minteado**. Rollback, −50%, desaparición. [Haven](https://havenprotocol.medium.com/haven-protocol-technical-overview-of-june-2021-exploits-6f4573fbf216)
- **Grin.** El fair launch más puro (sin premine, emisión lineal infinita, sin tesorería). Nadie financiado para BD, marketing o listings. Se apagó. **El fair launch solo no crea demanda.** [cryptonews](https://cryptonews.net/news/altcoins/322947/)
- **Aleo.** $228M de a16z, SoftBank, Coinbase Ventures. De $5,19 a ~$0,10. **Una ronda VC enorme fija un FDV que solo se "llena" con emisiones y unlocks.** [Messari](https://messari.io/report/state-of-aleo-q1-2025)
- **Manta.** DDoS el día del TGE (135M requests), claims fallidos. −98,5% desde ATH. [CoinGape](https://coingape.com/manta-network-suffers-ddos-attack-on-token-launch-day/)

### IA
- **ASI (FET/AGIX/OCEAN).** La fusión se rompió; Fetch acusa a Ocean de vender ~263M FET (>10% del circulante) y la demanda por fraude. FET −93%. **Las fusiones crean tesorerías grandes que se pueden dumpear.** [Bitget](https://www.bitget.com/news/detail/12560605052994)
- **Tokens de agentes IA.** VIRTUAL, ai16z, ARC −75–90%, engagement −60%. Narrativa sin revenue. [The Block](https://www.theblock.co/post/334213/ai-agent-tokens-reel-from-a-steep-market-correction)
- **Worldcoin (WLD).** ~1,4% de float al lanzamiento, FDV enorme, unlocks constantes; −97%. La Foundation vendió $65M en mínimos. Controversia biométrica en varios países. [CoinCentral](https://coincentral.com/worldcoin-wld-price-world-foundation-sells-65m-in-tokens-as-wld-hits-all-time-low/)

### Generales
- **Mantra (OM).** De $6 a <$0,50 en una hora ($5,5B). Equipo con ~90% del supply, **888M tokens minteados en silencio**. [Forbes](https://www.forbes.com/sites/aliceliu/2025/04/14/mantras-54-billion-crash-how-supply-control-led-to-disaster/)
- **Movement (MOVE).** Deal secreto con market maker dumpeó 66M MOVE (~5%) al día siguiente del listing. Delisting en Coinbase, cofundador despedido, Chapter 11 en jul-2026. [CoinDesk](https://www.coindesk.com/markets/2025/05/02/movement-labs-suspends-rushi-manche-after-coinbase-delists-move-token)
- **Nillion.** Un market maker dumpeó sin autorización: −50% en una hora. [Invezz](https://invezz.com/news/2025/11/20/nillion-nil-crashes-50-after-unauthorized-market-maker-dump/)
- **Berachain.** Side letter secreta con derecho de reembolso de $25M para el inversor líder. [Unchained](https://unchainedcrypto.com/berachain-documents-show-brevan-howard-offered-25-million-refund-right/)
- **Blast.** L2 de puntos y airdrops; TVL de $2B a $32M; anunció cierre en oct-2026. [Crypto Times](https://www.cryptotimes.io/2026/10/03/blast-token-price-crashes-over-44-after-blast-announces-ethereum-layer-2-shutdown/)
- **Friend.tech.** Fees de especulación, no de uso. −98%; los fundadores se quedaron con $44M. [DL News](https://www.dlnews.com/articles/defi/friend-tech-shuts-down-after-revenue-and-users-plummet/)
- **ZKsync y Starknet.** Airdrops sin filtro sybil; STRK −91% y cuentas activas de 380k a 8,3k. [Crypto Briefing](https://cryptobriefing.com/zksync-airdrop-controversy-exposed/)
- **Pi Network.** "47M usuarios" inflados, supply poco claro. De $2,98 a <$0,08.
- **SafeMoon.** Token "deflacionario" con tax de transferencia; el CEO sacó fondos de la liquidez "bloqueada": 100 meses de prisión. [CoinMarketCap](https://coinmarketcap.com/academy/article/safemoon-ceo-gets-8-years-in-prison-for-investor-fraud)
- **Terra/LUNA y Celsius.** Yield pagado con dinero nuevo; ~$50B evaporados en 3 días. 15 y 12 años de prisión.

## Patrones de fracaso, rankeados

1. **Float bajo + FDV alto + cliffs de unlock** (WLD, Aleo, STRK, ZK, MANTA, BERA).
2. **Deals ocultos con insiders y abuso de market makers** (Movement, Berachain, Nillion, OM).
3. **Supply concentrado y minteo opaco** (OM, Pi, tesorería FET).
4. **Responsabilidad de operador en privacidad** (Samourai, Tornado).
5. **Privacidad por defecto en el token → delisting** (XMR, ZEC en algunos CEX, AMLR 2027).
6. **Punto único de confianza** (SCRT/Oasis en SGX, supply invisible de Haven).
7. **Narrativa sin revenue** (tokens de agentes, Friend.tech, Blast).
8. **Airdrops farmeados** (ZKsync, Starknet, Blast, Manta).
9. **Yield fraudulento y "deflación" de marketing** (Terra, Celsius, SafeMoon).
10. **Falla técnica el día del lanzamiento** (Manta).
11. **Gobernanza rota tras fusiones** (ASI/Ocean).
12. **Purismo sin presupuesto** (Grin).

## Anti-checklist para Deep First Search

**Legal**
- [ ] No operar infraestructura custodial, coordinadores, relayers ni cobrar por mezclar.
- [ ] Contratos núcleo inmutables (protegen a los contratos, **no** a los devs).
- [ ] Nunca promocionar para evadir sanciones: prohibido "untraceable", "can't be seized".
- [ ] View keys, divulgación selectiva y association sets desde el día 1.
- [ ] Opinión legal escrita sobre §1960/FinCEN y MiCA/AMLR **antes** de mainnet.
- [ ] Fundación fuera de EE.UU.; frontends separados; screening de direcciones OFAC en la UI.

**Listings**
- [ ] Token **transparente**; privacidad en la capa de aplicación.
- [ ] Publicar todo contrato con market makers (o no tenerlos).

**Tokenomics**
- [ ] Nada de float <15% con FDV 10x+. Vesting lineal, insiders bloqueados ≥12 meses.
- [ ] Sin side letters ni condiciones especiales. Cap table publicado por categoría.
- [ ] Mint authority renunciada: imposible mintear (OM).
- [ ] Sin yield financiado con emisiones; quema solo con revenue real (no SafeMoon).
- [ ] Tesorería financiada y transparente (no Grin).

**Lanzamiento**
- [ ] Filtro sybil, criterios ponderados por uso, reglas publicadas.
- [ ] Load test de RPC y claim contracts contra DDoS.
- [ ] No lanzar con FDV de $1B+ siendo un demo.

**Seguridad**
- [ ] Sin secreto maestro único; threshold/MPC, rotación, forward secrecy.
- [ ] TEEs solo como defensa en profundidad.
- [ ] Supply total demostrable on-chain aunque los montos sean privados (Haven).
- [ ] 2+ auditorías, bug bounty, rate limits y circuit breakers.

**IA**
- [ ] El token tiene que ser necesario para algo real y con revenue demostrable.
- [ ] Nada de estructuras de fusión con tesorerías sueltas.

**Comunicación**
- [ ] Dashboard mensual de supply, wallets del equipo, unlocks y tesorería.
- [ ] Reportar usuarios activos on-chain, nunca cifras infladas.
- [ ] Respuesta a incidentes en horas, con direcciones verificables.
