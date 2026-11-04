// Starter graphs. Provider/model defaults are resolved from the current workspace.
import type { WorkflowBlock, WorkflowEdge } from "./workflows";
type Graph = { blocks: WorkflowBlock[]; edges: WorkflowEdge[] };

function multiAgentSetup(): Graph {
  const agents = [
    { id: "researcher", label: "Researcher", role: "Investigate the goal, relevant code and constraints. Return concrete findings and recommended steps. Inspect without editing files." },
    { id: "implementer", label: "Implementer", role: "Implement the assigned part of the goal, following workspace instructions. Coordinate ownership before editing. Validate changes and report what changed and any remaining issues." },
    { id: "reviewer", label: "Reviewer", role: "Review the supplied plan or implementation against the user's goal. Inspect without editing files. Report bugs, missing coverage and concrete recommendations; distinguish verified facts from assumptions." },
  ];
  return {
    blocks: [
      { id: "start", type: "start_input", label: "Start with a prompt", prompt: "", position: { x: 32, y: 220 } },
      { id: "coordinator", type: "ai", label: "Coordinator", position: { x: 310, y: 220 },
        prompt: `Coordinate this goal: {{input}}
You have three connected agents (researcher, implementer, reviewer) and a shared Meeting block (meeting).
1. Publish the goal and a short plan to meeting with workflow_use_block, action publish.
2. Delegate concrete tasks through workflow_use_block to researcher, then implementer when changes are requested, and reviewer. Include the original goal and relevant findings in each task. Researcher and reviewer inspect without editing; implementer owns edits. For a question-only goal, ask implementer for a proposed solution without editing.
3. Read meeting messages with action diff as you work. Every agent can see participant activity notices there. To wake a specific participant, use action shake with that participant's block ID in peer_block_id and a specific message. Use the connected agents' returned results to track completion; do not wait indefinitely for optional messages.
4. Resolve review findings with the implementer as needed. Publish the final outcome to meeting, then return a concise report of results, validation and remaining issues. Do not claim unperformed checks.` },
      ...agents.map((agent, index): WorkflowBlock => ({ id: agent.id, type: "ai", label: agent.label,
        prompt: `${agent.role}\nTask: {{input}}\nUse the connected meeting block through workflow_use_block to read the team's messages (action diff), publish relevant findings (action publish, message), and coordinate handoffs. Status notices are announced automatically. If waking a teammate with action shake, supply peer_block_id and a specific message. Publish your result to the room and return it to the coordinator. Finish your invocation when your assigned work is complete.`,
        position: { x: 620, y: 40 + index * 180 } })),
      { id: "meeting", type: "meeting", label: "Team meeting", prompt: "", position: { x: 940, y: 220 } },
      { id: "report", type: "markdown", label: "Team report", prompt: "{{input}}", position: { x: 310, y: 580 } },
    ],
    edges: [
      { id: "start-team", from: "start", to: "coordinator", type: "follow" },
      ...agents.map(agent => ({ id: `delegate-${agent.id}`, from: "coordinator", to: agent.id, type: "use" as const })),
      ...["coordinator", ...agents.map(agent => agent.id)].map(id => ({ id: `meeting-${id}`, from: id, to: "meeting", type: "use" as const })),
      { id: "team-report", from: "coordinator", to: "report", type: "follow" },
    ],
  };
}

export const WORKFLOW_TEMPLATES = [
  { id: "blank", name: "Blank workflow", description: "Start from an empty canvas.", graph: (): Graph => ({ blocks: [], edges: [] }) },
  { id: "multi-agent-setup", name: "Multi-agent setup", description: "Start with a prompt, coordinate three specialist agents in a shared meeting, and produce a report.", graph: multiAgentSetup },
];
