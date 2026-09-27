// ============================================================================
// functions/index.js — trusted backend for Realtime Database room expiration
// ============================================================================
// Client-side JavaScript can never be trusted to enforce expiration securely,
// since any user could tamper with it. This Cloud Function runs on a
// schedule with admin privileges and deletes stale/empty rooms from the
// Realtime Database (README §10 covers deployment).
//
// NOTE ON MEDIA: this project uploads images/video to your own local
// server.js (Express + Multer), not Firebase Storage. Cloud Functions run on
// Google's infrastructure and generally cannot reach a `localhost` server on
// your machine, so this function does NOT delete media files — room.js
// already calls server.js's DELETE /api/room/:roomId route client-side when
// a room ends. If you move server.js to a publicly reachable host, you can
// uncomment the fetch() call below to have this function clean up media too.
//
// Deploy with: firebase deploy --only functions
// Requires the Blaze (pay-as-you-go) plan, since scheduled functions need it.
// ============================================================================

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

initializeApp();

const ONE_HOUR_MS = 60 * 60 * 1000;

// Only needed if you uncomment the media-cleanup fetch() below — set this to
// your media server's PUBLIC address (a Cloud Function can't reach localhost).
// const MEDIA_SERVER_URL = "https://your-public-media-server.example.com";

exports.cleanupExpiredRooms = onSchedule("every 10 minutes", async () => {
  const db = getDatabase();
  const now = Date.now();

  const roomsSnap = await db.ref("rooms").once("value");
  const rooms = roomsSnap.val() || {};

  const deletions = Object.entries(rooms).map(async ([roomId, room]) => {
    const noMembers = !room.members || Object.keys(room.members).length === 0;
    const inactiveTooLong = room.lastActivity && now - room.lastActivity >= ONE_HOUR_MS;

    if (!noMembers && !inactiveTooLong) return;

    // Uncomment if server.js is publicly reachable and you want the backend
    // (not just the client) to guarantee media gets cleaned up too:
    //
    // try {
    //   await fetch(`${MEDIA_SERVER_URL}/api/room/${roomId}`, { method: "DELETE" });
    // } catch (err) {
    //   console.error(`Media cleanup failed for ${roomId}:`, err);
    // }

    // Delete the room's database records.
    const updates = {};
    updates[`rooms/${roomId}`] = null;
    if (room.code) updates[`roomCodes/${room.code}`] = null;
    await db.ref().update(updates);

    console.log(`Deleted expired/empty room ${roomId}`);
  });

  await Promise.all(deletions);
});

