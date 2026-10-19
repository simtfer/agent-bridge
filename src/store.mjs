import path from "node:path";
import { now, uid, readJson, writeJsonAtomic } from "./util.mjs";

export const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "gateway-state.json");
    this.state = {
      sessions: {},
      tasks: {},
      questions: {},
      events: {},
      seq: 0,
    };
    this.saveTimer = null;
  }

  async init() {
    const loaded = readJson(this.file, null);
    if (loaded && loaded.sessions) this.state = loaded;
    await writeJsonAtomic(this.file, this.state);
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeJsonAtomic(this.file, this.state).catch((error) =>
        console.error("[bridge] state save failed:", error.message),
      );
    }, 30);
  }

  createSession(target) {
    const session = {
      id: uid("s"),
      target: {
        runner: target.runner,
        harness: target.harness,
        model: target.model || null,
        agent: target.agent || null,
      },
      name: target.name || null,
      createdAt: now(),
    };
    this.state.sessions[session.id] = session;
    this.save();
    return session;
  }

  getSession(id) {
    return this.state.sessions[id] || null;
  }

  listSessions() {
    return Object.values(this.state.sessions).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  createTask(session, input) {
    const task = {
      id: uid("t"),
      sessionId: session.id,
      target: { ...session.target },
      goal: input.goal,
      rawRequest: input.rawRequest || input.goal,
      repo: input.repo || null,
      baseRef: input.baseRef || null,
      repoPath: input.repoPath || null,
      constraints: Array.isArray(input.constraints) ? input.constraints : [],
      acceptance: Array.isArray(input.acceptance) ? input.acceptance : [],
      gates: Array.isArray(input.gates) ? input.gates : [],
      delayMs: input.delayMs ?? null,
      state: "queued",
      runnerRunId: null,
      workdir: null,
      summary: null,
      error: null,
      questionId: null,
      usage: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.tasks[task.id] = task;
    this.state.events[task.id] = [];
    this.addEvent(task.id, "created", { goal: task.goal });
    this.save();
    return task;
  }

  getTask(id) {
    return this.state.tasks[id] || null;
  }

  listTasks() {
    return Object.values(this.state.tasks).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  updateTask(id, patch) {
    const task = this.state.tasks[id];
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: now() });
    this.save();
    return task;
  }

  addEvent(taskId, type, data) {
    const event = {
      seq: ++this.state.seq,
      taskId,
      ts: now(),
      type,
      data: data ?? null,
    };
    const list = (this.state.events[taskId] ||= []);
    list.push(event);
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this.save();
    return event;
  }

  getEvents(taskId, after = 0) {
    return (this.state.events[taskId] || []).filter((event) => event.seq > after);
  }

  addQuestion(taskId, question, emitEvent = true) {
    const item = {
      id: question.id || uid("q"),
      taskId,
      kind: question.kind || "clarification",
      title: question.title || "需要人工确认",
      detail: question.detail ?? null,
      options: question.options || ["approve", "deny"],
      createdAt: now(),
      expiresAt: question.expiresAt || null,
      answer: null,
      answeredBy: null,
      answeredAt: null,
    };
    this.state.questions[item.id] = item;
    this.updateTask(taskId, { state: "waiting", questionId: item.id });
    if (emitEvent) this.addEvent(taskId, "question", item);
    return item;
  }

  getQuestion(id) {
    return this.state.questions[id] || null;
  }

  listInbox() {
    return Object.values(this.state.questions)
      .filter((question) => !question.answer)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  answerQuestion(id, answer) {
    const question = this.state.questions[id];
    if (!question) return null;
    question.answer = answer.decision || answer.text || "answered";
    question.answeredBy = answer.actor || "unknown";
    question.answeredAt = now();
    this.save();
    return question;
  }

  snapshot(selectedTaskId = null, eventLimit = 160) {
    const tasks = this.listTasks().map((task) => ({
      ...task,
      pendingQuestions: Object.values(this.state.questions).filter(
        (question) => question.taskId === task.id && !question.answer,
      ).length,
    }));
    const questions = this.listInbox();
    const events = {};
    const ids = selectedTaskId ? [selectedTaskId] : tasks.map((task) => task.id);
    for (const id of ids) {
      events[id] = (this.state.events[id] || []).slice(-eventLimit);
    }
    return {
      now: now(),
      sessions: this.listSessions(),
      tasks,
      questions,
      events,
      stats: {
        total: tasks.length,
        running: tasks.filter((task) => task.state === "running").length,
        waiting: tasks.filter((task) => task.state === "waiting").length,
      },
    };
  }
}
