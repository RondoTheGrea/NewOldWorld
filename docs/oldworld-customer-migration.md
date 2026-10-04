# Moving the customer list from OldWorld to NewOldWorld

A step-by-step guide. Only **customer profiles** move: name, store name, phone
number, schedule and address. Receipts, inventory and everything else stay in
OldWorld.

The customers come from a **CSV file you export from OldWorld's Appwrite
console**. The script reads that file and adds the customers to NewOldWorld.

There are three parts:

- **Part A: practise.** You can do this now, with the CSV you already have.
- **Part B: collect every phone's customers and export a fresh CSV.** Do this
  when the phones come back from their trip.
- **Part C: the real move.** Do this right after Part B.

Every command below goes in **PowerShell**. Where it says "in the `firebase`
folder", first run:

```powershell
cd C:\Users\ronal\Desktop\NewOldWorld\firebase
```

---

## What the script does, in plain words

1. It **reads the CSV** in the `NewOldWorld` folder, using the newest
   `customersCollectionId_….csv` there. The **first row is the column names**
   (`$id, $permissions, …, name, storeName, …`) and is never treated as a
   customer. The script checks that row has the columns it needs and refuses to
   run if it doesn't, so a wrong file can't slip through.
2. It **merges duplicates.** Two records count as the same customer only when
   **both** the name **and** the store name match. Capital letters and extra
   spaces are ignored, and nothing else is:
   - `Maria Santos / Santos Store` and `maria  santos / SANTOS STORE` → **same** customer, merged
   - `Maria Santos / Santos Store` and `Maria Santos / Santos Store 2` → **different** customers
   - `Maria Santos / Santos Store` and `Maria Santos / Santos Store (Main)` → **different** customers
   - `Maria Santos / Santos Store` and `Maria Santos / Santos Sari-Sari` → **different** customers

   When records are merged, the **most recently updated** one is kept. If that
   one left the phone, schedule or address blank, the blank is filled from the
   older duplicate.
3. It **skips** any customer NewOldWorld already has, whether it was moved in an
   earlier run or someone typed it into a NewOldWorld phone. **Running it twice
   is safe**: the second run adds nothing.
4. It writes **a report you can open in Excel** before anything is saved.

**Without `--write` at the end of the command, nothing is saved anywhere.** That
is the "preview". Always preview first.

The CSV from 2026-10-04 has **428 customers**, with **3 pairs of duplicates**,
so it becomes **425 stores**. **This was migrated on 2026-10-04:** all 425 are in
`newoldworld-b8f5d`. Running the script again adds nothing unless a newer CSV
has customers that aren't there yet.

> **App Check:** nothing to do. The script uses Firebase's admin access, which
> App Check doesn't apply to. That stays true after you turn enforcement on.

> **Privacy:** the CSV and the reports hold real customers' names and phone
> numbers. Both are excluded from git, so they are never uploaded with the code.
> Delete them when you're done (Step 10).

---

## Part A: practise (do this now)

This uses the **local test server (the emulators)**, so the real NewOldWorld
isn't touched.

### Step 1. Check the CSV is in place

