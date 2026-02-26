# Task Manager

## 1. Vytvoření a inicializace

`TaskManager` se vytvoří s instancí `Config`. V konstruktoru se pro každý projekt z configu vytvoří:
- `WorkspacePool` — sada předklonovaných pracovních adresářů (workspaců)
- `TokenManager` — spravuje Claude OAuth tokeny
- `UsageLimiter` — volitelně hlídá počet spotřebovaných tokenů za hodinu

Po vytvoření je nutné zavolat `init()`, který zajistí obnovu po případném restartu serveru:
1. Rediscoveruje existující workspace adresáře z disku
2. Načte všechny persistované tasky z `TaskStore`
3. Tasky, které byly při posledním restartu `running`, označí jako `interrupted` a jejich output vymaže
4. Tasky ve stavu `retrying` vrátí do fronty jako `queued` (setTimeout byl ztracen restartem)
5. Přerušené tasky (`interrupted`) se pokusí znovu spustit na původním workspace
6. Pokud zbývá kapacita, spustí tasky z fronty

---

## 2. Vytvoření nového tasku — `startTask()`

Volající předá `projectId` a `{ prompt, pullRequestNumber?, callbackUrl? }`. Task manager:

1. Vytvoří `Task` objekt se statusem `queued` a uloží ho do `TaskStore` (persistence na disk)
2. Vrátí task **okamžitě** — volající nemusí čekat
3. V pozadí spustí `prepareAndRunTask()`, která:
   - Pro **PR task** (`pullRequestNumber` je vyplněn): stáhne z GitHubu název větve daného PR
   - Pro **normální task**: nechá Claude vygenerovat branch slug a title (např. `impl/add-login-button-xK3m9p`)
   - Výsledek uloží do tasku a zapíše na disk

---

## 3. Zařazení do fronty nebo spuštění

Po přípravě metadat `prepareAndRunTask()` rozhodne, co dál:

- **PR je právě aktivní** (jiný task pro stejné PR číslo běží) → task jde do fronty, čeká na uvolnění
- **Není volný workspace slot** nebo byl překročen globální limit → task jde do fronty
- **Kapacita je volná** → okamžitě se alokuje workspace a spustí se `executeTask()`

Fronta je FIFO per-projekt. Jakmile se uvolní workspace (task dokončí nebo selže), `tryDequeue()` vezme první task z fronty, jehož PR není aktivní, a spustí ho.

---

## 4. Průběh tasku — `executeTask()`

Toto je hlavní funkce, která řídí celý běh tasku:

**Krok 1 — příprava větve**
- Normální task: vytvoří novou větev od výchozí větve repozitáře (`prepareNewBranchAll`)
- PR task nebo retry: checkoutne existující větev (`checkoutBranchAll`)

**Krok 2 — push větve na remote**
Větev se okamžitě pushne, aby byla viditelná na GitHubu ještě před spuštěním Clauda.

**Krok 3 — spuštění Claude Code**
Claude Code se spustí v sandboxu (Docker kontejner). Dostane prompt obohacený o workspace rules (seznam repozitářů, instrukce k commitování atd.). Výstup se průběžně sbírá přes `Executor`.

**Krok 4 — uncommitted changes**
Pokud po dokončení existují necommitnuté změny, Claude dostane follow-up prompt, aby je commitoval.

**Krok 5 — revert protected paths**
Pokud jsou v configu definované `protectedPaths`, veškeré jejich změny (committnuté i necommittnuté) se revertují. Tím se vynucuje tvrdá hranice bez ohledu na to, co Claude udělal.

**Krok 6 — rebase**
Pokud task vytvořil commity, větev se rebasuje na aktuální výchozí větev. Pokud dojde ke konfliktům, Claude dostane další prompt a konflikty vyřeší.

**Krok 7 — výsledek**

| Situace | Co se stane |
|---|---|
| Úspěch + commity | force-push, vytvoří se PR (nebo se aktualizuje existující), do PR se přidá komentář s promptem |
| Úspěch + žádné commity (normální task) | vzdálená větev se smaže, `task.branch` se vynuluje |
| Úspěch + žádné commity (PR task) | větev zůstane, PR na GitHubu existuje dál |
| Chyba + commity | force-push, vytvoří se **draft PR** s částečnou prací |
| Chyba + žádné commity | vzdálená větev se smaže |

Na konci se vždy uvolní workspace slot a zavolá se `tryDequeue()` pro spuštění dalšího tasku z fronty.

---

## 5. Retry

Pokud task selhal (exit code ≠ 0) a v configu je nastaveno `errorRetry`:

1. Attempt counter se zvýší, status přejde na `retrying`
2. Po uplynutí `delaySeconds` se timer pokusí task znovu spustit — na **stejné větvi** (Claude vidí předchozí práci)
3. Pokud v tu chvíli není kapacita nebo PR je aktivní, task se vrátí do fronty jako `queued`
4. Pokud byl task po restartu serveru obnoven (`resumedFromRestart`), první retry se spustí **bez čekání** (delay = 0)

Po vyčerpání všech pokusů přejde task do `failed` a odešle se webhook (pokud je `callbackUrl` nastavena).

---

## 6. Zrušení tasku — `cancelTask()`

| Aktuální status | Co se stane |
|---|---|
| `queued` | Task se odstraní z fronty, status → `cancelled` |
| `retrying` | Čekající setTimeout se vymaže, status → `cancelled` |
| `running` | Nastaví se příznak `cancelled`, executor procesu se killne. `executeTask()` to detekuje ve finally bloku a nepřepíše status na `failed` |

---

## 7. Persistence

Každá změna stavu tasku se okamžitě zapíše na disk přes `TaskStore` (JSON soubory). Při restartu serveru se tasky obnoví z disku — žádná data se neztrácí.

---

## Soubory

| Soubor | Co obsahuje |
|---|---|
| `task-manager.ts` | Třída `TaskManager` — veřejné API, fronta, state |
| `task-runner.ts` | `executeTask`, `scheduleRetry`, `prepareAndRunTask` |
| `utils.ts` | Čisté pomocné funkce — prompt building, Docker mount, webhook |
| `types.ts` | Interní rozhraní — `ProjectState`, `TaskEntry` |
| `errors.ts` | Doménové chyby — `TaskActiveError`, `TaskCancelError`, `TaskEditError` |
