"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type Phase = "move-in" | "move-out";
type MainTab = "checklist" | "lease";

type ChecklistPhoto = {
  id: string;
  phase: Phase;
  kind: "image" | "video";
  dataUrl: string;
  addedAt: string; // ISO timestamp
  /**
   * Human-friendly label (what the UI shows) captured at the time the photo was taken.
   * This is used both in the interface and when rendering the PDF so they always match.
   */
  capturedLabel?: string;
};

type ChecklistItem = {
  id: string;
  label: string;
  notes?: string;
  moveInPhotos: ChecklistPhoto[];
  moveOutPhotos: ChecklistPhoto[];
};

type ChecklistState = {
  checklistImageName?: string;
  items: ChecklistItem[];
  moveInDate?: string; // ISO date string (YYYY-MM-DD)
  moveOutDate?: string; // ISO date string (YYYY-MM-DD), used for move-out photo window
  submittedAt?: string;
};

type LeaseAnalysis = {
  summary?: string;
  keyClauses?: string[];
  hiddenFees?: string[];
  tenantRisks?: string[];
  recommendations?: string[];
  questionsForLandlord?: string[];
};

const STORAGE_KEY = "ultimate-rent-consultant/checklist-v1";

function createId() {
  return Math.random().toString(36).slice(2);
}

function splitLabelAndCategory(raw: string): {
  baseLabel: string;
  category?: string;
} {
  const trimmed = raw.trim();
  // Detect trailing [Category] or (Category)
  const match = trimmed.match(/^(.*?)[\s\-–|]*[\(\[]\s*(.+?)\s*[\)\]]\s*$/);
  if (!match) {
    return { baseLabel: trimmed };
  }
  const baseLabel = match[1].trim();
  const category = match[2].trim();
  if (!category) {
    return { baseLabel: trimmed };
  }
  return { baseLabel: baseLabel || trimmed, category };
}

function formatDateTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dataUrlToBytes(dataUrl: string): {
  mimeType: string;
  bytes: Uint8Array;
} {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/^data:(.*?);base64$/);
  const mimeType = mimeMatch?.[1] || "application/octet-stream";
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { mimeType, bytes };
}

