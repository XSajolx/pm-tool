import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ProjectRole } from "../lib/api.js";
import { Avatar } from "./ui.js";

/**
 * Row 39: who is on the project. The lead and creator are always in; anyone
 * assigned a task in the project joins automatically. The team is mirrored
 * into the project's chat channel.
 */
export function ProjectTeam({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState("");
  const { data: team = [] } = useQuery({ queryKey: ["project-members", projectId], queryFn: () => api.getProjectMembers(projectId) });
  const { data: all = [] } = useQuery({ queryKey: ["members"], queryFn: api.getMembers });
  const { data: channels = [] } = useQuery({ queryKey: ["channels"], queryFn: api.getChannels });
  const channel = channels.find((c) => c.projectId === projectId);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project-members", projectId] });
    qc.invalidateQueries({ queryKey: ["channels"] });
  };
  const add = useMutation({ mutationFn: (userId: string) => api.addProjectMembers(projectId, [userId]), onSuccess: () => { setAdding(""); refresh(); } });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeProjectMember(projectId, userId), onSuccess: refresh });
  // Row 85: lead / contributor / viewer per person on this project.
  const setRole = useMutation({ mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => api.setProjectMemberRole(projectId, userId, role), onSuccess: refresh });

  const inTeam = new Set(team.map((m) => m.id));
  const candidates = all.filter((m) => !inTeam.has(m.id));

  return (
    <section className="mt-6 rounded-lg border border-border bg-white">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</h2>
        <span className="text-xs text-muted-foreground">{team.length}</span>
        {channel && (
          <Link to="/chat/$channelId" params={{ channelId: channel.id }} className="ml-auto text-xs font-medium text-indigo-600 hover:text-indigo-700">
            💬 #{channel.name}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {team.map((m) => (
          <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[#fbfbfa] py-0.5 pl-0.5 pr-2 text-xs text-slate-700">
            <Avatar user={{ id: m.id, name: m.name, avatarUrl: m.avatarUrl, email: m.email, role: "member" }} size={18} />
            {m.name}
            {m.isLead || m.isCreator || !canManage ? (
              <span className={`rounded px-1 text-[10px] font-medium ${m.role === "lead" ? "bg-indigo-50 text-indigo-700" : m.role === "viewer" ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"}`}>
                {m.role === "lead" ? "Lead" : m.role === "viewer" ? "Viewer" : "Contributor"}
              </span>
            ) : (
              <select
                value={m.role}
                onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as ProjectRole })}
                title="Role on this project"
                className="rounded border border-border bg-white px-1 py-0 text-[10px] text-slate-700"
              >
                <option value="lead">Lead</option>
                <option value="contributor">Contributor</option>
                <option value="viewer">Viewer</option>
              </select>
            )}
            {canManage && !m.isLead && !m.isCreator && (
              <button type="button" onClick={() => remove.mutate(m.id)} title="Remove from team" className="ml-0.5 text-slate-400 hover:text-red-600">
                ×
              </button>
            )}
          </span>
        ))}
        {canManage && candidates.length > 0 && (
          <select
            value={adding}
            onChange={(e) => {
              setAdding(e.target.value);
              if (e.target.value) add.mutate(e.target.value);
            }}
            className="rounded-full border border-dashed border-border bg-white px-2 py-0.5 text-xs text-slate-500 outline-none"
          >
            <option value="">+ Add person</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Leads run the project (team, stages, milestones); contributors work on tasks; viewers can only look. Assigning someone a task adds them as a contributor. Everyone on the team is in the project channel.
      </p>
    </section>
  );
}
