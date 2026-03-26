"use client";

import { PublicKey } from "@solana/web3.js";
import { Cuer } from "cuer";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { motion, type Variants } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBtcDisplay, formatUsdcDisplay } from "@/lib/amounts";
import { ApiError, orchestrationEstimate, orchestrationOnramp, orchestrationStatus } from "@/lib/api";
import { useOrderSSE } from "@/lib/use-order-sse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROBE_SATS = "1000000";
const CASHAPP_LIMIT_USD = 999;
const TERMINAL_STATUSES = new Set(["completed", "failed", "refunded"]);

const PIPELINE_STEPS = [
  { key: "confirming", label: "Confirming payment" },
  { key: "swapping", label: "Swapping BTC → USDB" },
  { key: "bridging", label: "Bridging to USDC" },
  { key: "completed", label: "Done" },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepIndex(status: string): number {
  return PIPELINE_STEPS.findIndex((s) => s.key === status);
}

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && "ontouchstart" in window;
}

function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function triggerShake(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove("animate-shake");
  void el.offsetWidth;
  el.classList.add("animate-shake");
}

function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

/** mm:ss countdown from an ISO expiry time. */
function useCountdown(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (!expiresAt) return { display: null, expired: false };
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  const expired = remaining <= 0;
  const hrs = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  const secs = remaining % 60;
  const display = hrs > 0
    ? `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
    : `${mins}:${secs.toString().padStart(2, "0")}`;
  return { display, expired };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PageState = "idle" | "submitting" | "tracking";

interface OnrampResult {
  orderId: string;
  cashAppUrl: string;
  amountIn: string;
  estimatedOut: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OnrampPage() {
  const [pageState, setPageState] = useState<PageState>("idle");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [result, setResult] = useState<OnrampResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const amountWrapperRef = useRef<HTMLDivElement>(null);
  const addressWrapperRef = useRef<HTMLDivElement>(null);

  // QR modal (desktop only)
  const [qrOpen, setQrOpen] = useState(false);

  // Order tracking
  const [orderStatus, setOrderStatus] = useState("processing");
  const isTerminal = TERMINAL_STATUSES.has(orderStatus);
  const isSuccess = orderStatus === "completed";
  const isFailed = orderStatus === "failed" || orderStatus === "refunded";

  // Invoice countdown
  const countdownActive = pageState === "tracking" && result !== null && stepIndex(orderStatus) < 0;
  const { display: countdown, expired } = useCountdown(
    countdownActive ? (result?.expiresAt ?? null) : null,
  );

  useEffect(() => {
    if (expired && countdownActive) {
      setQrOpen(false);
      toast.error("Invoice expired. Please try again.");
      setPageState("idle");
      setResult(null);
      setOrderStatus("processing");
    }
  }, [expired, countdownActive]);

  // BTC/USDC rate
  const [btcUsdcRate, setBtcUsdcRate] = useState<number | null>(null);
  const probeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    orchestrationEstimate({
      sourceChain: "lightning",
      sourceAsset: "BTC",
      destinationChain: "solana",
      destinationAsset: "USDC",
      amount: PROBE_SATS,
      signal: controller.signal,
    })
      .then((res) => {
        if (!controller.signal.aborted) {
          const usdcOut = Number(BigInt(res.data.estimatedOut));
          const satsIn = Number(BigInt(PROBE_SATS));
          if (satsIn > 0 && usdcOut > 0) setBtcUsdcRate(usdcOut / satsIn);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Live estimate
  const [estimate, setEstimate] = useState<{
    amountInSats: string;
    estimatedOutUsdc: string;
    feeAmount: string;
  } | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const estimateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const estimateAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ---------------------------------------------------------------------------
  // SSE + polling
  // ---------------------------------------------------------------------------

  const orderId = result?.orderId ?? "";
  const sseEnabled = pageState === "tracking" && orderId.length > 0;

  const fetchStatus = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await orchestrationStatus(orderId);
      const s =
        typeof res.data.order === "object" && res.data.order !== null
          ? ((res.data.order as { status?: string }).status ?? "processing")
          : "processing";
      setOrderStatus(s);
    } catch {
      /* keep current */
    }
  }, [orderId]);

  useOrderSSE({
    orderId,
    onStatus: useCallback((s: string) => setOrderStatus(s), []),
    enabled: sseEnabled,
  });

  useEffect(() => {
    if (!sseEnabled || isTerminal) return;
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 3000);
    return () => clearInterval(interval);
  }, [sseEnabled, isTerminal, fetchStatus]);

  // Close QR modal when deposit arrives
  useEffect(() => {
    if (stepIndex(orderStatus) >= 0 || isTerminal) setQrOpen(false);
  }, [orderStatus, isTerminal]);

  // ---------------------------------------------------------------------------
  // Debounced estimate
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current);
    if (estimateAbortRef.current) estimateAbortRef.current.abort();

    if (pageState !== "idle" || !usdcAmount.trim() || !btcUsdcRate) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }

    const usdValue = parseFloat(usdcAmount);
    if (Number.isNaN(usdValue) || usdValue <= 0) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }

    const sats = Math.ceil((usdValue * 1e6) / btcUsdcRate).toString();
    if (sats === "0") {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }

    setEstimateLoading(true);

    estimateTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      estimateAbortRef.current = controller;
      orchestrationEstimate({
        sourceChain: "lightning",
        sourceAsset: "BTC",
        destinationChain: "solana",
        destinationAsset: "USDC",
        amount: sats,
        signal: controller.signal,
      })
        .then((res) => {
          if (!controller.signal.aborted) {
            setEstimate({
              amountInSats: sats,
              estimatedOutUsdc: res.data.estimatedOut,
              feeAmount: res.data.feeAmount,
            });
            setEstimateLoading(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setEstimate(null);
            setEstimateLoading(false);
          }
        });
    }, 300);

    return () => {
      if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current);
      if (estimateAbortRef.current) estimateAbortRef.current.abort();
    };
  }, [usdcAmount, btcUsdcRate, pageState]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function validate(): boolean {
    let valid = true;
    let newAmountError: string | null = null;
    let newAddressError: string | null = null;

    const parsed = parseFloat(usdcAmount.trim());
    if (!usdcAmount.trim() || Number.isNaN(parsed) || parsed < 1) {
      newAmountError = "Minimum amount is $1";
      valid = false;
    } else if (parsed > CASHAPP_LIMIT_USD) {
      newAmountError = `Maximum amount is $${CASHAPP_LIMIT_USD}`;
      valid = false;
    }

    const addr = recipientAddress.trim();
    if (!addr) {
      newAddressError = "Enter a Solana address";
      valid = false;
    } else if (!isValidSolanaAddress(addr)) {
      newAddressError = "Invalid Solana address";
      valid = false;
    }

    setAmountError(newAmountError);
    setAddressError(newAddressError);

    if (!valid) {
      if (newAmountError) triggerShake(amountWrapperRef.current);
      if (newAddressError) triggerShake(addressWrapperRef.current);
    }

    return valid;
  }

  async function handleOnramp() {
    if (!validate()) return;

    const usdValue = parseFloat(usdcAmount);
    if (Number.isNaN(usdValue) || usdValue <= 0) {
      toast.error("Invalid amount.");
      return;
    }
    const usdcSmallestUnits = Math.round(usdValue * 1e6).toString();

    setPageState("submitting");
    try {
      const res = await orchestrationOnramp({
        destinationChain: "solana",
        destinationAsset: "USDC",
        recipientAddress: recipientAddress.trim(),
        amount: usdcSmallestUnits,
        amountMode: "exact_out",
      });

      const data = res.data;
      setResult({
        orderId: data.orderId,
        cashAppUrl: data.paymentLinks.cashApp,
        amountIn: data.amountIn,
        estimatedOut: data.estimatedOut,
        expiresAt: data.expiresAt,
      });
      setOrderStatus("processing");
      setPageState("tracking");

      if (isTouchDevice()) {
        window.location.href = data.paymentLinks.cashApp;
      } else {
        setQrOpen(true);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
      setPageState("idle");
    }
  }

  function handleReset() {
    setPageState("idle");
    setResult(null);
    setUsdcAmount("");
    setEstimate(null);
    setOrderStatus("processing");
    setQrOpen(false);
    setAmountError(null);
    setAddressError(null);
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const isIdle = pageState === "idle";
  const isSubmitting = pageState === "submitting";
  const btcDisplay = estimate ? formatBtcDisplay(estimate.amountInSats) : null;
  const btcUsdDisplay = estimate ? `$${formatUsdcDisplay(estimate.estimatedOutUsdc)}` : null;
  const currentStepIdx = stepIndex(orderStatus);
  const hasProgress = currentStepIdx >= 0;

  // ---------------------------------------------------------------------------
  // Render: Tracking
  // ---------------------------------------------------------------------------

  if (pageState === "tracking" && result) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center px-4">
        <motion.div
          className="w-full max-w-sm space-y-8"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
          {/* Header */}
          <div>
            <span className="text-sm text-muted-foreground">You paid</span>
            <div className="mt-1 flex items-center gap-3">
              <img
                alt="Cash App Pay"
                src="https://static.afterpaycdn.com/en-US/integration/logo/icon/color.svg"
                height="32"
                width="32"
              />
              <span className="text-4xl font-medium tabular-nums tracking-tight">${usdcAmount}</span>
            </div>
          </div>

          {hasProgress ? (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              <div className="space-y-0">
                {PIPELINE_STEPS.map((step, i) => {
                  const done = currentStepIdx > i || (isSuccess && i === PIPELINE_STEPS.length - 1);
                  const active = !isTerminal && currentStepIdx === i;
                  const waiting = !done && !active;
                  const isLast = i === PIPELINE_STEPS.length - 1;
                  return (
                    <motion.div
                      key={step.key}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05, duration: 0.15 }}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={[
                            "flex size-10 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
                            done && "bg-success/10",
                            active && "bg-foreground/5",
                            waiting && "bg-muted/50",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {done ? (
                            <CheckIcon className="size-5 text-success" />
                          ) : active ? (
                            <Loader2Icon className="size-5 animate-spin text-foreground" />
                          ) : (
                            <div className="size-1.5 rounded-full bg-border" />
                          )}
                        </div>
                        <span
                          className={[
                            "text-sm transition-colors duration-300",
                            done && "font-medium text-foreground",
                            active && "font-medium text-foreground",
                            waiting && "text-muted-foreground/40",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {step.label}
                        </span>
                      </div>
                      {!isLast && (
                        <div className="ml-[19px] h-6">
                          <div
                            className={[
                              "h-full w-[2px] transition-colors duration-300",
                              done ? "bg-success/30" : "bg-border",
                            ].join(" ")}
                          />
                        </div>
                      )}
                    </motion.div>
                  );
                })}

                {isFailed && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
                    <XIcon className="size-3.5" />
                    <span>Order {orderStatus}</span>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            >
              {/* Waiting for deposit */}
              <div className="flex flex-col items-center gap-4 py-4">
                <motion.div
                  animate="pulse"
                  transition={{ staggerChildren: -0.2, staggerDirection: -1 }}
                  className="flex items-center justify-center gap-2.5"
                >
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="size-2.5 rounded-full bg-muted-foreground"
                      variants={
                        {
                          pulse: {
                            scale: [1, 1.5, 1],
                            transition: {
                              duration: 1.2,
                              repeat: Infinity,
                              ease: "easeInOut",
                            },
                          },
                        } satisfies Record<string, Variants["pulse"]>
                      }
                    />
                  ))}
                </motion.div>
                <p className="text-sm text-muted-foreground">Waiting for deposit</p>
              </div>

              <a
                href={result.cashAppUrl}
                onClick={(e) => {
                  if (!isTouchDevice()) {
                    e.preventDefault();
                    setQrOpen(true);
                  }
                }}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-black text-white transition-colors hover:bg-black/90 cursor-pointer"
              >
                <span className="text-sm font-medium">Open with</span>
                <img
                  alt="Cash App"
                  src="https://static.afterpaycdn.com/en-US/integration/logo/lockup/cashapp-color-white-32.svg"
                  height={32}
                  className="h-5 w-auto"
                />
              </a>
            </motion.div>
          )}

          {/* Success card */}
          {isSuccess && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="rounded-xl border border-border bg-muted/30 p-4"
            >
              <span className="text-sm text-muted-foreground">You received</span>
              <div className="mt-2 flex items-center gap-3">
                <span className="text-4xl font-medium tabular-nums tracking-tight">
                  {formatUsdcDisplay(result.estimatedOut)}
                </span>
                <span className="text-xl text-muted-foreground">USDC</span>
              </div>
            </motion.div>
          )}

          {/* Actions */}
          <div className="flex flex-col items-center gap-3">
            {isTerminal && (
              <button
                type="button"
                onClick={handleReset}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
              >
                Start over
              </button>
            )}
          </div>
        </motion.div>

        {/* QR Modal */}
        {qrOpen && result && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="relative mx-4 w-full max-w-sm rounded-2xl bg-background p-6 text-center shadow-xl border border-border"
            >
              <button
                type="button"
                onClick={() => setQrOpen(false)}
                className="absolute right-4 top-4 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <XIcon className="size-5" />
              </button>
              <div className="space-y-4 pt-4">
                <p className="text-2xl font-medium">Scan to pay</p>
                <p className="text-sm text-muted-foreground">
                  Open Cash App on your phone<br />and scan this code
                </p>
              </div>
              <div className="mx-auto my-6 rounded-2xl bg-white p-4 w-fit">
                <Cuer value={result.cashAppUrl} size={200} color="#000" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-mono text-muted-foreground tabular-nums">
                  {formatBtcDisplay(result.amountIn)} BTC → {formatUsdcDisplay(result.estimatedOut)} USDC
                </p>
                {countdown && (
                  <p className="text-sm tabular-nums text-muted-foreground">
                    Expires in <span className="font-mono font-medium text-foreground">{countdown}</span>
                  </p>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Input
  // ---------------------------------------------------------------------------

  return (
    <motion.div
      className="mx-auto flex min-h-dvh w-full max-w-sm flex-1 flex-col px-4 pt-2 sm:min-h-[60vh] sm:justify-center sm:pt-0"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <div className="space-y-8">
        {/* Amount hero */}
        <div className="pt-16 text-center sm:pt-16">
          <p className="mb-11 text-3xl font-medium tracking-tight text-foreground">
            Buy USDC on Solana
          </p>
          <div ref={amountWrapperRef} className="relative inline-flex items-baseline">
            <span className="-mr-1 pointer-events-none font-mono text-7xl font-medium text-muted-foreground/25">
              $
            </span>
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              value={usdcAmount}
              onChange={(e) => {
                if (/^\d*\.?\d*$/.test(e.target.value)) {
                  setUsdcAmount(e.target.value);
                  if (amountError) setAmountError(null);
                }
              }}
              disabled={!isIdle}
              placeholder="0"
              className="min-w-[1.4ch] appearance-none bg-transparent p-0 text-center font-mono text-7xl font-medium tabular-nums leading-[0.95] outline-none placeholder:text-muted-foreground/30"
              style={{ width: `${Math.max(1.4, usdcAmount.length || 1)}ch` }}
            />
          </div>

          {/* BTC estimate */}
          <div className="mt-3 flex h-5 items-center justify-center">
            {estimateLoading && (
              <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
            )}
            {!estimateLoading && btcDisplay && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {btcDisplay} BTC{" "}
                {btcUsdDisplay && (
                  <span>(${parseFloat(btcUsdDisplay.replace("$", "")).toFixed(2)})</span>
                )}
              </p>
            )}
          </div>

          {/* Amount error */}
          <div className="flex h-5 items-center justify-center">
            {amountError && <p className="text-xs font-medium text-destructive">{amountError}</p>}
          </div>
        </div>

        {/* Address */}
        <div className="space-y-3 pt-4">
          <span className="text-sm font-medium text-muted-foreground">
            Destination Address (Solana)
          </span>
          <div ref={addressWrapperRef}>
            <input
              type="text"
              placeholder="Solana address"
              value={recipientAddress}
              onChange={(e) => {
                setRecipientAddress(e.target.value);
                if (addressError) setAddressError(null);
              }}
              aria-invalid={!!addressError}
              disabled={!isIdle}
              className="h-12 w-full rounded-2xl border border-border bg-muted/30 px-4 text-base outline-none transition-colors focus:border-foreground/20 disabled:opacity-50 sm:text-sm"
            />
          </div>
          {addressError && <p className="text-xs font-medium text-destructive">{addressError}</p>}
        </div>

        {/* You receive */}
        <div
          className={[
            "flex min-h-6 items-center justify-between text-sm transition-opacity duration-300",
            estimate && !estimateLoading ? "opacity-100" : "opacity-0",
          ].join(" ")}
        >
          <span className="text-muted-foreground">You receive</span>
          <span className="font-medium tabular-nums text-foreground">
            {estimate ? formatUsdcDisplay(estimate.estimatedOutUsdc) : "0"} USDC
          </span>
        </div>
      </div>

      {/* Button */}
      <div className="mt-auto pb-10 pt-16 sm:pb-14">
        <button
          type="button"
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-black text-white font-medium transition-colors hover:bg-black/90 disabled:opacity-50 cursor-pointer"
          disabled={isSubmitting}
          onClick={handleOnramp}
        >
          {isSubmitting ? (
            <>
              <Loader2Icon className="size-4 animate-spin" />
              <span>Creating Order</span>
            </>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="text-base font-medium">Pay with</span>
              <img
                alt="Cash App"
                src="https://static.afterpaycdn.com/en-US/integration/logo/lockup/cashapp-color-white-32.svg"
                height={32}
                className="h-6 w-auto"
              />
            </span>
          )}
        </button>

        <p className="mt-4 text-center text-[10px] text-muted-foreground/45">
          Lightning &middot; Powered by Flashnet
        </p>
      </div>
    </motion.div>
  );
}