async function fileToDataUrl(
  file: File,
  normalizeToJpeg = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const originalDataUrl = reader.result as string;

      // If normalization is not requested, return the raw data URL
      if (!normalizeToJpeg) {
        resolve(originalDataUrl);
        return;
      }

      // Normalize to a real JPEG using a canvas, so pdf-lib can always embed it
      try {
        const img = new window.Image();
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              console.error(
                "Canvas 2D context unavailable; falling back to original data URL"
              );
              resolve(originalDataUrl);
              return;
            }
            ctx.drawImage(img, 0, 0);
            const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.9);
            resolve(jpegDataUrl);
          } catch (err) {
            console.error(
              "Failed to normalize image to JPEG; falling back to original data URL",
              err
            );
            resolve(originalDataUrl);
          }
        };
        img.onerror = (err: any) => {
          console.error(
            "Failed to load image for JPEG normalization; falling back to original data URL",
            err
          );
          resolve(originalDataUrl);
        };
        img.src = originalDataUrl;
      } catch (err: any) {
        console.error(
          "Unexpected error during JPEG normalization; falling back to original data URL",
          err
        );
        resolve(originalDataUrl);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  // Step 1: upload checklist photo
  // Step 2: review checklist, edit items, add notes & photos (combined)
  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<MainTab>("checklist");
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [checklistImagePreview, setChecklistImagePreview] =
    useState<string | null>(null);
  const [state, setState] = useState<ChecklistState>({
    items: [],
    moveInDate: new Date().toISOString().slice(0, 10),
    moveOutDate: undefined,
  });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [lightboxMedia, setLightboxMedia] = useState<{
    url: string;
    kind: "image" | "video";
    title?: string;
  } | null>(null);
  const [leaseFileName, setLeaseFileName] = useState<string | null>(null);
  const [leaseAnalysis, setLeaseAnalysis] = useState<LeaseAnalysis | null>(
    null
  );
  const [leaseIsAnalyzing, setLeaseIsAnalyzing] = useState(false);
  const [leaseError, setLeaseError] = useState<string | null>(null);

  const hasAnyMoveInPhoto = useMemo(
    () =>
      state.items.some((item) => item.moveInPhotos && item.moveInPhotos.length),
    [state.items]
  );

  // Load from localStorage on first client render
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as ChecklistState;
      setState({
        checklistImageName: saved.checklistImageName,
        items: saved.items ?? [],
        moveInDate:
          saved.moveInDate && saved.moveInDate.length > 0
            ? saved.moveInDate
            : new Date().toISOString().slice(0, 10),
        moveOutDate: saved.moveOutDate,
        submittedAt: saved.submittedAt,
      });
      if (saved.items?.length) {
        setSelectedItemId(saved.items[0].id);
        setStep(2); // jump straight to combined review step if data exists
      }
    } catch {
      // ignore corrupt data
    }
  }, []);

  // Persist to localStorage whenever state changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota errors
    }
  }, [state]);

  const selectedItem = useMemo(
    () => state.items.find((i) => i.id === selectedItemId) ?? null,
    [state.items, selectedItemId]
  );

  const { groupedItems, hasCategories } = useMemo(() => {
    type Group = { categoryLabel: string | null; items: ChecklistItem[] };
    const groups = new Map<string, Group>();
    let foundCategory = false;

    for (const item of state.items) {
      const { baseLabel, category } = splitLabelAndCategory(item.label);
      const key = (category || "").toLowerCase();
      const existing = groups.get(key);
      const group: Group =
        existing ?? { categoryLabel: category || null, items: [] };
      group.items.push({ ...item, label: baseLabel });
      groups.set(key, group);
      if (category && category.trim().length > 0) {
        foundCategory = true;
      }
    }

    return {
      groupedItems: Array.from(groups.values()),
      hasCategories: foundCategory,
    };
  }, [state.items]);

  // Move-in photo edit window: 7 days after move-in date
  const isWithinMoveInEditWindow = useMemo(() => {
    if (!state.moveInDate) return true;
    const moveIn = new Date(state.moveInDate);
    if (Number.isNaN(moveIn.getTime())) return true;
    const now = new Date();
    const diffMs = now.getTime() - moveIn.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= 7 + 1e-6;
  }, [state.moveInDate]);

  // Move-in photo edit deadline label
  const moveInPhotoEditDeadline = useMemo(() => {
    if (!state.moveInDate) return null;
    const d = new Date(state.moveInDate);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + 7);
    return d;
  }, [state.moveInDate]);

  // Move-out photo window: only within 7 days BEFORE the move-out / lease end date
  const isWithinMoveOutWindow = useMemo(() => {
    if (!state.moveOutDate) return false;
    const moveOut = new Date(state.moveOutDate);
    if (Number.isNaN(moveOut.getTime())) return false;
    const now = new Date();
    const diffMs = moveOut.getTime() - now.getTime(); // time until move-out
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // Allow window only in the last 7 days before (and including) move-out date
    return diffDays >= 0 && diffDays <= 7 + 1e-6;
  }, [state.moveOutDate]);

  const moveOutWindowStart = useMemo(() => {
    if (!state.moveOutDate) return null;
    const d = new Date(state.moveOutDate);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() - 7);
    return d;
  }, [state.moveOutDate]);

  const isEditable = isWithinMoveInEditWindow;

  async function handleSubmitReport() {
    if (!hasAnyMoveInPhoto) {
      window.alert(
        "Please capture at least one move-in photo before submitting your inspection report."
      );
      return;
    }
    try {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const margin = 40;
      const pageWidth = 595.28; // A4 width
      const pageHeight = 841.89; // A4 height

      let page = pdfDoc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - margin;

      const drawText = (
        text: string,
        size: number,
        color = rgb(0, 0, 0),
        bold = false
      ) => {
        const lines = text.split("\n");
        for (const line of lines) {
          const textWidth = (bold ? fontBold : font).widthOfTextAtSize(
            line,
            size
          );
          if (y < margin + size) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          page.drawText(line, {
            x: margin,
            y,
            size,
            font: bold ? fontBold : font,
            color,
          });
          y -= size + 4;
        }
      };

      // Header
      drawText("Move-in / Move-out Inspection Report", 16, rgb(0.1, 0.1, 0.1), true);
      const moveInLabel = state.moveInDate
        ? new Date(state.moveInDate).toLocaleDateString()
        : "Not set";
      drawText(`Move-in date: ${moveInLabel}`, 10, rgb(0.2, 0.2, 0.2));
      const submittedLabel = new Date().toLocaleString();
      drawText(`Generated at: ${submittedLabel}`, 10, rgb(0.2, 0.2, 0.2));
      y -= 6;

      // Group items by category.
      type Group = { categoryLabel: string | null; items: ChecklistItem[] };
      const groups = new Map<string, Group>();
      for (const item of state.items) {
        const { baseLabel, category } = splitLabelAndCategory(item.label);
        const key = (category || "").toLowerCase();
        const existing = groups.get(key);
        const group: Group =
          existing ?? { categoryLabel: category || null, items: [] };
        group.items.push({ ...item, label: baseLabel });
        groups.set(key, group);
      }

      const embedPhoto = async (photo: ChecklistPhoto, maxWidth = 180) => {
        if (photo.kind === "video") {
          // Just note that a video exists.
          drawText("[Video attached]", 9, rgb(0.3, 0.3, 0.3));
          return;
        }

        const label =
          photo.capturedLabel && photo.capturedLabel.trim().length > 0
            ? photo.capturedLabel
            : photo.addedAt && photo.addedAt.trim().length > 0
            ? formatDateTimeLabel(photo.addedAt)
            : "Capture time unavailable";

        console.log("📸 PDF embedding photo:", {
          id: photo.id,
          capturedLabel: photo.capturedLabel,
          addedAt: photo.addedAt,
          computedLabel: label,
        });

        // 1) Embed and draw the image
        try {
          const { mimeType, bytes } = dataUrlToBytes(photo.dataUrl);
          const isPng = mimeType.includes("png");
          const image = isPng
            ? await pdfDoc.embedPng(bytes)
            : await pdfDoc.embedJpg(bytes);
          const scale = maxWidth / image.width;
          const imgWidth = image.width * scale;
          const imgHeight = image.height * scale;
          if (y < margin + imgHeight + 20) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          page.drawImage(image, {
            x: margin,
            y: y - imgHeight,
            width: imgWidth,
            height: imgHeight,
          });
          y -= imgHeight + 4;
          console.log("✅ Image embedded successfully, drawing timestamp...");
        } catch (err) {
          console.error("❌ Failed to embed image into PDF:", err);
          drawText("[Image could not be embedded]", 9, rgb(0.8, 0.2, 0.2));
          return; // don't try to draw a timestamp if the image failed
        }

        // 2) Draw the timestamp separately so it can't trigger the image error
        try {
          drawText(`Captured: ${label}`, 8, rgb(0.4, 0.4, 0.4));
          console.log("✅ Timestamp drawn:", label);
        } catch (err) {
          console.error("❌ Failed to draw image timestamp in PDF:", err);
        }
      };

      for (const group of groups.values()) {
        y -= 8;
        if (y < margin + 40) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        if (group.categoryLabel) {
          drawText(group.categoryLabel, 13, rgb(0.1, 0.1, 0.4), true);
        } else {
          drawText("General", 13, rgb(0.1, 0.1, 0.4), true);
        }
        y -= 4;

        for (const item of group.items) {
          if (y < margin + 80) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          drawText(`• ${item.label}`, 11, rgb(0, 0, 0), true);
          if (item.notes && item.notes.trim().length > 0) {
            drawText(`Notes: ${item.notes.trim()}`, 9, rgb(0.2, 0.2, 0.2));
          }

          if (item.moveInPhotos.length) {
            drawText("Move-in photos:", 9, rgb(0.15, 0.5, 0.2), true);
            for (const photo of item.moveInPhotos) {
              await embedPhoto(photo);
            }
          }

          if (item.moveOutPhotos.length) {
            drawText("Move-out photos:", 9, rgb(0.1, 0.3, 0.6), true);
            for (const photo of item.moveOutPhotos) {
              await embedPhoto(photo);
            }
          }

          y -= 4;
        }
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "inspection-report.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setState((prev) => ({
        ...prev,
        submittedAt: new Date().toISOString(),
      }));
    } catch (err: any) {
      console.error("❌ Failed to generate PDF report:", err);
      window.alert(
        "Failed to generate the PDF report. Please try again or refresh the page."
      );
    }
  }

  async function handleChecklistImageChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    if (!file) return;

    setParseError(null);
    setChecklistImagePreview(URL.createObjectURL(file));
    setIsParsing(true);

    try {
      const formData = new FormData();
      formData.append("image", file);

      const res = await fetch("/api/parse-checklist", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json();
        console.error('❌ API Error:', errorData);
        throw new Error(errorData.error || "Failed to parse checklist image");
      }

      const data: { items?: string[]; error?: string; details?: string } = await res.json();
      
      if (data.error) {
        console.error('❌ API returned error:', data);
        throw new Error(data.error + (data.details ? `\n\nDetails: ${data.details}` : ''));
      }

      const parsedItems = (data.items ?? []).filter(
        (item) => typeof item === 'string' && item.trim().length > 0
      );

      if (!parsedItems.length) {
        throw new Error("No checklist items found in the image. Please try a different image with clear text.");
      }

      const checklistItems: ChecklistItem[] = parsedItems.map((item) => ({
        id: createId(),
        label: item.trim(),
        notes: "",
        moveInPhotos: [],
        moveOutPhotos: [],
      }));

      setState((prev) => ({
        ...prev,
        checklistImageName: file.name,
        items: checklistItems,
      }));
      setSelectedItemId(checklistItems[0]?.id ?? null);
      setStep(2);
    } catch (err: any) {
      console.error('❌ Frontend error:', err);
      setParseError(
        err?.message || "Something went wrong while reading the checklist photo."
      );
    } finally {
      setIsParsing(false);
    }
  }

  async function handleLeaseUpload(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLeaseError(null);
    setLeaseAnalysis(null);
    setLeaseFileName(file.name);
    setLeaseIsAnalyzing(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/analyze-lease", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        console.error("❌ Lease API error:", data);
        throw new Error(
          data.error ||
            "Failed to analyze lease. Please try again with a different file."
        );
      }

      setLeaseAnalysis(data as LeaseAnalysis);
    } catch (err: any) {
      console.error("❌ Lease analysis error:", err);
      setLeaseError(
        err?.message ||
          "Something went wrong while analyzing the lease. Please try again."
      );
    } finally {
      setLeaseIsAnalyzing(false);
    }
  }

  function updateItem(id: string, updates: Partial<ChecklistItem>) {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    }));
  }

  function addEmptyItem() {
    const newItem: ChecklistItem = {
      id: createId(),
      label: "New item",
      notes: "",
      moveInPhotos: [],
      moveOutPhotos: [],
    };
    setState((prev) => ({
      ...prev,
      items: [...prev.items, newItem],
    }));
    setSelectedItemId(newItem.id);
  }

  function removeItem(id: string) {
    setState((prev) => {
      const remaining = prev.items.filter((i) => i.id !== id);
      return { ...prev, items: remaining };
    });
    setSelectedItemId((current) =>
      current === id ? state.items.find((i) => i.id !== id)?.id ?? null : current
    );
  }

  async function handleAddPhotos(
    itemId: string,
    phase: Phase,
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    // Enforce max 3 photos per item per phase (move-in / move-out)
    const target = state.items.find((i) => i.id === itemId);
    if (!target) return;
    const existingCount =
      phase === "move-in"
        ? target.moveInPhotos.length
        : target.moveOutPhotos.length;
    const remainingSlots = Math.max(0, 3 - existingCount);
    if (remainingSlots <= 0) {
      window.alert(
        "You can attach up to 3 photos for move-in and 3 photos for move-out per checklist item."
      );
      return;
    }

    const filesToUse = files.slice(0, remainingSlots);

    const photos: ChecklistPhoto[] = [];
    for (const file of filesToUse) {
      const kind: "image" | "video" =
        file.type && file.type.startsWith("video/") ? "video" : "image";

      // For images, normalize to JPEG so pdf-lib can always embed them reliably.
      // For videos, keep the original data URL.
      const dataUrl = await fileToDataUrl(file, kind === "image");

      const addedAt = new Date().toISOString();
      const capturedLabel = formatDateTimeLabel(addedAt);

      photos.push({
        id: createId(),
        phase,
        kind,
        dataUrl,
        addedAt,
        capturedLabel,
      });
    }

    setState((prev) => ({
      ...prev,
      items: prev.items.map((item) => {
        if (item.id !== itemId) return item;
        if (phase === "move-in") {
          return {
            ...item,
            moveInPhotos: [...item.moveInPhotos, ...photos],
          };
        }
        return {
          ...item,
          moveOutPhotos: [...item.moveOutPhotos, ...photos],
        };
      }),
    }));
  }

  function clearAllData() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setState({
      items: [],
      checklistImageName: undefined,
      moveInDate: new Date().toISOString().slice(0, 10),
      submittedAt: undefined,
    });
    setChecklistImagePreview(null);
    setSelectedItemId(null);
    setStep(1);
    setParseError(null);
    // Reset lease advisor state for demo
    setLeaseFileName(null);
    setLeaseAnalysis(null);
    setLeaseError(null);
    setLeaseIsAnalyzing(false);
    setTab("checklist");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 page-fade-in">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6 md:gap-8 md:px-8 md:py-10">
        <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="relative h-11 w-11 md:h-16 md:w-16">
        <Image
                src="/clearmove-logo.jpeg"
                alt="ClearMove logo"
                fill
                className="rounded-lg object-contain"
          priority
        />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
              ClearMove
          </h1>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-col items-end gap-1 text-[11px] md:text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-700">Move-in date</span>
                <input
                  type="date"
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-slate-500 focus:ring-0"
                  value={state.moveInDate ?? ""}
                  onChange={(e) =>
                    setState((prev) => ({
                      ...prev,
                      moveInDate: e.target.value || undefined,
                    }))
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-700">
                  Move-out / lease end date
                </span>
                <input
                  type="date"
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-slate-500 focus:ring-0"
                  value={state.moveOutDate ?? ""}
                  onChange={(e) =>
                    setState((prev) => ({
                      ...prev,
                      moveOutDate: e.target.value || undefined,
                    }))
                  }
                />
              </div>
            </div>
            <button
              type="button"
              onClick={clearAllData}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-100 md:px-4 md:py-2"
            >
              Reset demo
            </button>
          </div>
        </header>

        {/* Main tabs */}
        <div className="mt-2 flex gap-2 rounded-full bg-slate-100 p-1 text-[11px] md:text-xs">
          <button
            type="button"
            onClick={() => setTab("checklist")}
            className={`flex-1 rounded-full px-3 py-1.5 font-medium ${
              tab === "checklist"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Checklist & Photos
          </button>
          <button
            type="button"
            onClick={() => setTab("lease")}
            className={`flex-1 rounded-full px-3 py-1.5 font-medium ${
              tab === "lease"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Lease Advisor
          </button>
        </div>

        {tab === "checklist" && (
          <div className="flex flex-col gap-4 md:gap-6">
            {/* Stepper */}
            <ol className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-600 md:gap-2 md:text-sm">
              <li
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 md:gap-2 md:px-3 ${
                  step === 1 ? "bg-slate-900 text-white" : "bg-white"
                }`}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px] md:h-5 md:w-5 md:text-[10px]">
                  1
                </span>
                <span className="hidden sm:inline">Upload checklist photo</span>
                <span className="sm:hidden">Upload</span>
              </li>
              <span className="text-slate-400">→</span>
              <li
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 md:gap-2 md:px-3 ${
                  step === 2 ? "bg-slate-900 text-white" : "bg-white"
                }`}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px] md:h-5 md:w-5 md:text-[10px]">
                  2
                </span>
                <span className="hidden sm:inline">Review checklist & photos</span>
                <span className="sm:hidden">Review</span>
              </li>
            </ol>

            <div className="grid gap-4 md:grid-cols-2">
              {/* Step 1: upload checklist photo + preview */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold text-slate-900 md:text-base">
                      1. Upload the paper checklist photo
                    </h2>
                    <p className="mt-1 text-xs text-slate-600 md:text-sm">
                      Take a clear photo of the checklist you received from your
                      landlord or building manager.
          </p>
        </div>
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 sm:flex-shrink-0">
                    <span>{isParsing ? "Reading..." : "Choose photo"}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleChecklistImageChange}
                    />
                  </label>
                </div>
                {parseError && (
                  <p className="mt-3 text-xs text-red-600">{parseError}</p>
                )}
                {state.items.length > 0 && (
                  <p className="mt-3 text-xs text-emerald-700">
                    Found{" "}
                    <span className="font-semibold">
                      {state.items.length} checklist items
                    </span>
                    . You can rename or add more in step 2.
                  </p>
                )}
                <div className="mt-3 flex items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
                  {checklistImagePreview ? (
                    <img
                      src={checklistImagePreview}
                      alt="Checklist preview"
                      className="max-h-48 w-full rounded-lg object-contain md:max-h-64"
                    />
                  ) : state.checklistImageName ? (
                    <p className="text-xs text-slate-500">
                      Checklist:{" "}
                      <span className="font-medium">
                        {state.checklistImageName}
                      </span>
                      . Refresh to re-upload if you want to change it.
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500">
                      No photo yet. Upload your paper checklist above.
                    </p>
                  )}
                </div>
              </div>

              {/* Step 2: editable checklist + photos */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                <div className="flex-1">
                  <h2 className="text-sm font-semibold text-slate-900 md:text-base">
                    2. Tidy your checklist & attach photos
                  </h2>
                  <p className="mt-1 text-xs text-slate-600 md:text-sm">
                    Rename items so they match how you think about the space and
                    capture move-in / move-out photos for each area.
                  </p>
                </div>
                  {isEditable && (
                    <button
                      type="button"
                      onClick={addEmptyItem}
                      className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 sm:flex-shrink-0"
                    >
                      + Add item
                    </button>
                  )}
                </div>
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <p className="font-semibold">Photo windows for fairness</p>
                <p className="mt-0.5">
                  <span className="font-semibold">Move-in photos</span> can be
                  added, replaced, or deleted only within{" "}
                  <span className="font-semibold">7 days after the move-in date</span>.{" "}
                  <span className="font-semibold">Move-out photos</span> can be
                  taken only during the{" "}
                  <span className="font-semibold">
                    7 days leading up to your move-out / lease end date
                  </span>
                  .
                  {moveInPhotoEditDeadline && (
                    <>
                      {" "}
                      Move-in edit deadline:{" "}
                      <span className="font-semibold">
                        {moveInPhotoEditDeadline.toLocaleDateString()}
                      </span>
                      .
                    </>
                  )}
                  {state.moveOutDate && moveOutWindowStart && (
                    <>
                      {" "}
                      Move-out photo window:{" "}
                      <span className="font-semibold">
                        {moveOutWindowStart.toLocaleDateString()} –{" "}
                        {new Date(state.moveOutDate).toLocaleDateString()}
                      </span>
                      .
                    </>
                  )}
                </p>
                </div>

              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-600">
                  {state.submittedAt ? (
                    <>
                      Last report generated:{" "}
                      <span className="font-medium">
                        {formatDateTimeLabel(state.submittedAt)}
                      </span>
                    </>
                  ) : (
                    "Generate a PDF report once you capture at least one move-in photo."
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSubmitReport}
                  disabled={!hasAnyMoveInPhoto}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-sm ${
                    hasAnyMoveInPhoto
                      ? "bg-slate-900 text-white hover:bg-slate-800"
                      : "cursor-not-allowed bg-slate-200 text-slate-500"
                  }`}
                >
                  Download PDF report
                </button>
              </div>

                {state.items.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Upload a checklist photo above, or add items manually to get
                  started.
                </p>
                ) : (
                <div className="flex max-h-64 flex-col gap-3 overflow-y-auto pr-1 text-sm">
                  {hasCategories ? (
                    // Grouped by category (when Gemini detected categories)
                    groupedItems.map((group) => (
                      <div
                        key={group.categoryLabel || "uncategorized"}
                        className="rounded-xl border border-slate-200 bg-slate-50"
                      >
                        {group.categoryLabel && (
                          <div className="border-b border-slate-200 bg-slate-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                            {group.categoryLabel}
                          </div>
                        )}
                        <ul className="flex flex-col gap-1.5 px-3 py-2">
                          {group.items.map((item, index) => (
                            <li
                              key={item.id}
                              className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                                item.id === selectedItemId
                                  ? "border-slate-900 bg-slate-50"
                                  : "border-slate-200 bg-white"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedItemId(item.id);
                          setStep(2);
                                }}
                                className="mt-1 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-slate-400 text-[11px] font-medium text-slate-700"
                              >
                                {/* Local index within group */}
                                {index + 1}
                              </button>
                              <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <input
                                  disabled={!isEditable}
                                  className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400 focus:ring-0 disabled:cursor-not-allowed disabled:bg-slate-100"
                                  value={item.label}
                                  onChange={(e) =>
                                    updateItem(item.id, {
                                      label: e.target.value,
                                    })
                                  }
                                />
                                <textarea
                                  disabled={!isEditable}
                                  placeholder="Notes (e.g. already scratched when you moved in)"
                                  className="w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-slate-400 focus:ring-0 disabled:cursor-not-allowed disabled:bg-slate-100"
                                  rows={2}
                                  value={item.notes ?? ""}
                                  onChange={(e) =>
                                    updateItem(item.id, {
                                      notes: e.target.value,
                                    })
                                  }
                                />
                                {/* Inline photos for this checklist item */}
                                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                  {/* Move-in */}
                                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                      <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                                          Move-in
                                        </p>
                                      </div>
                                      {isWithinMoveInEditWindow ? (
                                        <label className="inline-flex cursor-pointer items-center justify-center rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-800">
                                          Take photo / video
                                          <input
                                            type="file"
                                            accept="image/*,video/*"
                                            capture="environment"
                                            className="hidden"
                                            onChange={(e) =>
                                              handleAddPhotos(
                                                item.id,
                                                "move-in",
                                                e
                                              )
                                            }
                                          />
                                        </label>
                                      ) : (
                                        <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-medium text-slate-500">
                                          Locked
                                        </span>
                                      )}
                                    </div>
                                    {item.moveInPhotos.length === 0 ? (
                                      <p className="text-[10px] text-slate-500">
                                        No move-in photos yet.
                                      </p>
                                    ) : (
                                      <div className="grid grid-cols-3 gap-1.5">
                                        {item.moveInPhotos.map((photo) => (
                                          <figure
                                            key={photo.id}
                                            className="relative overflow-hidden rounded border border-slate-200 bg-white"
                                          >
                                            {photo.kind === "video" ? (
                                              <video
                                                src={photo.dataUrl}
                                                className="h-12 w-full object-cover"
                                                controls
                                                muted
                                              />
                                            ) : (
                                              <img
                                                src={photo.dataUrl}
                                                alt="Move-in"
                                                className="h-12 w-full object-cover cursor-pointer"
                                                onClick={() =>
                                                  setLightboxMedia({
                                                    url: photo.dataUrl,
                                                    kind: "image",
                                                    title: "Move-in",
                                                  })
                                                }
                                              />
                                            )}
                                            <figcaption className="px-1 pb-1 text-[9px] text-slate-500">
                                              {photo.capturedLabel ??
                                                formatDateTimeLabel(
                                                  photo.addedAt
                                                )}
                                            </figcaption>
                                            {isWithinMoveInEditWindow && (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setState((prev) => ({
                                                    ...prev,
                                                    items: prev.items.map(
                                                      (pItem) =>
                                                        pItem.id === item.id
                                                          ? {
                                                              ...pItem,
                                                              moveInPhotos:
                                                                pItem.moveInPhotos.filter(
                                                                  (p) =>
                                                                    p.id !==
                                                                    photo.id
                                                                ),
                                                            }
                                                          : pItem
                                                    ),
                                                  }));
                                                }}
                                            className="absolute right-0 top-0 m-0.5 rounded-full bg-white/80 px-1 text-[9px] text-slate-600 hover:bg-red-500 hover:text-white"
                                              >
                                                ✕
                                              </button>
                                            )}
                                          </figure>
                                        ))}
        </div>
                                    )}
                                  </div>
                                  {/* Move-out */}
                                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                    <div className="mb-1 flex items-center justify-between gap-2">
                                      <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                                          Move-out
                                        </p>
                                      </div>
                                      {isWithinMoveOutWindow ? (
                                        <label className="inline-flex cursor-pointer items-center justify-center rounded-full bg-sky-700 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-sky-800">
                                          Take photo / video
                                          <input
                                            type="file"
                                            accept="image/*,video/*"
                                            capture="environment"
                                            className="hidden"
                                            onChange={(e) =>
                                              handleAddPhotos(
                                                item.id,
                                                "move-out",
                                                e
                                              )
                                            }
                                          />
                                        </label>
                                      ) : (
                                        <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-medium text-slate-500">
                                          Locked
                                        </span>
                                      )}
                                    </div>
                                    {item.moveOutPhotos.length === 0 ? (
                                      <p className="text-[10px] text-slate-500">
                                        No move-out photos yet.
                                      </p>
                                    ) : (
                                      <div className="grid grid-cols-3 gap-1.5">
                                        {item.moveOutPhotos.map((photo) => (
                                      <figure
                                        key={photo.id}
                                        className="relative overflow-hidden rounded border border-slate-200 bg-white"
            >
                                        {photo.kind === "video" ? (
                                          <video
                                            src={photo.dataUrl}
                                            className="h-12 w-full object-cover"
                                            controls
                                            muted
                                          />
                                        ) : (
                                          <img
                                            src={photo.dataUrl}
                                            alt="Move-out"
                                            className="h-12 w-full object-cover cursor-pointer"
                                            onClick={() =>
                                              setLightboxMedia({
                                                url: photo.dataUrl,
                                                kind: "image",
                                                title: "Move-out",
                                              })
                                            }
                                          />
                                        )}
                                            <figcaption className="px-1 pb-1 text-[9px] text-slate-500">
                                              {photo.capturedLabel ??
                                                formatDateTimeLabel(
                                                  photo.addedAt
                                                )}
                                            </figcaption>
                                            {isWithinMoveOutWindow && (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setState((prev) => ({
                                                    ...prev,
                                                    items: prev.items.map(
                                                      (pItem) =>
                                                        pItem.id === item.id
                                                          ? {
                                                              ...pItem,
                                                              moveOutPhotos:
                                                                pItem.moveOutPhotos.filter(
                                                                  (p) =>
                                                                    p.id !==
                                                                    photo.id
                                                                ),
                                                            }
                                                          : pItem
                                                    ),
                                                  }));
                                                }}
                                                className="absolute right-0 top-0 m-0.5 rounded-full bg-white/80 px-1 text-[9px] text-slate-600 hover:bg-red-500 hover:text-white"
                                              >
                                                ✕
                                              </button>
                                            )}
                                          </figure>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                              {isEditable && (
                                <button
                                  type="button"
                                  onClick={() => removeItem(item.id)}
                                  className="mt-1 text-xs text-slate-400 hover:text-red-500"
                                  aria-label="Remove item"
                                >
                                  ✕
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  ) : (
                    // Flat list (no categories detected)
                    <ul className="flex flex-col gap-2">
                      {state.items.map((item, index) => (
                        <li
                          key={item.id}
                          className={`flex items-start gap-2 rounded-xl border px-3 py-2 ${
                            item.id === selectedItemId
                              ? "border-slate-900 bg-slate-50"
                              : "border-slate-200 bg-white"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedItemId(item.id);
                              setStep(2);
                            }}
                            className="mt-1 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-slate-400 text-[11px] font-medium text-slate-700"
                          >
                            {index + 1}
                          </button>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <input
                              className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400 focus:ring-0"
                              value={item.label}
                              onChange={(e) =>
                                updateItem(item.id, { label: e.target.value })
                              }
                            />
                            <textarea
                              placeholder="Notes (e.g. already scratched when you moved in)"
                              className="w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-slate-400 focus:ring-0"
                              rows={2}
                              value={item.notes ?? ""}
                              onChange={(e) =>
                                updateItem(item.id, { notes: e.target.value })
                              }
                            />
                            {/* Inline photos for this checklist item */}
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {/* Move-in */}
                              <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                                      Move-in
                                    </p>
                                  </div>
                                  {isWithinMoveInEditWindow ? (
                                    <label className="inline-flex cursor-pointer items-center justify-center rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-800">
                                      Take photo / video
                                      <input
                                        type="file"
                                        accept="image/*,video/*"
                                        capture="environment"
                                        className="hidden"
                                        onChange={(e) =>
                                          handleAddPhotos(
                                            item.id,
                                            "move-in",
                                            e
                                          )
                                        }
                                      />
                                    </label>
                                  ) : (
                                    <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-medium text-slate-500">
                                      Locked
                                    </span>
                                  )}
                                </div>
                                {item.moveInPhotos.length === 0 ? (
                                  <p className="text-[10px] text-slate-500">
                                    No move-in photos yet.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-3 gap-1.5">
                                    {item.moveInPhotos.map((photo) => (
                                      <figure
                                        key={photo.id}
                                        className="relative overflow-hidden rounded border border-slate-200 bg-white"
                                      >
                                        {photo.kind === "video" ? (
                                          <video
                                            src={photo.dataUrl}
                                            className="h-12 w-full object-cover"
                                            controls
                                            muted
                                          />
                                        ) : (
                                          <img
                                            src={photo.dataUrl}
                                            alt="Move-in"
                                            className="h-12 w-full object-cover cursor-pointer"
                                            onClick={() =>
                                              setLightboxMedia({
                                                url: photo.dataUrl,
                                                kind: "image",
                                                title: "Move-in",
                                              })
                                            }
                                          />
                                        )}
                                        <figcaption className="px-1 pb-1 text-[9px] text-slate-500">
                                          {photo.capturedLabel ??
                                            formatDateTimeLabel(photo.addedAt)}
                                        </figcaption>
                                        {isWithinMoveInEditWindow && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setState((prev) => ({
                                                ...prev,
                                                items: prev.items.map(
                                                  (pItem) =>
                                                    pItem.id === item.id
                                                      ? {
                                                          ...pItem,
                                                          moveInPhotos:
                                                            pItem.moveInPhotos.filter(
                                                              (p) =>
                                                                p.id !==
                                                                photo.id
                                                            ),
                                                        }
                                                      : pItem
                                                ),
                                              }));
                                            }}
                                            className="absolute right-0 top-0 m-0.5 rounded-full bg-white/80 px-1 text-[9px] text-slate-600 hover:bg-red-500 hover:text-white"
                                          >
                                            ✕
                                          </button>
                                        )}
                                      </figure>
                                    ))}
                                  </div>
                                )}
                              </div>
                              {/* Move-out */}
                              <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                                      Move-out
          </p>
        </div>
                                  {isWithinMoveOutWindow ? (
                                    <label className="inline-flex cursor-pointer items-center justify-center rounded-full bg-sky-700 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-sky-800">
                                      Take photo / video
                                      <input
                                        type="file"
                                        accept="image/*,video/*"
                                        capture="environment"
                                        className="hidden"
                                        onChange={(e) =>
                                          handleAddPhotos(
                                            item.id,
                                            "move-out",
                                            e
                                          )
                                        }
                                      />
                                    </label>
                                  ) : (
                                    <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-medium text-slate-500">
                                      Locked
                                    </span>
                                  )}
                                </div>
                                {item.moveOutPhotos.length === 0 ? (
                                  <p className="text-[10px] text-slate-500">
                                    No move-out photos yet.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-3 gap-1.5">
                                    {item.moveOutPhotos.map((photo) => (
                                      <figure
                                        key={photo.id}
                                        className="relative overflow-hidden rounded border border-slate-200 bg-white"
                                      >
                                        {photo.kind === "video" ? (
                                          <video
                                            src={photo.dataUrl}
                                            className="h-12 w-full object-cover"
                                            controls
                                            muted
                                          />
                                        ) : (
                                          <img
                                            src={photo.dataUrl}
                                            alt="Move-out"
                                            className="h-12 w-full object-cover cursor-pointer"
                                            onClick={() =>
                                              setLightboxMedia({
                                                url: photo.dataUrl,
                                                kind: "image",
                                                title: "Move-out",
                                              })
                                            }
                                          />
                                        )}
                                        <figcaption className="px-1 pb-1 text-[9px] text-slate-500">
                                          {photo.capturedLabel ??
                                            formatDateTimeLabel(photo.addedAt)}
                                        </figcaption>
                                        {isWithinMoveOutWindow && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setState((prev) => ({
                                                ...prev,
                                                items: prev.items.map(
                                                  (pItem) =>
                                                    pItem.id === item.id
                                                      ? {
                                                          ...pItem,
                                                          moveOutPhotos:
                                                            pItem.moveOutPhotos.filter(
                                                              (p) =>
                                                                p.id !==
                                                                photo.id
                                                            ),
                                                        }
                                                      : pItem
                                                ),
                                              }));
                                            }}
                                            className="absolute right-0 top-0 m-0.5 rounded-full bg-white/80 px-1 text-[9px] text-slate-600 hover:bg-red-500 hover:text-white"
                                          >
                                            ✕
                                          </button>
                                        )}
                                      </figure>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeItem(item.id)}
                            className="mt-1 text-xs text-slate-400 hover:text-red-500"
                            aria-label="Remove item"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              </div>
            </div>
          </div>
        )}

        {tab === "lease" && (
          <section className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)]">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900 md:text-base">
                Upload your lease (PDF)
              </h2>
              <p className="mt-1 text-xs text-slate-600 md:text-sm">
                We&apos;ll scan your lease and highlight fees, deadlines,
                obligations, and risky clauses in plain language. This is not
                legal advice, but a tenant-friendly summary you can take to a
                lawyer or advisor.
              </p>
              <div className="mt-4 flex flex-col gap-3">
                <label className="inline-flex w-full cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-100 md:text-sm">
                  <div>
                    <p>
                      {leaseFileName
                        ? `Selected: ${leaseFileName}`
                        : "Click to upload your lease PDF"}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Only PDF files are supported. For long leases, analysis
                      may take a few seconds.
                    </p>
                  </div>
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={handleLeaseUpload}
                  />
                </label>

                {leaseIsAnalyzing && (
                  <p className="text-[11px] text-slate-600">
                    Analyzing lease with Gemini... This usually takes 5–10
                    seconds.
                  </p>
                )}
                {leaseError && (
                  <p className="text-[11px] text-red-600">{leaseError}</p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900 md:text-base">
                Lease insights
              </h2>
              {!leaseAnalysis && !leaseIsAnalyzing && (
                <p className="mt-2 text-xs text-slate-500 md:text-sm">
                  Upload your lease PDF on the left to see a summarized analysis
                  here: key clauses, hidden fees, risks, and suggested
                  questions.
                </p>
              )}

              {leaseAnalysis && (
                <div className="mt-3 flex flex-col gap-3 text-xs md:text-sm">
                  {leaseAnalysis.summary && (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                        Summary
                      </h3>
                      <p className="mt-1 text-slate-700">
                        {leaseAnalysis.summary}
                      </p>
                    </div>
                  )}

                  {leaseAnalysis.keyClauses?.length ? (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                        Key clauses
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-700">
                        {leaseAnalysis.keyClauses.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {leaseAnalysis.hiddenFees?.length ? (
                    <div className="rounded-lg bg-amber-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                        Fees & charges to watch
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-900">
                        {leaseAnalysis.hiddenFees.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {leaseAnalysis.tenantRisks?.length ? (
                    <div className="rounded-lg bg-red-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-red-800">
                        Risks for you as tenant
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-red-900">
                        {leaseAnalysis.tenantRisks.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {leaseAnalysis.recommendations?.length ? (
                    <div className="rounded-lg bg-emerald-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                        Recommendations
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-emerald-900">
                        {leaseAnalysis.recommendations.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {leaseAnalysis.questionsForLandlord?.length ? (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                        Questions to ask your landlord
                      </h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-700">
                        {leaseAnalysis.questionsForLandlord.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
        </div>
          </section>
        )}
      </main>
      {lightboxMedia && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-zoom-out"
            onClick={() => setLightboxMedia(null)}
          />
          <div className="relative z-10 max-h-[90vh] w-full max-w-xl rounded-2xl bg-black/90 p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-200">
              <span className="truncate font-medium">
                {lightboxMedia.title ?? "Preview"}
              </span>
              <button
                type="button"
                onClick={() => setLightboxMedia(null)}
                className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-100 hover:bg-white/20"
              >
                Close
              </button>
            </div>
            <div className="flex items-center justify-center">
              {lightboxMedia.kind === "video" ? (
                <video
                  src={lightboxMedia.url}
                  controls
                  autoPlay
                  className="max-h-[75vh] w-full rounded-lg"
                />
              ) : (
                <img
                  src={lightboxMedia.url}
                  alt={lightboxMedia.title ?? "Preview"}
                  className="max-h-[75vh] w-full rounded-lg object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
