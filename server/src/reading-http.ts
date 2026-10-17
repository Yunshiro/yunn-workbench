import express from "express";
import type { Express, Response } from "express";
import { ReadingError } from "./reading-error.js";
import {
  confirmReading,
  continueReading,
  getReading,
  importEpubBuffer,
  listLibrary,
  mergeReadingChapter,
  removeReading,
  renameReadingChapter,
  reopenReading,
  switchReadingLevel,
  updateReading,
} from "./reading-service.js";

type Wrap = (fn: (req: any, res: Response) => Promise<any> | any) => (req: any, res: Response) => void;

function fail(res: Response, error: unknown): void {
  if (error instanceof ReadingError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  throw error;
}

export function mountReadingRoutes(app: Express, wrap: Wrap): void {
  app.get("/api/books", wrap(async (_req, res) => {
    res.json(listLibrary());
  }));

  app.get("/api/books/:id", wrap(async (req, res) => {
    try {
      res.json(getReading(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books", express.raw({ type: () => true, limit: "80mb" }), wrap(async (req, res) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      res.status(201).json(importEpubBuffer(body));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.patch("/api/books/:id", wrap(async (req, res) => {
    try {
      const bookType = req.body?.bookType;
      res.json(updateReading(req.params.id, {
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        author: typeof req.body?.author === "string" ? req.body.author : undefined,
        bookType: bookType === "fiction" || bookType === "nonfiction" ? bookType : undefined,
        rebuild: req.body?.rebuild === true,
      }));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books/:id/level", wrap(async (req, res) => {
    try {
      res.json(switchReadingLevel(req.params.id, Number(req.body?.level)));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.patch("/api/books/:id/chapters/:chapterId", wrap(async (req, res) => {
    try {
      res.json(renameReadingChapter(req.params.id, req.params.chapterId, String(req.body?.title || "")));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books/:id/chapters/:chapterId/merge", wrap(async (req, res) => {
    try {
      res.json(mergeReadingChapter(req.params.id, req.params.chapterId));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books/:id/confirm", wrap(async (req, res) => {
    try {
      res.json(confirmReading(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books/:id/continue", wrap(async (req, res) => {
    try {
      res.json(continueReading(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.post("/api/books/:id/reopen", wrap(async (req, res) => {
    try {
      res.json(reopenReading(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  }));

  app.delete("/api/books/:id", wrap(async (req, res) => {
    try {
      removeReading(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  }));
}
