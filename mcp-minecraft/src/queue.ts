import fs from "fs";
import path from "path";

export interface BuildRequest {
  id: string;
  player: string;
  prompt: string;
  position: { x: number; y: number; z: number };
  status: "pending" | "building" | "completed" | "failed";
  timestamp: number;
  result?: string;
  tokens?: number;
  cost?: string;
}

const QUEUE_FILE =
  process.env.BUILD_QUEUE_FILE ||
  path.resolve(process.cwd(), "build_queue.json");

function loadQueue(): BuildRequest[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const data = fs.readFileSync(QUEUE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveQueue(queue: BuildRequest[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

export function addBuildRequest(
  player: string,
  prompt: string,
  position: { x: number; y: number; z: number }
): BuildRequest {
  const queue = loadQueue();
  const request: BuildRequest = {
    id: Date.now().toString(),
    player,
    prompt,
    position,
    status: "pending",
    timestamp: Date.now(),
  };
  queue.push(request);
  saveQueue(queue);
  return request;
}

export function getPendingRequests(): BuildRequest[] {
  return loadQueue().filter((r) => r.status === "pending");
}

export function getRequest(id: string): BuildRequest | undefined {
  return loadQueue().find((r) => r.id === id);
}

export function updateRequest(
  id: string,
  updates: Partial<BuildRequest>
): BuildRequest | undefined {
  const queue = loadQueue();
  const idx = queue.findIndex((r) => r.id === id);
  if (idx === -1) return undefined;
  queue[idx] = { ...queue[idx], ...updates };
  saveQueue(queue);
  return queue[idx];
}

export function markCompleted(
  id: string,
  result?: string,
  tokens?: number,
  cost?: string
): void {
  updateRequest(id, {
    status: "completed",
    result,
    tokens,
    cost,
  });
}

export function markFailed(id: string, error: string): void {
  updateRequest(id, { status: "failed", result: error });
}

export function markBuilding(id: string): void {
  updateRequest(id, { status: "building" });
}
