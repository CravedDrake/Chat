# Nook — temporary private chat rooms

A vanilla HTML/CSS/JS chat app. Rooms, messages, presence, and reactions run
on Firebase Realtime Database + Anonymous Auth; images and videos are
uploaded to your own local Node/Express server (`server.js`) instead of
Firebase Storage.

```
/chat-app
├── index.html            landing page (create / join room)
├── room.html              the chat room itself
├── database.rules.json    Realtime Database security rules
├── functions/index.js     Cloud Function for trusted room expiry cleanup
├── css/
│   ├── style.css          tokens, buttons, modals, toasts, landing page
│   └── room.css           chat-specific layout
└── js/
    ├── firebase.js        Firebase config + media server URL + limits
    ├── utils.js            shared helpers (sanitizing, toasts, ids, emoji)
    ├── app.js              landing page logic (createRoom / joinRoom lookup)
    └── room.js              the chat room application
```

---

## 1. Create the Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project**.
2. Give it a name, disable Google Analytics if you don't need it, and create the project.

## 2. Register a Web app

1. In the project overview, click the **</>** (web) icon to add a web app.
2. Give it a nickname — you don't need Firebase Hosting for this step.
3. Firebase shows you a `firebaseConfig` object with `apiKey`, `authDomain`, etc.

## 3. Enable Anonymous Authentication

The app identifies people without making them create accounts, using
**Firebase Anonymous Authentication**: on first visit, the browser silently
signs in and gets a stable `auth.uid` for that session. This `uid` is what
the security rules use to check "is this person actually in this room?"
before letting them read or write anything.

1. In the console: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Anonymous**.

## 4. Create the Realtime Database

1. **Build → Realtime Database → Create Database**.
2. Choose a location close to your users.
3. Start in **locked mode** — you'll paste real rules in step 6.

## 5. Confirm your Firebase config

`js/firebase.js` should already have your project's values filled in
(`apiKey`, `authDomain`, `databaseURL`, `projectId`, etc.). Double-check
`databaseURL` matches what's shown at the top of **Realtime Database → Data**
in the console — it varies by region (e.g. `...-default-rtdb.asia-southeast1.firebasedatabase.app`).

### Optional: GIF support

Also in `js/firebase.js`:

```javascript
export const GIF_API_KEY = "";      // paste a GIPHY or Tenor key here
export const GIF_PROVIDER = "giphy"; // or "tenor"
```

