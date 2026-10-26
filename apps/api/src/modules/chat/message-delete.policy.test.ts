import { describe, expect, it } from "vitest";
import { canDeleteMessage, canModerateChannel, OWN_DELETE_WINDOW_MS } from "./message-delete.policy.js";

const now = new Date("2026-10-27T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const named = { type: "channel" as const, createdById: "creator", projectLeadId: null };
const projectCh = { type: "channel" as const, createdById: null, projectLeadId: "lead" };
const dm = { type: "dm" as const, createdById: null, projectLeadId: null };
const userMsg = (authorId: string, age = 60_000) => ({ authorId, kind: "user" as const, createdAt: ago(age) });

describe("canModerateChannel", () => {
  it("workspace owner and admin moderate every channel, DMs included", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const ch of [named, projectCh, dm]) expect(canModerateChannel({ userId: "x", role }, ch)).toBe(true);
    }
  });
  it("the creator of a named channel moderates it", () => {
    expect(canModerateChannel({ userId: "creator", role: "member" }, named)).toBe(true);
  });
  it("the project lead moderates the project channel", () => {
    expect(canModerateChannel({ userId: "lead", role: "member" }, projectCh)).toBe(true);
  });
  it("a DM has no creator-moderator", () => {
    expect(canModerateChannel({ userId: "creator", role: "member" }, { ...dm, createdById: "creator" })).toBe(false);
  });
  it("other members and guests don't", () => {
    expect(canModerateChannel({ userId: "m", role: "member" }, named)).toBe(false);
    expect(canModerateChannel({ userId: "g", role: "guest" }, projectCh)).toBe(false);
  });
});

describe("canDeleteMessage", () => {
  it("the author deletes their own message inside 24h, in any channel, guests too", () => {
    for (const ch of [named, projectCh, dm]) {
      expect(canDeleteMessage({ userId: "a", role: "guest" }, ch, userMsg("a"), now)).toEqual({ ok: true, as: "author" });
    }
  });
  it("the author can't after 24h", () => {
    const res = canDeleteMessage({ userId: "a", role: "member" }, named, userMsg("a", OWN_DELETE_WINDOW_MS + 1), now);
    expect(res.ok).toBe(false);
  });
  it("exactly 24h is still allowed", () => {
    expect(canDeleteMessage({ userId: "a", role: "member" }, named, userMsg("a", OWN_DELETE_WINDOW_MS), now).ok).toBe(true);
  });
  it("moderators delete anyone's message with no time limit", () => {
    const old = userMsg("someone", 30 * OWN_DELETE_WINDOW_MS);
    expect(canDeleteMessage({ userId: "x", role: "admin" }, dm, old, now)).toEqual({ ok: true, as: "moderator" });
    expect(canDeleteMessage({ userId: "creator", role: "member" }, named, old, now)).toEqual({ ok: true, as: "moderator" });
    expect(canDeleteMessage({ userId: "lead", role: "member" }, projectCh, old, now)).toEqual({ ok: true, as: "moderator" });
  });
  it("a moderator past 24h on their own message still can, as moderator", () => {
    expect(canDeleteMessage({ userId: "creator", role: "member" }, named, userMsg("creator", 2 * OWN_DELETE_WINDOW_MS), now)).toEqual({ ok: true, as: "moderator" });
  });
  it("another member can't delete someone else's message", () => {
    expect(canDeleteMessage({ userId: "m", role: "member" }, named, userMsg("a"), now).ok).toBe(false);
  });
  it("system lines are moderator-only, even for the actor they're attributed to", () => {
    const sys = { authorId: "a", kind: "system" as const, createdAt: ago(1000) };
    expect(canDeleteMessage({ userId: "a", role: "member" }, projectCh, sys, now).ok).toBe(false);
    expect(canDeleteMessage({ userId: "lead", role: "member" }, projectCh, sys, now).ok).toBe(true);
  });
});
