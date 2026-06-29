import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { ToastProvider } from "./components/ui/Toast.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
);
