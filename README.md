# Expres Anna Karenina 🚂

Interaktivní kvíz ve stylu Kahootu k prezentaci o L. N. Tolstém a románu *Anna Karenina*.
Hostitel pustí hru na projektoru, spolužáci se připojí z mobilů přes PIN nebo QR kód.

## Co hra umí

- **Hostitel a mobily jako v Kahootu**: PIN, QR kód, odpočet, barevné odpovědi s tvary, body za rychlost a série správných odpovědí.
- **Šest typů otázek**: kvíz, pravda/lež, výběr více správných, seřazení událostí, odhad čísla na posuvníku a „Kdo jsem?“ s postupně odkrývanými nápovědami.
- **Závod vlaků**: místo obyčejné tabulky jedou hráči jako lokomotivy z Moskvy do Petrohradu.
- **Žolík „Expres ×2“**: každý hráč může jednou za hru zdvojnásobit body za otázku.
- **Reakce**: hráči posílají emoji, které letí přes plátno.
- **Zajímavost „Věděli jste?“** po každé otázce, stupně vítězů s konfetami, statistika nejtěžší otázky a export výsledků do CSV.
- **Trénink pro jednoho** (`/trenink`) funguje i bez dalších zařízení.
- **Test připojení** (`/test`) ukáže, jestli se na dané síti dá hrát.

## Jak hrát

1. Na počítači s projektorem otevři **hlavní adresu webu** s `/host` na konci (např. `https://prezentace-liv.vercel.app/host`) a klikni na **Otevřít nástupiště**.
2. Spolužáci na mobilu otevřou stejnou adresu (bez `/host`) a zadají PIN, nebo naskenují QR kód.
3. Vyber délku hry (celá jízda 12 otázek, nebo rychlík 3 otázky) a klikni **Vyjíždíme!**

Když se stránka hostitele omylem obnoví, nabídne **Obnovit rozehranou hru** a hráči se připojí sami.
Tlačítkem **Zamknout vstup** v lobby zabráníš tomu, aby se do hry připojoval někdo další (třeba falešní hráči).

## Nasazení na Vercel

1. Přihlas se na [vercel.com](https://vercel.com) přes GitHub, dej **Add New → Project**, vyber tento repozitář a klikni **Deploy**.
2. **Zapni spolehlivé spojení (databáze, zdarma, asi 2 minuty):**
   1. Ve Vercelu otevři projekt a nahoře klikni na záložku **Storage**.
   2. **Create Database** → vyber **Upstash for Redis** (případně „Redis“ od Upstash v Marketplace) → **Continue**.
   3. Region zvol **Frankfurt (eu-central-1)**, plán **Free**, pojmenuj ji třeba `kviz` → **Create**.
   4. V dalším kroku ji **připoj k projektu** (Connect Project) a nech zaškrtnutá všechna prostředí.
   5. Otevři záložku **Deployments**, u posledního nasazení dej **⋯ → Redeploy**. Proměnné databáze se načtou jen při novém nasazení.
3. Hotovo. Na `/test` by teď u „Server hry“ mělo být ✅ a v lobby hostitele štítek **spojení přes server**.

**Proč databáze?** Bez ní se telefony spojují s počítačem napřímo (WebRTC). To na školní Wi-Fi a mobilních datech
často nefunguje a telefon pak zůstane viset na „Připojuji se ke hře…“. S databází jde všechno přes server webu
jako obyčejné HTTPS, takže hra funguje všude, kde jde otevřít web.

**Kolik to stojí?** Nic. Bezplatný tarif Upstash má 500 000 příkazů měsíčně. Hra celé třídy (asi 30 mobilů,
10–15 minut) jich spotřebuje zhruba 20–40 tisíc, takže měsíčně vystačí asi na 15–20 her včetně zkoušek. Když se
limit vyčerpá, web to pozná a sám přepne na přímé spojení. Na `/test` pak uvidíš upozornění.

**Vercel hlásí přihlášení?** Používej hlavní adresu (`nazev-projektu.vercel.app`), ne dlouhou adresu konkrétního nasazení
(`nazev-abc123-tvuj-ucet.vercel.app`). Ty chrání Vercel přihlášením, takže by se na ně spolužáci nedostali. QR kód v lobby
proto vždy ukazuje na hlavní adresu. Případně vypni ochranu v **Settings → Deployment Protection → Vercel Authentication**.

## Když se mobil nepřipojí

1. Na mobilu otevři `/test` (odkaz je i na úvodní stránce). Ukáže, co funguje a co ne, a výsledek jde zkopírovat.
2. Zkontroluj, že hostitel má otevřenou stránku `/host` na počítači a nechal ji v popředí.
3. Bez databáze zkus dát mobil i počítač na stejnou Wi-Fi, nebo přepnout mezi Wi-Fi a mobilními daty. Spolehlivé řešení je databáze (viz výše).

## Úprava otázek

Otázky jsou v souboru [`src/data/questions.ts`](src/data/questions.ts). Další sadu přidáš jako nový objekt do pole `QUESTION_SETS`.
Jakmile je sad víc, v lobby se objeví výběr sady. Popis všech typů otázek je v [`src/game/types.ts`](src/game/types.ts).

## Jak to funguje

- Hru řídí stránka hostitele, ta počítá body i pořadí.
- **Se serverem (doporučeno):** telefony i hostitel si vyměňují zprávy přes Vercel Function [`api/relay.ts`](api/relay.ts). Ta je ukládá do Upstash Redis. Telefony se zhruba každou sekundu zeptají, co mají zobrazit.
- **Bez databáze:** přímé spojení přes WebRTC ([PeerJS](https://peerjs.com), bezplatný server PeerJS Cloud). Vlastní PeerJS server se dá nastavit proměnnými `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH` a `VITE_PEER_SECURE`.
- Podle odpovědi `GET /api/relay` web sám pozná, kterou cestu použít.

## Spuštění na vlastním počítači

```bash
npm install
npm run dev
```

Při `npm run dev` běží `/api/relay` přímo ve Vite a data drží v paměti. Databázi pro vývoj nepotřebuješ.