The file `customersCollectionId_….csv` should be directly inside
`C:\Users\ronal\Desktop\NewOldWorld\`. It's already there.

**Don't open and re-save it in Excel.** Excel can change the quoting and break
the file. Opening it to look is fine; just close it without saving.

### Step 2. Preview on your computer

1. In **PowerShell window 1**, in the `firebase` folder:
   ```powershell
   npm run emulators
   ```
   Leave it running.
2. In **PowerShell window 2**, in the `firebase` folder:
   ```powershell
   npm run migrate:oldworld
   ```
3. It prints a summary: how many customers it read, how many duplicates it
   merged, and how many stores it would add. It also says where it saved the
   reports, in `NewOldWorld\firebase\migration-output\`:
   - **`migration-report-…-preview.csv`**: one row per store, with what would
     happen to it (`ADD` or `SKIP`) and why (Notes column).
   - **`duplicates-…csv`**: every pair or group that would be merged, showing
     which record is kept.
4. Open them in Excel and look through them.

If you see something wrong, such as two records that are clearly the same shop
but spelled differently, write it down. You can fix it on a NewOldWorld phone
after the move (open the store → Edit, or Delete).

### Step 3 (optional). Practise the real write on your computer

```powershell
npm run migrate:oldworld -- --write
```

The stores go into your **local test data only**, and you can look at them in
the dashboard or the app running against the emulators. Your emulator keeps
this data between restarts. To clear it later, stop the emulators (Ctrl+C) and
start them with `npm run emulators:fresh`. Note that this also clears your
other test data.

---

## Part B: when the phones are back

OldWorld keeps customers **on each phone** and only sends them to the server
when someone taps "Upload to Server". The CSV only contains what's on the
server, so a customer that was never uploaded isn't in it.

### Step 4. Upload from every OldWorld phone

On **each** OldWorld phone, one at a time:

1. Make sure it has internet and is signed in.
2. Open the **Customers** tab.
3. Tap the **sync** button, then **📤 Upload to Server**, then **Continue**.
4. Wait for the "complete" message before moving to the next phone.

Do **every** phone, even ones you think already uploaded. Any duplicates this
creates are fine, because the script merges them.

From now until Part C is done, don't add or edit customers in OldWorld.

### Step 5. Export a fresh CSV

The CSV you have now is from **before** the phones uploaded, so export again:

1. Appwrite console → OldWorld project → **Databases** → the database →
   **customers** collection → **Export** to CSV, the same way you did before.
2. Put the new file in `C:\Users\ronal\Desktop\NewOldWorld\`. Leaving the old
   one there is fine: the script always picks the **newest**
   `customersCollectionId_….csv`. The first lines it prints show which file it
   read.

---

## Part C: the real move (right after Part B)

### Step 6. Sign in to Google for the real project

The script uses the same login as `npm run deploy`. If you've deployed from
this computer, you're already signed in. To check, in the `firebase` folder:

```powershell
npx firebase login:list
```

It should say `Logged in as` followed by the Google account that owns the
NewOldWorld Firebase project. If not, run `npx firebase login`.

(If the Google Cloud CLI is installed and `gcloud auth application-default
login` has been run, the script uses that instead. Either works.)

### Step 7. Preview against the real NewOldWorld

```powershell
npm run migrate:oldworld:cloud
```

This still **saves nothing**. Check that:

- It says it read the **new** CSV (the file name in the first lines).
- The **"stores to add"** number looks right.
- The **duplicates file** merged only records that really are the same shop.
- Rows marked **`SKIP — already in NewOldWorld`** are shops someone already
  added to NewOldWorld. Those are kept as they are, not replaced.

### Step 8. Do it

```powershell
npm run migrate:oldworld:cloud -- --write
```

(The `--` before `--write` is needed.) When it finishes it prints
`✓ … stores added`. If it stops partway (bad internet), run the same command
again. It skips what already went in and adds the rest.

### Step 9. Check it worked

- Open the NewOldWorld **dashboard → Stores** tab. The stores should be listed
  with their Schedule.
- Each NewOldWorld phone gets the stores at its **next truck setup**: "Stores"
  ticks off in the download list. The phones need the app version with the new
  customer form (Name, Store Name, Phone Number, Schedule, Address) to show the
  Schedule.
- Fix anything you noted in Step 2 on a phone (Customers tab → tap the store →
  **Edit** or **Delete**).

### Step 10. Clean up

Delete these, or move them somewhere private as a backup. They contain real
customers' details:

- every `customersCollectionId_….csv` in `NewOldWorld\`
- the `NewOldWorld\firebase\migration-output\` folder

Done.

---

## If something goes wrong

| What you see | What it means / what to do |
| --- | --- |
| `No customersCollectionId_*.csv found` | The CSV isn't directly inside the `NewOldWorld` folder, or it was renamed. Move it there, or add `-- --file=C:\path\to\the.csv` to the command. |
| `The first row of the CSV should be the column names, and these are missing: …` | Wrong file (not the **customers** collection), or it was re-saved by a program that changed the columns. Export it again. |
| `…row(s) have a different number of cells than the header` | The file was damaged or re-saved (often by Excel). Export it again and don't re-save it. |
| `Could not read Firestore` (on your computer) | The emulators aren't running. Start them in another window (Step 2). |
| `Not signed in to Google` or `Could not read Firestore` (`:cloud`) | Redo Step 6 with the Google account that owns the Firebase project. |
| `stores to add: 0` on the real run | Already moved, or every shop already exists in NewOldWorld. Check the Result column in the report. |
| A shop is missing after the move | Its phone probably never uploaded. Upload from that phone (Step 4), export again (Step 5), and run Step 8 again. Only the missing shops are added. |
