import React from "react";

export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  confirmVariant?: "primary" | "danger";
  isExecuting?: boolean;
  executingText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  confirmText = "Confirm",
  confirmVariant = "primary",
  isExecuting = false,
  executingText = "Processing...",
  onConfirm,
  onCancel,
}) => {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        padding: "20px",
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: "460px",
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          padding: "20px 24px",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          margin: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>
          {title}
        </div>
        <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
          <button
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isExecuting}
            style={{ padding: "6px 14px", fontSize: "0.85rem" }}
          >
            Cancel
          </button>
          <button
            className={`btn ${confirmVariant === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={isExecuting}
            style={{ padding: "6px 16px", fontSize: "0.85rem" }}
          >
            {isExecuting ? executingText : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
