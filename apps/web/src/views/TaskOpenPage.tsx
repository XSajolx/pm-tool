import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

/**
 * `/t/:taskId` — a stable link to a task from anywhere (inbox rows, the
 * dashboard, chat). Resolves the task's list and lands on that list with the
 * detail panel already open.
 */
export function TaskOpenPage() {
  const { taskId } = useParams({ from: "/t/$taskId" });
  const navigate = useNavigate();
  const { data: task, isError } = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId) });

  useEffect(() => {
    if (task?.listId) {
      navigate({
        to: "/l/$listId",
        params: { listId: task.listId },
        search: { task: task.id },
        replace: true,
      });
    }
  }, [task, navigate]);

  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {isError ? "That task could not be found." : "Opening task…"}
    </div>
  );
}
