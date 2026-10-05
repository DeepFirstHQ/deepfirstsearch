# 01 · Dolores reales del mercado (privacidad × IA × crypto)

> Investigación web, octubre 2026. Las fuentes más sólidas: Chainalysis, Coin Metrics, a16z, expedientes judiciales,
> 10-Q de la SEC y papers de arXiv. Algunas cifras vienen de blogs de vendors o agregadores (marcadas como *direccionales*).
> No se pudieron leer hilos individuales de Reddit/HN/X; la evidencia viene de fuentes que los citan o resumen.

## 1. La visibilidad on-chain se convierte en peligro físico (wrench attacks)
Los balances públicos, sumados a datos KYC filtrados, permiten elegir víctimas. Francia es el epicentro.
- Chainalysis: 46 ataques violentos en S1 2026, más de $30M robados; 2025 fue récord anual con $58M. [Cointelegraph](https://cointelegraph.com/news/crypto-wrench-attacks-steal-30-million-2026)
- CertiK: 72 ataques en 2025, +75% interanual. [crypto.news](https://crypto.news/france-hit-by-40-crypto-kidnappings-as-wrench-attacks-surge/)
- Policía francesa: 67 incidentes en 2025 y 47 en 2026; 88 imputados. [Yahoo](https://www.yahoo.com/news/articles/france-charges-88-including-minors-112644558.html)
- Filtración interna en Coinbase: nombres, domicilios y fotos de DNI de 69.461 clientes. [BankInfoSecurity](https://www.bankinfosecurity.com/bribery-led-coinbase-hack-affects-70000-crypto-customers-a-28465), [SEC 10-Q](https://www.sec.gov/Archives/edgar/data/1679788/000167978825000208/coin-20250930.htm)

**Por qué fallan las soluciones actuales:** multisig y timelocks protegen las llaves, no la visibilidad. Nadie desvincula identidad de balance.

## 2. Address poisoning
- 270M intentos contra 17M víctimas, más de $83,8M perdidos confirmados. [arXiv](https://arxiv.org/pdf/2501.16681v3)
- Una pérdida de ~$50M en USDT. [The Block](https://www.theblock.co/post/383423/crypto-trader-loses-50-million-in-address-poisoning-attack-offers-1-million-bounty-for-return)
- Más del 10% de los drenajes de wallets de 2025, mayormente USDT/USDC. [Webacy](https://webacy-world.ghost.io/from-the-ctos-desk-september-2025/)

**Causa raíz:** historiales públicos + copiar/pegar direcciones.

## 3. Pagos, payroll y tesorería en stablecoins son 100% públicos
- Más de $33T en volumen de stablecoins en 2025, pero <1% de empresas hace payroll en crypto; los salarios expuestos son el bloqueo citado. [BusinessWire](https://www.businesswire.com/news/home/20260129619369/en/Aleo-Toku-and-Paxos-Labs-Launch-First-Private-Stablecoin-Payroll-Solution-Removing-the-Final-Barrier-to-Enterprise-Stablecoin-Adoption)
- Intentos: Aleo+Toku+Paxos, Circle Arc Privacy (solo oculta montos, usa TEEs) [crypto.news](https://crypto.news/circle-unveils-arc-privacy-to-bring-confidential-smart-contracts-to-institutions/), Railgun.

**Por qué fallan:** cada uno es su propia chain o token (liquidez fragmentada); ocultar montos sin ocultar el grafo sigue filtrando quién le paga a quién.

## 4. Delistings y regulación expulsan a las privacy coins
- 73 delistings de XMR en 2025; Binance (feb-2024) y Kraken EEA (oct-2024). [Decrypt](https://decrypt.co/284276/monero-kraken-delisting-xmr-european)
- **EU AMLR art. 79:** desde el 10-jul-2027 los proveedores regulados no pueden ofrecer monedas o cuentas con anonimato. La autocustodia sigue siendo legal. [CVJ](https://cryptovalleyjournal.com/focus/legal-and-compliance/eu-plans-to-ban-privacy-coins-in-2027/)
- Roman Storm (Tornado Cash) condenado por transmisión de dinero sin licencia; retrial abril 2027. Samourai: 5 años al dev. [DL News](https://www.dlnews.com/articles/defi/samourai-dev-gets-max-sentence-for-money-transmission-charge/)
- **Pero la demanda crece:** el supply blindado de ZEC pasó de ~11% a ~30%. [Coin Metrics](https://coinmetrics.substack.com/p/state-of-the-network-issue-338); a16z reporta pico de búsquedas "crypto privacy". [a16z](https://www.a16z.news/p/state-of-crypto-2025)

## 5. La privacidad en EVM es dolorosa de usar
Quejas de Vitalik: seed phrases extra, sin multisig en pools blindados, relayers poco confiables, flujos que "empujan de vuelta a los CEX". [TradingView/Cointelegraph](https://www.tradingview.com/news/cointelegraph:26954e03d094b:0-why-kohaku-is-central-to-ethereum-s-2025-privacy-shift/)
El SDK Kohaku de la EF sigue en alpha (mayo 2026). [DEXTools](https://www.dextools.io/news/ethereum-foundation-kohaku-sdk-privacy-wallets-2026)
Estudio de 85 extensiones de wallet: filtran direcciones y permiten tracking entre sitios. [The Hacker News](https://thehackernews.com/2026/07/study-of-85-crypto-wallet-extensions.html)

## 6. Los prompts a la IA filtran datos
- 77% de empleados pega datos en GenAI; 82% vía cuentas no gestionadas; 22% incluye tarjetas o identidad (LayerX). [eSecurityPlanet](https://www.esecurityplanet.com/news/shadow-ai-chatgpt-dlp/)
- Caso NYT: un tribunal obligó a OpenAI a conservar chats borrados y luego a entregar 20M logs. [eWeek](https://www.eweek.com/news/openai-chatgpt-logs-new-york-times-copyright-mdl/)
- r/LocalLLaMA: la privacidad es la razón #1 para correr modelos locales (*direccional*).
- IDC: 75% de organizaciones adopta confidential computing, solo 18% en producción. [IDC/CCC](https://confidentialcomputing.io/wp-content/uploads/sites/10/2025/11/US53866125.pdf)

**Por qué fallan:** modelos locales más débiles; opciones crypto con token especulativo; sin attestation verificable por el usuario; pagar con tarjeta ata los prompts a la identidad.

## 7. Las wallets de agentes IA se drenan
- Wallet vinculada a Grok drenada por prompt injection (~$150K según [Giskard](https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet); otras fuentes reportan montos mayores y un segundo ataque en mayo 2026).
- Ledger habla de la "trifecta letal": prompt injection + ejecución autónoma + fondos reales.
- Ataques documentados sobre x402 y AP2. [arXiv 2605.11781](https://arxiv.org/html/2605.11781v1)

**Gap:** no hay un "agent safe" estándar con intent binding criptográfico.

## 8. Los pagos de agentes (x402) son públicos y filtran estrategia ← **núcleo de Deep First Search**
- x402: ~165M transacciones, ~$50M, 69K agentes; Visa, Mastercard y Ripple se sumaron. [CoinDesk](https://www.coindesk.com/tech/2026/07/15/visa-mastercard-and-ripple-join-the-standard-letting-ai-agents-pay-in-stablecoins), [Chainalysis](https://www.chainalysis.com/blog/x402-agentic-payments-adoption/)
- Ojo: parte del volumen de fines de 2025 fue actividad de memecoins, no agentes comprando servicios (Chainalysis).
- Cada pago expone pagador, proveedor, monto y timing; `resource_url`, `description` y `reason` viajan en texto plano. [arXiv 2604.11430](https://arxiv.org/html/2604.11430v2)
- Único competidor: x402z (Mind Network) oculta solo montos vía FHE. [bex.co](https://bex.co/blog/2026/08/29/mind-network-x402z-private-agent-payments) (*direccional*)

## 9. Identidad de agentes, proof of personhood y fatiga de tokens IA
- ERC-8004 (enero 2026): adopción "registration-heavy but operationally shallow", reputación fácil de manipular. [arXiv 2606.26028](https://arxiv.org/pdf/2606.26028)
- El Orb de World está prohibido o investigado en varios países. [Wikipedia](https://en.wikipedia.org/wiki/World_(blockchain))
- Tokens de agentes (ARC, AI16Z, VIRTUAL) cayeron 75–90%. [TradingView](https://www.tradingview.com/news/cointelegraph:8cbeab9a2094b:0-ai-tokens-down-up-to-90-from-2024-highs/)
- 84,7% de los TGE de 2025 cotiza bajo su FDV de lanzamiento; drawdown mediano 71% (Memento). [BingX](https://bingx.com/en/news/post/-token-launches-see-trade-below-fdv-as-high-valuation-tges-leave-retail-buyers-trapped)
- Bittensor: un subnet grande recibe ~$52M/año en emisiones contra ~$2,4M de revenue externo. [yellow.com](https://yellow.com/research/bittensor-decentralized-ai-market-control-2026) (*direccional*)

**Lección:** los usuarios desconfían de todo proyecto que lanza token primero. Hace falta revenue antes del token.

---

## Ranking de oportunidades

| # | Oportunidad | Por qué | Riesgo principal |
|---|---|---|---|
| **1** | **Rieles privados para pagos x402** | El riel nuevo de más crecimiento, respaldado por Coinbase/Cloudflare/Visa; su falla #1 documentada es la vinculabilidad; el competidor solo oculta montos | Clasificación como money transmitter → diseño no custodial + association sets |
| 2 | Capa de seguridad/políticas para wallets de agentes | Pérdidas reales y repetidas; cada framework lo reinventa | Commoditización |
| 3 | Wallet privada por defecto vendida como seguridad personal | Wrench attacks récord, poisoning de $50M | Distribución, UX |
| 4 | Inferencia IA privada, verificable y pagada en crypto | 77% pega datos; caso NYT; Venice prueba demanda (1M+ usuarios) | Acceso a capacidad GPU-TEE |
| 5 | Proof of personhood ZK sin biometría | Orb prohibido, EU AI Act, ERC-8004 manipulable | Cold start |

**Decisión:** Deep First Search combina 1 + 2 + 4 en un solo SDK. Ver [WHITEPAPER](../WHITEPAPER.md).

**Reglas de diseño que salen de las quejas:**
1. Producto y revenue antes del token.
2. No custodial (no ser money transmitter).
3. Divulgación selectiva (view keys) para sobrevivir AMLR y el escrutinio de EE.UU.
4. Integrarse a wallets, x402 y USDC existentes en vez de lanzar una L1 nueva.
