"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type Step = "idle" | "verifying" | "saving";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => {
        if (d.hasCredentials) router.replace("/dashboard");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setStep("verifying");

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Login failed.");
        setStep("idle");
        return;
      }

      setStep("saving");
      router.replace("/dashboard");
    } catch {
      setError("Network error — please try again.");
      setStep("idle");
    }
  }

  const busy = step !== "idle";

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">SF Support Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">Sign in with your sfsupport.dataon.com credentials</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-gray-900 rounded-2xl p-8 shadow-xl border border-gray-800 space-y-5"
        >
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Username / Email
            </label>
            <input
              type="text"
              autoComplete="username"
              required
              disabled={busy}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-4 py-2.5 rounded-lg bg-gray-800 border border-gray-700 text-white
                         placeholder-gray-500 disabled:opacity-50
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-2.5 rounded-lg bg-gray-800 border border-gray-700 text-white
                         placeholder-gray-500 disabled:opacity-50
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 text-red-400 text-sm bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          {/* Progress steps when busy */}
          {busy && (
            <div className="space-y-2">
              <ProgressStep
                label="Connecting to sfsupport.dataon.com"
                state="done"
              />
              <ProgressStep
                label="Verifying your credentials"
                state={step === "verifying" ? "active" : "done"}
              />
              <ProgressStep
                label="Saving & loading dashboard"
                state={step === "saving" ? "active" : "waiting"}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500
                       disabled:bg-blue-800 disabled:cursor-not-allowed
                       text-white font-semibold transition flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {step === "verifying" ? "Verifying login…" : "Opening dashboard…"}
              </>
            ) : (
              "Sign In & Load Dashboard"
            )}
          </button>

          <p className="text-xs text-gray-500 text-center">
            Credentials are encrypted and stored locally on this machine only.
          </p>
        </form>
      </div>
    </div>
  );
}

function ProgressStep({
  label,
  state,
}: {
  label: string;
  state: "waiting" | "active" | "done";
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      {state === "done" && (
        <svg className="w-4 h-4 text-green-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l7.879-7.879a1 1 0 011.414 0z"
            clipRule="evenodd" />
        </svg>
      )}
      {state === "active" && (
        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
      )}
      {state === "waiting" && (
        <div className="w-4 h-4 rounded-full border-2 border-gray-600 shrink-0" />
      )}
      <span
        className={
          state === "done"
            ? "text-green-400"
            : state === "active"
            ? "text-blue-300"
            : "text-gray-600"
        }
      >
        {label}
      </span>
    </div>
  );
}