Get a free key at [developers.giphy.com](https://developers.giphy.com) or
[tenor.com/developer](https://tenor.com/developer). Leave it blank and the GIF
picker shows a friendly "not configured" message instead of breaking.

## 6. Add the Realtime Database security rules

Console → **Realtime Database → Rules** → paste the contents of
`database.rules.json` → **Publish**.

These rules:
- Require anonymous auth for all reads/writes.
- Only let a member write to their own member record.
- Only let a message's own sender write/delete that message.
- Only let a user write their own reaction.
- Cap message length/type at the rules layer, as a backstop behind the
  client-side checks in `js/firebase.js`.

**Treat this as a starting point, not a finished product** — review it
against your own threat model before a public deployment.

## 7. Run your media server

Start `server.js` (the Express + Multer server you already have):

```bash
node server.js
# TempChat media server running on http://localhost:3000
```

It exposes:
- `POST /api/upload` — multipart form (`file`, `roomId`) → `{ success, url }`
- `DELETE /api/room/:roomId` — deletes that room's media folder
- `GET /media/...` — serves the uploaded files statically

`room.js` is wired to this exact contract already, and calls the delete route
automatically whenever a room is torn down (last member leaves, or expiry).

**Reachability matters.** `localhost:3000` only resolves on the machine
running `server.js`. If a friend joins your room from a different computer,
their browser tries to load media from *their own* `localhost:3000` — which
doesn't exist there — so images/video will fail to load for them even though
the chat itself (via Firebase) works fine. To fix that:

- Run `server.js` somewhere reachable by everyone (a small VPS, a
  port-forwarded home server, etc.) and change `MEDIA_SERVER_URL` in
  `js/firebase.js` to that address, or
- Use a tunnel like `ngrok http 3000` or a Cloudflare Tunnel for testing, and
  set `MEDIA_SERVER_URL` to the tunnel's HTTPS URL.

**Also worth hardening before exposing it beyond your own machine:**
`server.js` currently has no auth check on `/api/upload` or the delete route —
anyone who can reach its address can upload to, or wipe, any `roomId` they
can guess (room codes are short, so this is guessable). The client-side size
checks in `js/firebase.js` don't protect the server itself, only the browser
UI. Consider adding a short-lived upload token per room before relying on
this outside your own LAN.

## 8. Test locally

The frontend uses ES modules (`<script type="module">`), so opening
`index.html` directly via `file://` will be blocked by the browser. Serve it
over HTTP instead, alongside `server.js` running in another terminal:

```bash
# any static server works, for example:
npx serve .
# or
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## 9. Deploy

Any static host works for the frontend, since there's no build step —
Firebase Hosting, Netlify, Vercel, GitHub Pages, etc. Your `server.js` needs
somewhere that can run a persistent Node process (a VPS, Render, Railway,
Fly.io, etc.) — static hosts can't run it for you.

## 10. Automatic room cleanup (important — read this)

The client checks room expiry client-side for a responsive UI ("this room
looks expired, redirecting you now"), and does a best-effort delete —
including calling your media server's delete route — when the last member
leaves. **That's not sufficient as the only enforcement**, since a malicious
or just-closed browser can't be relied on to always send that request (a
crashed tab, a forced quit, or a tampered client never fires it).

The trusted side of the architecture:

```
Client
   ↓ writes lastActivity on every message
Firebase Realtime Database
   ↓ read on a schedule by a trusted backend
Cloud Function  (functions/index.js, runs "every 10 minutes")
   ↓
Deletes Realtime Database rooms that are empty OR inactive for 1+ hour
```

`functions/index.js` only cleans up the *Realtime Database* records — it
doesn't touch your media server, since Cloud Functions run on Google's
infrastructure and generally can't reach a `localhost` server on your own
machine. If you move `server.js` somewhere publicly reachable, you can
extend the function to also call `DELETE {MEDIA_SERVER_URL}/api/room/{roomId}`
for the same rooms it deletes — there's a commented example of this in the
file.

To deploy the function:

```bash
npm install -g firebase-tools
firebase login
firebase init functions   # choose your existing project, JavaScript
# replace the generated functions/index.js with the one provided here
cd functions && npm install firebase-admin firebase-functions
cd ..
firebase deploy --only functions
```

Scheduled functions require the **Blaze (pay-as-you-go)** plan; the free tier
covers a huge number of invocations at this frequency for typical usage.

Never put a Firebase **Admin SDK** service account key, or any admin
credentials for your media server, in frontend JavaScript —
`functions/index.js` runs on Google's servers with the Admin SDK, never in
the browser.

---

## Data model

```
rooms/
  {roomId}/
    code
    hostId
    createdAt
    lastActivity
    status                 "active"
    members/
      {uid}/
        name
        joinedAt
        online
        isHost
    messages/
      {messageId}/
        senderId
        senderName
        type                "text" | "image" | "video" | "gif"
        text
        mediaUrl            # full URL, e.g. http://localhost:3000/media/{roomId}/images/xyz.jpg
        mediaType
        fileName / fileSize
        timestamp
        replyTo/
          messageId
          senderName
          preview
        reactions/
          {uid}: "❤️"

roomCodes/
  {CODE}: roomId            # fast code → id lookup, avoids scanning all rooms
```

`serverTimestamp()` is used for every `createdAt` / `timestamp` /
`lastActivity` write so expiry logic never depends on a client's clock.

## Known trade-offs / things to harden further before production

- Anonymous auth means identity is tied to a browser, not a person — clearing
  storage creates a "new" user. That's intentional for a throwaway chat room.
- The client-side expiry/cleanup logic is a UX nicety layered on top of the
  Cloud Function for the database, and on your media server's own delete
  route for files — neither is the sole source of truth, by design.
- `server.js` has no upload auth beyond a guessable room code — see the
  hardening note in step 7 before exposing it past your own machine.
- The emoji picker ships a small built-in set rather than pulling a full
  Unicode emoji library, to keep the app dependency-free.
