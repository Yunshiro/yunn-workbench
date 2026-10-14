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
  const { screenToFlowPosition, setCenter, fitView } = useReactFlow();
  const draggingRef = useRef<string | null>(null);
  const nodesRef = useRef(nodes);
  const fitted = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  nodesRef.current = nodes;

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
    if (noteRequest === seenNoteRequest.current) return;
    seenNoteRequest.current = noteRequest;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const position = bounds
      ? screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 120, y: 120 };
    onCreateNoteRef.current(position);
  }, [noteRequest, screenToFlowPosition]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
      const link = findBoardLink(event.clipboardData?.getData("text") || "");
      if (!link) return;
      event.preventDefault();
      const bounds = canvasRef.current?.getBoundingClientRect();
      const position = bounds
        ? screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
        : { x: 120, y: 120 };
      onCreateLinkRef.current(link, position);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition]);

  const actions = useMemo(() => ({ highlightId, onDelete, onRetry, onSaveBody }), [highlightId, onDelete, onRetry, onSaveBody]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest(".react-flow__node, .react-flow__controls, .react-flow__attribution, button, a, textarea, input")) return;
    if (!canvasRef.current?.contains(target)) return;
    onCreateNoteRef.current(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [screenToFlowPosition]);

  return (
    <BoardActionsContext.Provider value={actions}>
      <div className="board__canvas" ref={canvasRef} onDoubleClick={handleDoubleClick}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
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
