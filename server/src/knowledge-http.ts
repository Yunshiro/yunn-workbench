import type { Express, Response } from "express";
import {
  askKnowledge,
  createSession,
  listMessages,
  listSessions,
  removeSession,
} from "./knowledge-chat.js";
import { KnowledgeError } from "./knowledge-error.js";
import {
  addKnowledgeBase,
  listKnowledgeBaseViews,
  readKnowledgeDocument,
  removeKnowledgeBase,
  requestKnowledgeSync,
  updateKnowledgeBaseSettings,
} from "./knowledge-service.js";
import { getKnowledgeBase } from "./knowledge-db.js";

type Wrap = (fn: (req: any, res: Response) => Promise<any> | any) => (req: any, res: Response) => void;

function fail(res: Response, error: unknown): void {
  if (error instanceof KnowledgeError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

export function mountKnowledgeRoutes(app: Express, wrap: Wrap): void {
  app.get("/api/knowledge-bases", wrap(async (_req, res) => {
    res.json(listKnowledgeBaseViews());
  }));

  app.post("/api/knowledge-bases", wrap(async (req, res) => {
    try {
      res.status(201).json(await addKnowledgeBase(req.body || {}));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.patch("/api/knowledge-bases/:id", wrap(async (req, res) => {
    try {
      res.json(await updateKnowledgeBaseSettings(req.params.id, req.body || {}));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/knowledge-bases/:id", wrap(async (req, res) => {
    try {
      removeKnowledgeBase(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/knowledge-bases/:id/sync", wrap(async (req, res) => {
    try {
      res.json(requestKnowledgeSync(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/knowledge-bases/:id/document", wrap(async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      res.json(readKnowledgeDocument(req.params.id, path));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/knowledge-bases/:id/sessions", wrap(async (req, res) => {
    try {
      res.json(listSessions(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/knowledge-bases/:id/sessions", wrap(async (req, res) => {
    try {
      if (!getKnowledgeBase(req.params.id)) return res.status(404).json({ error: "知识库不存在" });
      res.status(201).json(createSession(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/knowledge-bases/:id/sessions/:sessionId", wrap(async (req, res) => {
    try {
      removeSession(req.params.id, req.params.sessionId);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/knowledge-bases/:id/sessions/:sessionId/messages", wrap(async (req, res) => {
    try {
      res.json(listMessages(req.params.id, req.params.sessionId));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/knowledge-bases/:id/sessions/:sessionId/messages", wrap(async (req, res) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      res.status(201).json(askKnowledge(req.params.id, req.params.sessionId, content));
    } catch (error) {
      fail(res, error);
    }
  }));
}
