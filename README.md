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
- Zvuky a hudba se generují přímo v prohlížeči, hra se ovládá i mezerníkem, šipkou nebo prezentačním klikátkem.

## Jak hrát

1. Na počítači s projektorem otevři web a klikni na **Spustit hru na projektoru** (adresa `/host`).
2. Spolužáci na mobilu otevřou stejnou adresu a zadají PIN, nebo naskenují QR kód.
3. Vyber délku hry (celá jízda 12 otázek, nebo rychlík 3 otázky) a klikni **Vyjíždíme!**

Když se stránka hostitele omylem obnoví, nabídne **Obnovit rozehranou hru** a hráči se připojí sami.

## Nasazení na Vercel

1. Přihlas se na [vercel.com](https://vercel.com) přes GitHub.
2. **Add New → Project** a vyber tento repozitář.
3. Nic neměň (Vercel sám pozná Vite) a klikni **Deploy**.

Za chvíli dostaneš adresu typu `nazev.vercel.app`. Tu pak napíšeš spolužákům, případně ji ukáže lobby sama.

## Úprava otázek

Otázky jsou v souboru [`src/data/questions.ts`](src/data/questions.ts). Další sadu přidáš jako nový objekt do pole `QUESTION_SETS`.
Jakmile je sad víc, v lobby se objeví výběr sady. Popis všech typů otázek je v [`src/game/types.ts`](src/game/types.ts).

## Jak to funguje

Web nemá vlastní server. Mobily se s počítačem hostitele spojí napřímo přes WebRTC (knihovna [PeerJS](https://peerjs.com)).
K „seznámení“ zařízení se používá bezplatný server PeerJS Cloud.
Pokud by školní síť WebRTC blokovala, dá se nastavit vlastní PeerJS server přes proměnné prostředí
`VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH` a `VITE_PEER_SECURE`.

## Spuštění na vlastním počítači

```bash
npm install
npm run dev
```
