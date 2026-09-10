/**
 * Additive seed for chat: adds a 2nd teammate, two channels, a DM, and messages
 * to the EXISTING demo org (looked up by slug). Safe to run once.
 *   pnpm --filter @pm/api exec node --import @swc-node/register/esm-register src/db/seed-chat.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index.js";
import { users, organizations, memberships, channels, channelMembers, messages } from "./schema.js";

async function seed() {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.slug, "4s-digital"),
  });
  if (!org) throw new Error("Run `pnpm db:seed` first — demo org not found.");
  const owner = await db.query.users.findFirst({ where: eq(users.id, org.ownerId) });
  if (!owner) throw new Error("Owner user missing.");

  // 2nd teammate (idempotent-ish: skip if email exists)
  let mate = await db.query.users.findFirst({ where: eq(users.email, "arfin@4s.digital") });
  if (!mate) {
    [mate] = await db
      .insert(users)
      .values({ authSubject: "seed|arfin", email: "arfin@4s.digital", name: "Arfin Siam" })
      .returning();
    await db.insert(memberships).values({
      organizationId: org.id,
      userId: mate!.id,
      role: "member",
    });
  }

  const both = [owner.id, mate!.id];

  // Channels
  const [general, welcome, dm] = await db
    .insert(channels)
    .values([
      { organizationId: org.id, type: "channel", name: "general", topic: "Company-wide chatter", createdById: owner.id },
      { organizationId: org.id, type: "channel", name: "product", topic: "PM tool build", createdById: owner.id },
      { organizationId: org.id, type: "dm", createdById: owner.id },
    ])
    .returning();

  for (const ch of [general!, welcome!, dm!]) {
    await db.insert(channelMembers).values(
      both.map((uid) => ({ channelId: ch.id, userId: uid, organizationId: org.id })),
    );
  }

  const now = Date.now();
  const mkMsgs = (channelId: string, rows: [string, string][]) =>
    rows.map(([authorId, body], i) => ({
      organizationId: org.id,
      channelId,
      authorId,
      body,
      createdAt: new Date(now - (rows.length - i) * 60_000),
    }));

  await db.insert(messages).values([
    ...mkMsgs(general!.id, [
      [owner.id, "👋 Welcome to the team chat!"],
      [mate!.id, "Thanks! Excited to build the PM tool 🚀"],
      [owner.id, "Board + chat are live now — try dragging a task between columns."],
    ]),
    ...mkMsgs(welcome!.id, [
      [mate!.id, "Should we wire auth before or after realtime?"],
      [owner.id, "Realtime's basically done — auth next."],
    ]),
    ...mkMsgs(dm!.id, [
      [mate!.id, "Hey, can you review PM-2?"],
      [owner.id, "On it 👍"],
    ]),
  ]);

  console.log(`✅ Chat seeded: 2 channels + 1 DM, teammate "Arfin Siam" (${mate!.id}).`);
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
