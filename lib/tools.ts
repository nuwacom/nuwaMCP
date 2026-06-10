// lib/tools.ts
// The 8 Orchestrator tools exposed to nuwacom agents.
// Logic is identical to the tested reference implementation; only types added.
//
//  - Discovery tools (list_folders / list_processes / list_queues) let an agent
//    resolve human names -> the IDs/keys the action tools need.
//  - Action tools accept either a human name OR a raw id/key and resolve names
//    automatically, so most tasks are a single tool call.

import { z } from "zod";
import { orchestrator } from "./orchestrator";

const { request } = orchestrator;

type Json = any;

export interface ToolDef {
  name: string;
  description: string;
  // zod raw shape passed to mcp-handler / the MCP SDK
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Json) => Promise<Json>;
}

// ----- shared field fragments -----
const folderField = z
  .union([z.number(), z.string()])
  .optional()
  .describe(
    "Folder (OrganizationUnit) Id to scope the call. Optional if UIPATH_DEFAULT_FOLDER_ID is set. Get Ids from list_folders."
  );

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function safeParse(s: string): Json {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Resolve a process name to its release key within a folder.
async function resolveReleaseKey({
  processName,
  releaseKey,
  folderId,
}: {
  processName?: string;
  releaseKey?: string;
  folderId?: number | string;
}): Promise<string> {
  if (releaseKey) return releaseKey;
  if (!processName) throw new Error("Provide either processName or releaseKey.");
  const data = await request("GET", "/odata/Releases", {
    folderId,
    query: { $filter: `Name eq '${esc(processName)}'`, $top: 1 },
  });
  const rel = data?.value?.[0];
  if (!rel) {
    throw new Error(
      `No process named "${processName}" found in this folder. Use list_processes to see available names.`
    );
  }
  return rel.Key;
}

// Resolve a queue name to its definition id within a folder.
async function resolveQueueId({
  queueName,
  queueId,
  folderId,
}: {
  queueName?: string;
  queueId?: number | string;
  folderId?: number | string;
}): Promise<number | string> {
  if (queueId !== undefined && queueId !== null && String(queueId) !== "") return queueId;
  if (!queueName) throw new Error("Provide either queueName or queueId.");
  const data = await request("GET", "/odata/QueueDefinitions", {
    folderId,
    query: { $filter: `Name eq '${esc(queueName)}'`, $top: 1 },
  });
  const q = data?.value?.[0];
  if (!q) {
    throw new Error(
      `No queue named "${queueName}" found in this folder. Use list_queues to see available names.`
    );
  }
  return q.Id;
}

// 1. list_folders
const list_folders: ToolDef = {
  name: "list_folders",
  description:
    "List the Orchestrator folders (OrganizationUnits) the connected app can access. " +
    "Returns each folder's Id (needed by other tools) and display name. Call this first when you don't know the folder Id.",
  inputSchema: {
    search: z.string().optional().describe("Optional case-insensitive substring to filter folder display names."),
    top: z.number().int().min(1).max(200).optional().describe("Max folders to return (default 100)."),
  },
  async handler({ search, top }) {
    const query: Record<string, string | number> = { $top: top ?? 100, $orderby: "DisplayName" };
    if (search) query.$filter = `contains(tolower(DisplayName),'${esc(search.toLowerCase())}')`;
    const data = await request("GET", "/odata/Folders", { query });
    const folders = (data?.value ?? []).map((f: Json) => ({
      id: f.Id,
      key: f.Key,
      name: f.DisplayName ?? f.FullyQualifiedName,
      fullyQualifiedName: f.FullyQualifiedName,
    }));
    return { count: folders.length, folders };
  },
};

// 2. list_processes
const list_processes: ToolDef = {
  name: "list_processes",
  description:
    "List the processes (Releases) available to run in a folder. Returns each process name and its releaseKey, " +
    "which start_job needs. Use when the user refers to a process by name.",
  inputSchema: {
    folderId: folderField,
    search: z.string().optional().describe("Optional substring to filter process names."),
    top: z.number().int().min(1).max(200).optional().describe("Max processes to return (default 100)."),
  },
  async handler({ folderId, search, top }) {
    const query: Record<string, string | number> = { $top: top ?? 100, $orderby: "Name" };
    if (search) query.$filter = `contains(tolower(Name),'${esc(search.toLowerCase())}')`;
    const data = await request("GET", "/odata/Releases", { folderId, query });
    const processes = (data?.value ?? []).map((r: Json) => ({
      name: r.Name,
      releaseKey: r.Key,
      processVersion: r.ProcessVersion,
      processKey: r.ProcessKey,
      description: r.Description ?? null,
    }));
    return { count: processes.length, processes };
  },
};

// 3. list_queues
const list_queues: ToolDef = {
  name: "list_queues",
  description:
    "List the queues (QueueDefinitions) in a folder. Returns each queue's name and id, which add_queue_item can use. " +
    "Note: for external API access, QueueDefinitions is the correct resource (not the robot-only Queues resource).",
  inputSchema: {
    folderId: folderField,
    search: z.string().optional().describe("Optional substring to filter queue names."),
    top: z.number().int().min(1).max(200).optional().describe("Max queues to return (default 100)."),
  },
  async handler({ folderId, search, top }) {
    const query: Record<string, string | number> = { $top: top ?? 100, $orderby: "Name" };
    if (search) query.$filter = `contains(tolower(Name),'${esc(search.toLowerCase())}')`;
    const data = await request("GET", "/odata/QueueDefinitions", { folderId, query });
    const queues = (data?.value ?? []).map((q: Json) => ({
      id: q.Id,
      name: q.Name,
      description: q.Description ?? null,
      maxNumberOfRetries: q.MaxNumberOfRetries,
    }));
    return { count: queues.length, queues };
  },
};

// 4. start_job
const start_job: ToolDef = {
  name: "start_job",
  description:
    "Start a UiPath process (create a job). Accepts a process name (auto-resolved to its releaseKey) or a releaseKey directly. " +
    "Returns the created job(s) including jobId and key for status tracking. " +
    "By default runs on any available unattended robot in the folder.",
  inputSchema: {
    processName: z
      .string()
      .optional()
      .describe("Human process name (as shown in Orchestrator). Either this or releaseKey is required."),
    releaseKey: z.string().optional().describe("The process Release Key, if already known."),
    folderId: folderField,
    inputArguments: z
      .record(z.any())
      .optional()
      .describe("Object of input arguments for the process, e.g. { invoiceId: '123' }. Serialized to JSON automatically."),
    robotCount: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("How many robots to run on (Strategy=JobsCount). Omit to run a single job on any available robot."),
  },
  async handler({ processName, releaseKey, folderId, inputArguments, robotCount }) {
    const key = await resolveReleaseKey({ processName, releaseKey, folderId });

    const startInfo: Json = {
      ReleaseKey: key,
      Strategy: "ModernJobsCount", // let Orchestrator allocate robots
      JobsCount: robotCount ?? 1,
      Source: "nuwacom-agent",
    };
    if (inputArguments && Object.keys(inputArguments).length > 0) {
      startInfo.InputArguments = JSON.stringify(inputArguments);
    }

    const data = await request("POST", "/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs", {
      folderId,
      body: { startInfo },
    });

    const jobs = (data?.value ?? []).map((j: Json) => ({
      jobId: j.Id,
      key: j.Key,
      state: j.State,
      releaseName: j.ReleaseName,
      startTime: j.StartTime,
      creationTime: j.CreationTime,
    }));
    return { started: jobs.length, jobs };
  },
};

// 5. get_job_status
const get_job_status: ToolDef = {
  name: "get_job_status",
  description:
    "Get the current status of a job by its numeric jobId. Returns state (Pending, Running, Successful, Faulted, Stopped, etc.), " +
    "timing, and any output arguments. Poll this after start_job to know when a run finishes.",
  inputSchema: {
    jobId: z.union([z.number(), z.string()]).describe("The numeric Job Id returned by start_job."),
    folderId: folderField,
  },
  async handler({ jobId, folderId }) {
    const data = await request("GET", `/odata/Jobs(${jobId})`, { folderId });
    return {
      jobId: data.Id,
      key: data.Key,
      state: data.State,
      releaseName: data.ReleaseName,
      startTime: data.StartTime,
      endTime: data.EndTime,
      info: data.Info ?? null,
      outputArguments: data.OutputArguments ? safeParse(data.OutputArguments) : null,
      hostMachineName: data.HostMachineName ?? null,
    };
  },
};

// 6. list_jobs
const list_jobs: ToolDef = {
  name: "list_jobs",
  description:
    "List recent jobs in a folder, most recent first. Optionally filter by state (e.g. 'Running', 'Faulted'). " +
    "Useful for 'what's currently running' or 'did anything fail today' questions.",
  inputSchema: {
    folderId: folderField,
    state: z
      .string()
      .optional()
      .describe("Optional job state to filter by, e.g. Pending, Running, Successful, Faulted, Stopped."),
    top: z.number().int().min(1).max(100).optional().describe("Max jobs to return (default 25)."),
  },
  async handler({ folderId, state, top }) {
    const query: Record<string, string | number> = { $top: top ?? 25, $orderby: "CreationTime desc" };
    if (state) query.$filter = `State eq '${esc(state)}'`;
    const data = await request("GET", "/odata/Jobs", { folderId, query });
    const jobs = (data?.value ?? []).map((j: Json) => ({
      jobId: j.Id,
      key: j.Key,
      state: j.State,
      releaseName: j.ReleaseName,
      startTime: j.StartTime,
      endTime: j.EndTime,
    }));
    return { count: jobs.length, jobs };
  },
};

// 7. stop_job
const stop_job: ToolDef = {
  name: "stop_job",
  description:
    "Stop or kill a running job by jobId. strategy 'SoftStop' (default) requests a graceful stop; 'Kill' forces termination. " +
    "Use SoftStop unless the job is unresponsive.",
  inputSchema: {
    jobId: z.union([z.number(), z.string()]).describe("The numeric Job Id to stop."),
    strategy: z.enum(["SoftStop", "Kill"]).optional().describe("SoftStop (graceful, default) or Kill (forceful)."),
    folderId: folderField,
  },
  async handler({ jobId, strategy, folderId }) {
    // Orchestrator StopJobs strategy: 1 = SoftStop, 2 = Kill.
    const strat = strategy === "Kill" ? 2 : 1;
    await request("POST", "/odata/Jobs/UiPath.Server.Configuration.OData.StopJobs", {
      folderId,
      body: { jobIds: [Number(jobId)], strategy: strat },
    });
    return { jobId: Number(jobId), requested: strategy ?? "SoftStop", ok: true };
  },
};

// 8. add_queue_item
const add_queue_item: ToolDef = {
  name: "add_queue_item",
  description:
    "Add a new item to a queue for a robot to process later. Accepts a queue name (auto-resolved to its id) or a queueId. " +
    "The 'content' object becomes the item's SpecificContent (the data the process reads).",
  inputSchema: {
    queueName: z.string().optional().describe("Queue name as shown in Orchestrator. Either this or queueId is required."),
    queueId: z.union([z.number(), z.string()]).optional().describe("Queue definition Id, if already known."),
    folderId: folderField,
    content: z
      .record(z.any())
      .describe("Key/value data for the item (SpecificContent), e.g. { customerId: 42, action: 'refund' }."),
    reference: z.string().optional().describe("Optional reference string for identifying/searching the item."),
    priority: z.enum(["Low", "Normal", "High"]).optional().describe("Processing priority (default Normal)."),
    deferDate: z.string().optional().describe("ISO datetime; item not processed before this time."),
    dueDate: z.string().optional().describe("ISO datetime; item should be processed by this time."),
  },
  async handler({ queueName, queueId, folderId, content, reference, priority, deferDate, dueDate }) {
    const resolvedQueue = await resolveQueueId({ queueName, queueId, folderId });
    let name = queueName;
    if (!name) {
      const q = await request("GET", `/odata/QueueDefinitions(${resolvedQueue})`, { folderId });
      name = q?.Name;
    }

    const itemData: Json = {
      Name: name,
      Priority: priority ?? "Normal",
      SpecificContent: content,
    };
    if (reference) itemData.Reference = reference;
    if (deferDate) itemData.DeferDate = deferDate;
    if (dueDate) itemData.DueDate = dueDate;

    const data = await request("POST", "/odata/Queues/UiPathODataSvc.AddQueueItem", {
      folderId,
      body: { itemData },
    });

    return {
      ok: true,
      queue: name,
      itemId: data?.Id ?? null,
      key: data?.Key ?? null,
      status: data?.Status ?? null,
    };
  },
};

// Deliberate order: discovery -> action.
export const tools: ToolDef[] = [
  list_folders,
  list_processes,
  list_queues,
  start_job,
  get_job_status,
  list_jobs,
  stop_job,
  add_queue_item,
];
