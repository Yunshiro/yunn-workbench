import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startEventStream } from "./lib/sse";
import "./styles/global.css";

startEventStream();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
