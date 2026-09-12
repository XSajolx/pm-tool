import { io, type Socket } from "socket.io-client";
import { API_CONFIGURED, API_URL } from "./api.js";
import { supabase } from "./supabase.js";

let socket: Socket | null = null;

/**
 * Lazy singleton socket.io connection to the API's WS gateway.
 *
 * `auth` is given as a callback rather than a fixed object so every connection —
 * including automatic reconnects, which can happen long after the page loaded —
 * sends a freshly read access token. The gateway drops any socket whose token
 * doesn't verify.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      // VITE_REALTIME=off for hosts that can't hold a websocket (e.g. the API on
      // Vercel serverless): chat still works over REST, it just doesn't push.
      autoConnect: API_CONFIGURED && import.meta.env.VITE_REALTIME !== "off",
      transports: ["websocket", "polling"],
      auth: (cb) => {
        void supabase.auth.getSession().then(({ data }) => {
          cb({ token: data.session?.access_token ?? null });
        });
      },
    });
  }
  return socket;
}

/** Drop the connection on sign-out so the next user doesn't inherit this socket. */
export function closeSocket() {
  socket?.disconnect();
  socket = null;
}
