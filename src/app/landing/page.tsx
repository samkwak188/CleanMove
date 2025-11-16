"use client";

import Image from "next/image";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const rotatingWords = ["CONTRACT", "CHECKLISTS", "PHOTO"];

export default function LandingPage() {
  const [index, setIndex] = useState(0);
  const [isLeaving, setIsLeaving] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % rotatingWords.length);
    }, 1800);
    return () => clearInterval(id);
  }, []);

  const currentWord = rotatingWords[index];

  const handleGetStarted = () => {
    if (isLeaving) return;
    setIsLeaving(true);
    setTimeout(() => {
      router.push("/app");
    }, 400);
  };

  return (
    <div
      className={`min-h-screen bg-gradient-soft text-slate-900 transition-opacity duration-500 ease-out ${
        isLeaving ? "opacity-0" : "opacity-100"
      }`}
    >
      <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center px-4 py-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="relative h-20 w-20 md:h-28 md:w-28">
            <Image
              src="/clearmove-logo.jpeg"
              alt="ClearMove logo"
              fill
              className="rounded-2xl object-contain"
              priority
            />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-5xl">
              ClearMove
            </h1>
            <p className="mt-1 text-xs font-medium uppercase tracking-[0.15em] text-slate-600 md:text-sm">
              Ultimate Rent Protection
            </p>
          </div>
        </div>

        <p className="max-w-3xl text-center text-sm text-slate-800 md:text-lg flex flex-wrap items-center justify-center gap-x-3">
          <span className="transition-all duration-700 ease-out">ClearMove turns your</span>
          <span className="inline-block text-center transition-all duration-700 ease-out" style={{ width: currentWord === "CONTRACT" ? "7.5rem" : currentWord === "CHECKLISTS" ? "9rem" : "6rem" }}>
            <span key={currentWord} className="rotate-word-fade text-base font-semibold text-sky-500 md:text-xl">
              {currentWord}
            </span>
          </span>
          <span className="transition-all duration-700 ease-out">into</span>
          <span className="text-shimmer transition-all duration-700 ease-out">
            organized, shareable evidence
          </span>
          <span className="transition-all duration-700 ease-out">.</span>
        </p>

        <p className="mt-4 max-w-xl text-center text-xs text-slate-600 md:text-sm">
          Capture move-in and move-out photos, digitize paper checklists, and
          get AI-powered lease insights — all in one place, ready to share with
          your landlord or housing office.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={handleGetStarted}
            className="rounded-full bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 md:px-8 md:py-3"
          >
            Get Started →
          </button>
          <div className="flex flex-wrap justify-center gap-2 text-[11px] text-slate-600 md:text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Checklist &amp; photos
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
              Lease advisor
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              PDF evidence report
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}

