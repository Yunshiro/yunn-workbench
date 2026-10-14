import { useCallback, useEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CARD_GAP,
  CARD_MAX_HEIGHT,
  CARD_WIDTH,
  NOTE_HEIGHT,
  centeredCardOrigin,
  findOpenPosition,
  separateOverlaps,
  visibleFlowBounds,
  type CardBox,
  type PlacedCard,
} from "../../../server/src/board-placement.ts";
import BoardCardNodeView, { BoardActionsContext, type BoardCardNodeData } from "./BoardCardNode";
import { findBoardLink } from "../lib/board-link";
import type { BoardCard } from "../lib/types";

const nodeTypes: NodeTypes = { card: BoardCardNodeView };
const edges: Edge[] = [];

interface BoardCanvasProps {
  cards: BoardCard[];
  highlightId: string | null;
  focusNonce: number;
  focusCardId: string | null;
  onCreateLink: (url: string, position: { x: number; y: number }) => void;
  onCreateNote: (position: { x: number; y: number }) => void;
  onMove: (id: string, x: number, y: number) => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onSaveBody: (id: string, body: string) => void;
  onOpen: (card: BoardCard) => void;
  onSelectionChange: (ids: string[]) => void;
  noteRequest: number;
}

function BoardFlow(props: BoardCanvasProps) {
  const {
    cards,
    highlightId,
    focusNonce,
    focusCardId,
    onCreateLink,
    onCreateNote,
    onMove,
    onDelete,
    onRetry,
    onSaveBody,
    onOpen,
    onSelectionChange,
    noteRequest,
  } = props;
  const [nodes, setNodes, onNodesChange] = useNodesState<BoardCardNodeData>([]);
  const { setCenter, fitView, getNodes, getInternalNode, getViewport } = useReactFlow<BoardCardNodeData>();
  const draggingRef = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  const fitted = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reservedRef = useRef<CardBox[]>([]);
  const lastLayout = useRef("");
  const alive = useRef(true);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  nodesRef.current = nodes;

  const flowContainer = useCallback(() => {
    const node = canvasRef.current?.querySelector(".react-flow");
    return node instanceof HTMLElement ? node.getBoundingClientRect() : null;
  }, []);

  const occupiedBoxes = useCallback((): CardBox[] => {
    const boxes = getNodes().map((node) => {
      const internal = getInternalNode(node.id);
      return {
        x: node.position.x,
        y: node.position.y,
        width: internal?.measured.width || node.measured?.width || CARD_WIDTH,
        height: internal?.measured.height || node.measured?.height || CARD_MAX_HEIGHT,
      };
    });
    return boxes.concat(reservedRef.current);
  }, [getInternalNode, getNodes]);

  const placeNearCenter = useCallback((size: { width: number; height: number }) => {
    const rect = flowContainer();
    const viewport = getViewport();
    if (!rect || viewport.zoom <= 0) return { x: 80, y: 80 };
    const container = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const origin = centeredCardOrigin(container, viewport, size);
    return findOpenPosition(origin, occupiedBoxes(), size, CARD_GAP, visibleFlowBounds(container, viewport));
  }, [flowContainer, getViewport, occupiedBoxes]);

  useEffect(() => () => { alive.current = false; }, []);

  const relayout = useCallback(() => {
    if (!alive.current || draggingRef.current) return;
    const boxes: PlacedCard[] = [];
    for (const node of getNodes()) {
      const internal = getInternalNode(node.id);
      const width = internal?.measured.width ?? node.measured?.width;
      const height = internal?.measured.height ?? node.measured?.height;
      if (!width || !height) return;
      boxes.push({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        width,
        height,
        createdAt: node.data.card.createdAt,
      });
    }
    const moves = separateOverlaps(boxes, CARD_GAP);
    const key = moves.map((move) => `${move.id}:${Math.round(move.x)}:${Math.round(move.y)}`).join("|");
    if (key === lastLayout.current) return;
    lastLayout.current = key;
    for (const move of moves) onMoveRef.current(move.id, move.x, move.y);
  }, [getInternalNode, getNodes]);

  useEffect(() => {
    setNodes((current) => cards.map((card) => {
      const existing = current.find((node) => node.id === card.id);
      const dragging = draggingRef.current === card.id;
      return {
        id: card.id,
        type: "card",
        position: dragging && existing ? existing.position : { x: card.x, y: card.y },
        data: { card },
        selected: existing?.selected ?? false,
        draggable: true,
      };
    }));
  }, [cards, setNodes]);

  useEffect(() => {
    if (fitted.current || nodes.length === 0) return;
    fitted.current = true;
    const frame = requestAnimationFrame(() => { fitView({ padding: 0.2, duration: 200 }); });
    return () => cancelAnimationFrame(frame);
  }, [nodes.length, fitView]);

  useEffect(() => {
    if (!focusCardId) return;
    const node = nodesRef.current.find((item) => item.id === focusCardId);
    if (!node) return;
    setCenter(node.position.x + 140, node.position.y + 80, { zoom: 1, duration: 350 });
  }, [focusNonce, focusCardId, setCenter]);

  const onCreateLinkRef = useRef(onCreateLink);
  const onCreateNoteRef = useRef(onCreateNote);
  onCreateLinkRef.current = onCreateLink;
  onCreateNoteRef.current = onCreateNote;
  const seenNoteRequest = useRef(noteRequest);

  useEffect(() => {
    const positions = new Set(cards.map((card) => `${Math.round(card.x)}:${Math.round(card.y)}`));
    reservedRef.current = reservedRef.current.filter((box) => !positions.has(`${Math.round(box.x)}:${Math.round(box.y)}`));
  }, [cards]);

  useEffect(() => {
    if (noteRequest === seenNoteRequest.current) return;
    seenNoteRequest.current = noteRequest;
    const size = { width: CARD_WIDTH, height: NOTE_HEIGHT };
    const position = placeNearCenter(size);
    reservedRef.current.push({ ...position, ...size });
    onCreateNoteRef.current(position);
  }, [noteRequest, placeNearCenter]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
      const link = findBoardLink(event.clipboardData?.getData("text") || "");
      if (!link) return;
      event.preventDefault();
      const size = { width: CARD_WIDTH, height: CARD_MAX_HEIGHT };
      const position = placeNearCenter(size);
      reservedRef.current.push({ ...position, ...size });
      onCreateLinkRef.current(link, position);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [placeNearCenter]);

  const actions = useMemo(() => ({ highlightId, onDelete, onRetry, onSaveBody }), [highlightId, onDelete, onRetry, onSaveBody]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest(".react-flow__node, .react-flow__controls, .react-flow__attribution, button, a, textarea, input")) return;
    if (!canvasRef.current?.contains(target)) return;
    const rect = flowContainer();
    const viewport = getViewport();
    if (!rect || viewport.zoom <= 0) return;
    const container = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const local = {
      x: (event.clientX - container.left - viewport.x) / viewport.zoom,
      y: (event.clientY - container.top - viewport.y) / viewport.zoom,
    };
    const size = { width: CARD_WIDTH, height: NOTE_HEIGHT };
    const position = findOpenPosition(local, occupiedBoxes(), size, CARD_GAP);
    reservedRef.current.push({ ...position, ...size });
    onCreateNoteRef.current(position);
  }, [flowContainer, getViewport, occupiedBoxes]);

  return (
    <BoardActionsContext.Provider value={actions}>
      <div className="board__canvas" ref={canvasRef} onDoubleClick={handleDoubleClick}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(changes) => {
            onNodesChange(changes);
            if (changes.some((change) => change.type === "dimensions")) {
              requestAnimationFrame(() => { if (alive.current) relayout(); });
            }
          }}
          nodeTypes={nodeTypes}
          colorMode="light"
          fitView
          minZoom={0.2}
          maxZoom={2}
          nodesConnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          selectionOnDrag={false}
          panOnScroll={false}
          zoomOnScroll
          multiSelectionKeyCode={["Meta", "Shift", "Control"]}
          proOptions={{ hideAttribution: false }}
          onNodeDragStart={(_event, node) => { draggingRef.current = node.id; }}
          onNodeDragStop={(_event, node) => {
            draggingRef.current = null;
            onMove(node.id, node.position.x, node.position.y);
          }}
          onNodeClick={(event, node) => {
            if ("shiftKey" in event && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
            const target = event.target as HTMLElement;
            if (target.closest("button, a, textarea, input, form")) return;
            onOpen(node.data.card);
          }}
          onSelectionChange={({ nodes: selected }) => onSelectionChange(selected.map((node) => node.id))}
        >
          <Background color="#d8d5cc" gap={20} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </BoardActionsContext.Provider>
  );
}

export default function BoardCanvas(props: BoardCanvasProps) {
  return (
    <ReactFlowProvider>
      <BoardFlow {...props} />
    </ReactFlowProvider>
  );
}
