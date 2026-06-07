"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Plus, Save } from "lucide-react";
import type {
  AwardPriority,
  AwardTaskStatus,
  AwardWorkflowStatus,
} from "@/lib/database.types";
import {
  awardPriorities,
  awardWorkflowStatuses,
  priorityLabels,
  workflowStatusLabels,
} from "@/lib/award-workflow";

export type WorkflowMember = {
  id: string;
  email: string | null;
  role: string;
};

export function AwardWorkflowControls({
  awardId,
  members,
  ownerMemberId,
  priority,
  workflowStatus,
}: {
  awardId: string;
  members: WorkflowMember[];
  ownerMemberId: string | null;
  priority: AwardPriority;
  workflowStatus: AwardWorkflowStatus;
}) {
  const router = useRouter();
  const [statusValue, setStatusValue] = useState(workflowStatus);
  const [priorityValue, setPriorityValue] = useState(priority);
  const [ownerValue, setOwnerValue] = useState(ownerMemberId || "");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(markReviewed = false) {
    setSaving(true);
    setMessage("");
    const response = await fetch(`/api/awards/${awardId}/workflow`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowStatus: statusValue,
        priority: priorityValue,
        ownerMemberId: ownerValue || null,
        markReviewed,
      }),
    });
    const data = await response.json();
    setSaving(false);

    if (!response.ok) {
      setMessage(data.error || "Award workflow could not be updated.");
      return;
    }

    setMessage(markReviewed ? "Award marked reviewed." : "Award workflow saved.");
    router.refresh();
  }

  return (
    <section className="card rounded-3xl p-6">
      <h2 className="text-2xl font-black">Workflow</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div>
          <label className="text-sm font-bold" htmlFor="workflow-status">
            Status
          </label>
          <select
            id="workflow-status"
            className="input mt-1"
            value={statusValue}
            onChange={(event) => setStatusValue(event.target.value as AwardWorkflowStatus)}
          >
            {awardWorkflowStatuses.map((status) => (
              <option key={status} value={status}>
                {workflowStatusLabels[status]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-bold" htmlFor="award-priority">
            Priority
          </label>
          <select
            id="award-priority"
            className="input mt-1"
            value={priorityValue}
            onChange={(event) => setPriorityValue(event.target.value as AwardPriority)}
          >
            {awardPriorities.map((nextPriority) => (
              <option key={nextPriority} value={nextPriority}>
                {priorityLabels[nextPriority]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-bold" htmlFor="award-owner">
            Owner
          </label>
          <select
            id="award-owner"
            className="input mt-1"
            value={ownerValue}
            onChange={(event) => setOwnerValue(event.target.value)}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.email || "Advisor"}
              </option>
            ))}
          </select>
        </div>
      </div>
      {message && <p className="mt-4 text-sm font-semibold">{message}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <button className="button-primary" type="button" disabled={saving} onClick={() => save(false)}>
          <Save size={16} aria-hidden="true" />
          {saving ? "Saving..." : "Save workflow"}
        </button>
        <button className="button-secondary" type="button" disabled={saving} onClick={() => save(true)}>
          <Check size={16} aria-hidden="true" />
          Mark reviewed
        </button>
      </div>
    </section>
  );
}

export function AwardNoteForm({ awardId }: { awardId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    const response = await fetch(`/api/awards/${awardId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const data = await response.json();
    setSaving(false);

    if (!response.ok) {
      setMessage(data.error || "Note could not be saved.");
      return;
    }

    setBody("");
    setMessage("Note saved.");
    router.refresh();
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <label className="text-sm font-bold" htmlFor="award-note">
        Add note
      </label>
      <textarea
        id="award-note"
        className="input mt-1 min-h-28"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What should the office know about this award?"
        required
      />
      {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
      <button className="button-primary mt-3" type="submit" disabled={saving}>
        <Plus size={16} aria-hidden="true" />
        {saving ? "Saving..." : "Add note"}
      </button>
    </form>
  );
}

export function AwardTaskForm({
  awardId,
  members,
}: {
  awardId: string;
  members: WorkflowMember[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    const form = new FormData(event.currentTarget);

    const response = await fetch(`/api/awards/${awardId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        assignedMemberId: form.get("assignedMemberId") || null,
      }),
    });
    const data = await response.json();
    setSaving(false);

    if (!response.ok) {
      setMessage(data.error || "Follow-up could not be created.");
      return;
    }

    event.currentTarget.reset();
    setMessage("Follow-up added.");
    router.refresh();
  }

  return (
    <form className="mt-4 grid gap-3 md:grid-cols-[1fr_220px_auto]" onSubmit={submit}>
      <input className="input" name="title" placeholder="Follow up on application instructions" required />
      <select className="input" name="assignedMemberId" aria-label="Assign follow-up">
        <option value="">Unassigned</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.email || "Advisor"}
          </option>
        ))}
      </select>
      <button className="button-primary" type="submit" disabled={saving}>
        <Plus size={16} aria-hidden="true" />
        {saving ? "Adding..." : "Add"}
      </button>
      {message && <p className="text-sm font-semibold md:col-span-3">{message}</p>}
    </form>
  );
}

export function AwardTaskControls({
  assignedMemberId,
  awardId,
  members,
  status,
  taskId,
}: {
  assignedMemberId: string | null;
  awardId: string;
  members: WorkflowMember[];
  status: AwardTaskStatus;
  taskId: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function update(body: Record<string, unknown>) {
    setSaving(true);
    const response = await fetch(`/api/awards/${awardId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (response.ok) router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={status === "done" ? "button-secondary" : "button-primary"}
        type="button"
        disabled={saving}
        onClick={() => update({ status: status === "done" ? "todo" : "done" })}
      >
        <Check size={16} aria-hidden="true" />
        {status === "done" ? "Reopen" : "Complete"}
      </button>
      <select
        className="input w-auto"
        value={assignedMemberId || ""}
        onChange={(event) => update({ assignedMemberId: event.target.value || null })}
        aria-label="Task assignee"
        disabled={saving}
      >
        <option value="">Unassigned</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.email || "Advisor"}
          </option>
        ))}
      </select>
    </div>
  );
}
