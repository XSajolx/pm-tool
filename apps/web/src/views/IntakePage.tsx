import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type IntakeItem, type IntakeItemStatus } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { relativeTime } from "../components/TaskCollaboration.js";
import { cn } from "../lib/utils.js";

const STATUS_STYLE: Record<IntakeItemStatus, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  accepted: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  snoozed: "bg-slate-100 text-slate-600 border-slate-200",
  duplicate: "bg-violet-50 text-violet-700 border-violet-200",
};

/**
 * Triage queue. Anyone in the org can submit; only owners and admins decide.
 * Submissions exist as real tasks from the moment they arrive, but stay out of
 * the lists until accepted — so accepting is a state change, not a copy.
 */
export function IntakePage() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canTriage = role === "owner" || role === "admin";
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  const { data: spaces = [] } = useQuery({ queryKey: ["spaces"], queryFn: api.getSpaces });
  const spaceId = spaces[0]?.id;

  const { data: queues = [] } = useQuery({
    queryKey: ["intakes", spaceId],
    queryFn: () => api.getIntakes(spaceId!),
    enabled: Boolean(spaceId),
  });
  const intake = queues[0];

  const { data: items = [] } = useQuery({
    queryKey: ["intake-items", intake?.id, filter],
    queryFn: () => api.getIntakeItems(intake!.id, filter === "pending" ? "pending" : undefined),
    enabled: Boolean(intake),
  });

  const createQueue = useMutation({
    mutationFn: () => api.ensureIntake(spaceId!, spaces[0]?.lists[0]?.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["intakes", spaceId] }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["intake-items"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: IntakeItemStatus }) =>
      api.decideIntake(id, {
        decision,
        snoozedTill: decision === "snoozed" ? new Date(Date.now() + 7 * 86_400_000).toISOString() : undefined,
      }),
    onSuccess: refresh,
  });

  if (!spaceId) {
    return <Centered>Create a space first.</Centered>;
  }

  if (!intake) {
    return (
      <Centered>
        <p className="mb-3 text-sm text-muted-foreground">
          This space has no intake queue yet.
        </p>
        {canTriage ? (
          <button
            onClick={() => createQueue.mutate()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {createQueue.isPending ? "Creating…" : "Create intake queue"}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">Ask an admin to set one up.</p>
        )}
      </Centered>
    );
  }

  return (
    <div className="flex h-screen flex-1 flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold text-slate-800">Intake</h1>
        <span className="text-xs text-muted-foreground">
          Suggestions and feedback waiting to be triaged
        </span>
        <div className="ml-auto flex gap-1">
          {(["pending", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                filter === f
                  ? "bg-muted text-slate-800"
                  : "text-muted-foreground hover:text-slate-700",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      <SubmitBox intakeId={intake.id} onSubmitted={refresh} />

      <div className="flex-1 overflow-y-auto">
        {items.length ? (
          <ul>
            {items.map((item) => (
              <IntakeRow
                key={item.id}
                item={item}
                canTriage={canTriage}
                onDecide={(decision) => decide.mutate({ id: item.id, decision })}
              />
            ))}
          </ul>
        ) : (
          <Centered>
            <span className="mb-1 text-2xl">💡</span>
            <p className="text-sm text-muted-foreground">
              {filter === "pending" ? "Nothing waiting to be triaged." : "No submissions yet."}
            </p>
          </Centered>
        )}
      </div>
    </div>
  );
}

function SubmitBox({
  intakeId,
  onSubmitted,
}: {
  intakeId: string;
  onSubmitted: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      api.submitIntake({ intakeId, title: title.trim(), description: description.trim() }),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setOpen(false);
      onSubmitted();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) submit.mutate();
  }

  if (!open) {
    return (
      <div className="border-b border-border px-6 py-2.5">
        <button
          onClick={() => setOpen(true)}
          className="text-sm text-muted-foreground transition hover:text-slate-700"
        >
          + Submit a suggestion
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="border-b border-border px-6 py-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What should we build or fix?"
        className="w-full rounded-md border border-border px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Any detail that would help whoever picks this up…"
        rows={2}
        className="mt-2 w-full resize-none rounded-md border border-border px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim() || submit.isPending}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {submit.isPending ? "Submitting…" : "Submit"}
        </button>
      </div>
    </form>
  );
}

function IntakeRow({
  item,
  canTriage,
  onDecide,
}: {
  item: IntakeItem;
  canTriage: boolean;
  onDecide: (decision: IntakeItemStatus) => void;
}) {
  return (
    <li className="group flex items-start gap-3 border-b border-border px-6 py-3 hover:bg-[#fbfbfa]">
      <span
        className={cn(
          "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          STATUS_STYLE[item.status],
        )}
      >
        {item.status}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">
          {item.task?.title ?? "Untitled"}
        </p>
        {item.task?.description && (
          <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
            {item.task.description}
          </p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          via {item.source.replace("_", " ")} · {relativeTime(item.createdAt)}
        </p>
      </div>

      {canTriage && item.status === "pending" && (
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => onDecide("accepted")}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-indigo-700"
          >
            Accept
          </button>
          <button
            onClick={() => onDecide("snoozed")}
            title="Hide for a week"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-muted"
          >
            Snooze
          </button>
          <button
            onClick={() => onDecide("rejected")}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-muted"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center text-center">
      {children}
    </div>
  );
}
