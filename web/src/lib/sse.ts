import { useEffect, useRef } from "react";

type Handler = (data: any) => void;

const listeners = new Map<string, Set<Handler>>();
let started = false;

const EVENT_TYPES = [
  "hello",
  "task_queued",
  "task_status",
  "task_delta",
  "task_thinking",
  "task_done",
  "task_error",
  "topics_created",
] as const;

/** 全局只建立一条 SSE 连接，组件通过 useEvent 订阅 */
export function startEventStream(): void {
  if (started) return;
  started = true;

  const es = new EventSource("/api/events");
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      let data: any = null;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        /* 非 JSON 载荷 */
      }
      const set = listeners.get(type);
      if (set) for (const handler of set) handler(data);
    });
  }
  // EventSource 会自动重连，无需额外处理
}

export function onEvent(type: string, handler: Handler): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
  };
}

export function useEvent(type: string, handler: Handler): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => onEvent(type, (data) => handlerRef.current(data)), [type]);
}
