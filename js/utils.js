// ============================================================================
// utils.js — shared helpers used by app.js and room.js
// ============================================================================

/** Escapes HTML so user content can never be injected as markup. */
export function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/**
 * Turns escaped plain text into safe render-ready HTML:
 * preserves line breaks and linkifies URLs, without ever using
 * unescaped user input inside innerHTML.
 */
export function renderMessageText(raw) {
  const escaped = escapeHTML(raw);
  const urlPattern = /((https?:\/\/|www\.)[^\s<]+)/gi;
  const withLinks = escaped.replace(urlPattern, (match) => {
    const href = match.startsWith("http") ? match : `https://${match}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>`;
  });
  return withLinks.replace(/\n/g, "<br>");
}

export function getSavedDisplayName() {
  return localStorage.getItem("chatapp_name") || "";
}

export function saveDisplayName(name) {
  localStorage.setItem("chatapp_name", name);
}

/** Short, human-friendly room code, e.g. X7K29P — avoids ambiguous chars. */
export function generateRoomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export const QUICK_REACTIONS = ["❤️", "😂", "👍", "🔥", "😮", "😢"];

// Small, dependency-free emoji set grouped for the picker.
export const EMOJI_GROUPS = {
  Smileys: ["😀","😁","😂","🤣","😊","😍","😘","😜","🤔","😎","🥳","😴","😭","😡","🤯","🥰","😇","🙃","😏","🤗"],
  Gestures: ["👍","👎","👏","🙌","🙏","👋","🤝","💪","✌️","🤞","👌","🤙"],
  Hearts: ["❤️","🧡","💛","💚","💙","💜","🖤","💔","💕","💖"],
  Objects: ["🔥","✨","🎉","🎊","💡","📎","📷","🎵","⚡","💯","🏆","🎁"],
  Animals: ["🐶","🐱","🦊","🐻","🐼","🐸","🦄","🐝","🦋","🐢"],
};

let toastContainer;
export function showToast(message, variant = "default", duration = 3000) {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    toastContainer.setAttribute("aria-live", "polite");
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast--${variant}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast--visible"));
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      el.remove();
    }
  }
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
