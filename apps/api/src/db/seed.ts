/**
 * Seed a demo tenant: one org, one user, a space with statuses, a list, and tasks.
 * Run with:  pnpm db:seed   (requires DATABASE_URL + a migrated schema)
 */
import { db } from "./index.js";
import {
  users,
  organizations,
  memberships,
  spaces,
  statuses,
  lists,
  tasks,
  taskAssignees,
} from "./schema.js";

async function seed() {
  console.log("🌱 Seeding demo tenant…");

  const [user] = await db
    .insert(users)
    .values({
      authSubject: "seed|demo-user",
      email: "demo@4s.digital",
      name: "Demo User",
    })
    .returning();

  const [org] = await db
    .insert(organizations)
    .values({ name: "4S Digital", slug: "4s-digital", ownerId: user!.id })
    .returning();

  await db.insert(memberships).values({
    organizationId: org!.id,
    userId: user!.id,
    role: "owner",
  });

  const [space] = await db
    .insert(spaces)
    .values({ organizationId: org!.id, name: "Product", color: "#6366f1", position: 1 })
    .returning();

  const statusRows = await db
    .insert(statuses)
    .values([
      { organizationId: org!.id, spaceId: space!.id, name: "To Do", category: "not_started", color: "#94a3b8", position: 1 },
      { organizationId: org!.id, spaceId: space!.id, name: "In Progress", category: "active", color: "#3b82f6", position: 2 },
      { organizationId: org!.id, spaceId: space!.id, name: "In Review", category: "active", color: "#f59e0b", position: 3 },
      { organizationId: org!.id, spaceId: space!.id, name: "Done", category: "done", color: "#22c55e", position: 4 },
    ])
    .returning();

  const [list] = await db
    .insert(lists)
    .values({ organizationId: org!.id, spaceId: space!.id, name: "Sprint 1", position: 1 })
    .returning();

  const todo = statusRows.find((s) => s.name === "To Do")!;
  const inProgress = statusRows.find((s) => s.name === "In Progress")!;

  const taskRows = await db
    .insert(tasks)
    .values([
      { organizationId: org!.id, listId: list!.id, statusId: inProgress.id, reference: "PM-1", title: "Set up multi-tenant data model", priority: "high", position: 1, createdById: user!.id },
      { organizationId: org!.id, listId: list!.id, statusId: todo.id, reference: "PM-2", title: "Wire managed auth (Clerk/Auth0)", priority: "urgent", position: 2, createdById: user!.id },
      { organizationId: org!.id, listId: list!.id, statusId: todo.id, reference: "PM-3", title: "Board view with drag-and-drop", priority: "normal", position: 3, createdById: user!.id },
    ])
    .returning();

  await db.insert(taskAssignees).values({
    taskId: taskRows[0]!.id,
    userId: user!.id,
    organizationId: org!.id,
  });

  console.log(`✅ Seeded org ${org!.id} (${org!.slug}) with ${taskRows.length} tasks.`);
  console.log(`   Use these headers when calling the API:`);
  console.log(`     x-org-id:  ${org!.id}`);
  console.log(`     x-user-id: ${user!.id}`);
  console.log(`     listId:    ${list!.id}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
