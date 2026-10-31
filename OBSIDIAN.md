# The bot's brain in Obsidian, automatically

The bot writes its thinking as notes: one per trade, one per day, the DIP vs FCAT duel, its patterns and decisions, and a Home page. To have them show up in Obsidian on your phone by themselves, the bot uploads them to a **private GitHub repository** and Obsidian pulls them from there.

You set it up once, in about 10 minutes. After that it runs by itself: new notes reach GitHub within 5 minutes, and Obsidian fetches them whenever you open it.

## 1. GitHub: a private repository and a key for it

1. **Create the repository.** Go to github.com/new.
   - Repository name: `decu-brain`
   - **Private**
   - Create repository. Leave it empty; the bot fills it.
2. **Create the key.** In GitHub: Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Token name: `decu-brain`
   - Expiration: 1 year, or your choice
   - Repository access: **Only select repositories** → `decu-brain`
   - Permissions → Repository permissions → **Contents: Read and write**
   - Generate token, then copy it. GitHub shows it only once.

## 2. Render: give the bot the key

In Render → decu-copybot → **Environment**, add:

- `GITHUB_VAULT_TOKEN`: the token
- `GITHUB_VAULT_REPO`: `FutureMillionaire69420/decu-brain`

Save. **Never paste the token into a chat.**

The bot restarts and starts uploading within a minute:
- every note at once;
- the chart pictures, 30 every 5 minutes (GitHub's upload limits);
- after that, only what changes.

Dashboard → Brain shows "synced to GitHub … ago" and how many are still waiting.

## 3. Obsidian on your iPhone

1. **Make a vault.** Install Obsidian from the App Store, open it, and tap **Create new vault**.
   - Name: `Decu Brain`
   - Turn off "Store in iCloud"
   - Create.
2. **Install the Git plugin.** Settings (gear) → Community plugins → **Turn on community plugins** → Browse → search **Git** (by Vinzent) → Install → Enable.
3. **Sign the plugin in.** Settings → **Git**, under Community plugins:
   - Username: `FutureMillionaire69420`
   - Password / Personal access token: the same token, or a second one with Contents: **Read** only
4. **Download the notes.** Open the command palette (≡ menu → Command palette) and run **Git: Clone an existing remote repo**.
   - URL: `https://github.com/FutureMillionaire69420/decu-brain.git`
   - Directory: **Vault Root**
   - Depth: leave empty

   When it says it's done, close Obsidian and open it again.
5. **Make it automatic.** Settings → Git:
   - **Pull on startup**: on
   - **Auto pull interval (minutes)**: 5
   - Auto commit-and-sync interval: 0 (off). Turn it on only if you write your own notes in `human/` and want them on GitHub too.

Done. Open **Home**.

## Where things are

| Folder or note | What's in it |
|---|---|
| `Home` | where to start: the rank, the latest trades, links to everything |
| `machine/trades/` | one note per trade: what the bot thought, what happened, its charts |
| `machine/daily/` | one note per day |
| `machine/DIP vs FCAT/` | the duel: scoreboard, each brain, the holder experiment |
| `human/` | your own notes; the bot never writes here |

## Without GitHub

1. Dashboard → Brain → **Download whole brain**.
2. Unzip it in the Files app.
3. Move it into On My iPhone → Obsidian.

It works, but it doesn't update by itself.
