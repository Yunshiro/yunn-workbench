import type { Express, Response } from "express";
import { BoardDuplicateError } from "./board-service.js";
import { BoardError } from "./board-error.js";
import {
  askBoard,
  createSession,
  listMessages,
  listSessions,
  removeSession,
} from "./board-chat.js";
import {
  addLinkCard,
  addNoteCard,
  createBoard,
  editCard,
  getBoards,
  getCards,
  removeBoard,
  removeCard,
  renameBoard,
  retryCard,
} from "./board-service.js";

type Wrap = (fn: (req: any, res: Response) => Promise<any> | any) => (req: any, res: Response) => void;

function fail(res: Response, error: unknown): void {
  if (error instanceof BoardDuplicateError) {
    res.status(409).json({ error: error.message, card: error.card });
    return;
  }
  if (error instanceof BoardError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

function cardIds(body: any): string[] | undefined {
  if (body?.cardIds === undefined) return undefined;
  if (!Array.isArray(body.cardIds) || body.cardIds.some((id: unknown) => typeof id !== "string")) {
    throw new BoardError("cardIds 必须是字符串数组");
  }
  return body.cardIds;
}

export function mountBoardRoutes(app: Express, wrap: Wrap): void {
  app.get("/api/boards", wrap(async (_req, res) => {
    res.json(getBoards());
  }));

  app.post("/api/boards", wrap(async (req, res) => {
    try {
      res.status(201).json(createBoard(req.body?.name));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.patch("/api/boards/:id", wrap(async (req, res) => {
    try {
      res.json(renameBoard(req.params.id, req.body?.name));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/boards/:id", wrap(async (req, res) => {
    try {
      removeBoard(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/boards/:id/cards", wrap(async (req, res) => {
    try {
      res.json(getCards(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/boards/:id/cards", wrap(async (req, res) => {
    try {
      const body = req.body || {};
      if (body.kind === "note" || (body.url === undefined && body.kind !== "link")) {
        res.status(201).json(addNoteCard(req.params.id, body));
        return;
      }
      res.status(201).json(addLinkCard(req.params.id, body.url, body));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.patch("/api/boards/:id/cards/:cardId", wrap(async (req, res) => {
    try {
      res.json(editCard(req.params.id, req.params.cardId, req.body || {}));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/boards/:id/cards/:cardId/retry", wrap(async (req, res) => {
    try {
      res.json(retryCard(req.params.id, req.params.cardId));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/boards/:id/cards/:cardId", wrap(async (req, res) => {
    try {
      removeCard(req.params.id, req.params.cardId);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/boards/:id/sessions", wrap(async (req, res) => {
    try {
      res.json(listSessions(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/boards/:id/sessions", wrap(async (req, res) => {
    try {
      res.status(201).json(createSession(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/boards/:id/sessions/:sessionId", wrap(async (req, res) => {
    try {
      removeSession(req.params.id, req.params.sessionId);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));

  app.get("/api/boards/:id/sessions/:sessionId/messages", wrap(async (req, res) => {
    try {
      res.json(listMessages(req.params.id, req.params.sessionId));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/boards/:id/sessions/:sessionId/messages", wrap(async (req, res) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      res.status(201).json(await askBoard(req.params.id, req.params.sessionId, content, cardIds(req.body)));
    } catch (error) {
      fail(res, error);
    }
  }));
}
