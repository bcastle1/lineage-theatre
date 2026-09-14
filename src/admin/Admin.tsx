import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  Film,
  LayoutDashboard,
  Loader2,
  Percent,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { api, formatDuration, type User } from "../studio/model";
import type { Notice } from "../studio/Workspace";
import "./admin.css";

type Tab = "overview" | "people" | "payments" | "pricing" | "films" | "activity";
type Connection = { available: boolean; reason: string };
type Pricing = {
  markupBasisPoints: number;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
  referenceRate?: { credits: number; amountCents: number };
  currency: string;
};
type Overview = {
  statsPartial?: boolean;
  stats: {
    users: number;
    administrators: number;
    suspended: number;
    films: number;
    paidOrders: number;
    paymentTotalCents: number;
    refundTotalCents: number;
    currency: string;
  };
  connections: { story: Connection; magiclight: Connection; billing: Connection };
  pricing?: {
    markupBasisPoints: number;
    referenceReason?: string;
    referenceRate?: { credits: number; amountCents: number } | null;
    currency: string;
    estimate?: { reason: string };
  };
};
type Person = {
  email: string;
  name: string;
  role: "owner" | "admin" | "customer";
  status: string;
  createdAt: string;
  lastLoginAt?: string;
};
type Order = {
  id: string;
  customerEmail: string;
  filmTitle: string;
  status: string;
  currency: string;
  amountCents: number;
  refundedCents: number;
  createdAt: string;
  provider: string;
};
type ArchivedFilm = {
  id: string;
  ownerEmail: string;
  title: string;
  ancestor: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  hasVideo: boolean;
  duration: number;
};
type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  details?: string | Record<string, unknown>;
};
type PeopleData = { users: Person[]; cursor?: string };
type PaymentsData = {
  orders: Order[];
  connectionReady: boolean;
  reason?: string;
  cursor?: string;
};
type QuickBooksStatus = {
  configured: boolean;
  environment: "production" | "sandbox" | null;
  authorizationStatus:
    | "not-configured"
    | "disconnected"
    | "authorizing"
    | "authorized"
    | "expired"
    | "configuration-changed"
    | "needs-attention";
  connected: boolean;
  hasSavedAuthorization?: boolean;
  remoteReviewRequired?: boolean;
  revision: number;
  pending: boolean | null;
  lastConnectedAt: string | null;
  realmId?: string | null;
  revocationStatus?: string | null;
  paymentReady: false;
  refundReady: false;
  message: string;
};
type FilmsData = { films: ArchivedFilm[]; cursor?: string };
type AuditData = { events: AuditEvent[]; cursor?: string };
type PersonAction = {
  kind: "person";
  action: "suspend" | "activate" | "revokeAdmin";
  person: Person;
};
type RefundAction = { kind: "refund"; order: Order; idempotencyKey: string };
type Dialog =
  | PersonAction
  | RefundAction
  | { kind: "film"; film: ArchivedFilm }
  | { kind: "disconnectQuickBooks" };
const tabs = [
  { id: "overview" as const, name: "Overview", icon: LayoutDashboard },
  { id: "people" as const, name: "People", icon: Users },
  { id: "payments" as const, name: "Payments", icon: CreditCard },
  { id: "pricing" as const, name: "Pricing", icon: Percent },
  { id: "films" as const, name: "Film archive", icon: Film },
  { id: "activity" as const, name: "Activity", icon: Activity },
];
const money = (cents?: number, currency = "USD") =>
  typeof cents === "number" && Number.isFinite(cents)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100)
    : "—";
const date = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not recorded";
const humanize = (value: string) => value.replace(/[_-]/g, " ");
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This information could not be loaded. Please try again.";
const matches = (query: string, ...fields: (string | undefined)[]) =>
  fields.some((field) => field?.toLowerCase().includes(query.trim().toLowerCase()));
const mediaUrl = (film: ArchivedFilm) =>
  `/api/archive?action=media&id=${encodeURIComponent(film.id)}&owner=${encodeURIComponent(film.ownerEmail)}`;
function csvCell(value: string | number) {
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportPayments(orders: Order[]) {
  const rows: (string | number)[][] = [
    [
      "Order ID",
      "Customer email",
      "Film",
      "Status",
      "Currency",
      "Amount",
      "Refunded",
      "Created",
      "Provider",
    ],
    ...orders.map((o) => [
      o.id,
      o.customerEmail,
      o.filmTitle,
      o.status,
      o.currency,
      (o.amountCents / 100).toFixed(2),
      ((o.refundedCents || 0) / 100).toFixed(2),
      o.createdAt,
      o.provider,
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `lineage-payments-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function auditDetails(details: AuditEvent["details"]) {
  if (typeof details === "string") return details;
  if (!details) return "";
  return Object.entries(details)
    .filter(
      ([key, value]) =>
        !/token|secret|password|authorization|inviteUrl/i.test(key) &&
        ["string", "number", "boolean"].includes(typeof value),
    )
    .map(([key, value]) => `${humanize(key)}: ${String(value)}`)
    .join(" · ");
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "pending" | "danger";
}) {
  return <span className={`admin-badge ${tone}`}>{children}</span>;
}
function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Users;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-empty">
      <Icon size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function SearchField({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="admin-search">
      <Search size={17} />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {value && (
        <button
          className="icon-button"
          aria-label="Clear search"
          onClick={() => setValue("")}
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}

function paymentCallbackResult() {
  if (typeof window === "undefined") return "";
  if (!window.location.hash.startsWith("#admin/payments")) return "";
  const query = window.location.hash.split("?")[1] || "";
  const result = new URLSearchParams(query).get("quickbooks");
  return result && ["connected", "denied", "error"].includes(result) ? result : "";
}

export default function Admin({
  user,
  notify,
  onPricingChanged,
}: {
  user: User;
  notify: (text: string, tone?: Notice["tone"]) => void;
  onPricingChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#admin/payments")
      ? "payments"
      : "overview",
  );
  const [overview, setOverview] = useState<Overview | null>(null);
  const [people, setPeople] = useState<PeopleData | null>(null);
  const [payments, setPayments] = useState<PaymentsData | null>(null);
  const [quickBooks, setQuickBooks] = useState<QuickBooksStatus | null>(null);
  const [quickBooksError, setQuickBooksError] = useState("");
  const [quickBooksReturn, setQuickBooksReturn] = useState(paymentCallbackResult);
  const [authorizationCheck, setAuthorizationCheck] = useState(0);
  const [authorizationTracking, setAuthorizationTracking] = useState(false);
  const [authorizationMessage, setAuthorizationMessage] = useState("");
  const [films, setFilms] = useState<FilmsData | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [markup, setMarkup] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const [updated, setUpdated] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitation, setInvitation] = useState<{
    inviteUrl: string;
    expiresAt: string;
  } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [actionError, setActionError] = useState("");
  const requestNumber = useRef(0);
  const actionLock = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const authorizationPopup = useRef<Window | null>(null);
  const isOwner = user.role === "owner";
  const isAdministrator = isOwner || user.role === "admin";
  const refresh = useCallback(async () => {
    const request = ++requestNumber.current;
    setLoading(true);
    setError("");
    setOverviewError("");
    if (tab === "payments") setQuickBooksError("");
    const overviewResult = api<Overview>("/api/admin?action=overview")
      .then((result) => {
        if (request === requestNumber.current) setOverview(result);
      })
      .catch((e) => {
        if (request === requestNumber.current) {
          setOverview(null);
          setOverviewError(errorText(e));
        }
      });
    const loadList = async () => {
      if (tab === "people") {
        const result = await api<PeopleData>("/api/admin?action=users");
        if (request === requestNumber.current) setPeople(result);
      }
      if (tab === "payments") {
        const statusRequest = api<QuickBooksStatus>("/api/quickbooks?action=status")
          .then((result) => {
            if (request === requestNumber.current) setQuickBooks(result);
          })
          .catch((e) => {
            if (request === requestNumber.current) {
              setQuickBooks(null);
              setQuickBooksError(errorText(e));
            }
          });
        try {
          const result = await api<PaymentsData>("/api/admin?action=payments");
          if (request === requestNumber.current) setPayments(result);
        } finally {
          await statusRequest;
        }
      }
      if (tab === "films") {
        const result = await api<FilmsData>("/api/archive?action=admin");
        if (request === requestNumber.current) setFilms(result);
      }
      if (tab === "activity") {
        const result = await api<AuditData>("/api/admin?action=audit");
        if (request === requestNumber.current) setAudit(result);
      }
      if (tab === "pricing") {
        const result = await api<Pricing>("/api/admin?action=pricing");
        if (request === requestNumber.current) {
          setPricing(result);
          setMarkup((result.markupBasisPoints / 100).toFixed(2));
        }
      }
    };
    const listResult = loadList().catch((e) => {
      if (request === requestNumber.current) {
        setError(errorText(e));
        if (tab === "people") setPeople(null);
        if (tab === "payments") setPayments(null);
        if (tab === "films") setFilms(null);
        if (tab === "activity") setAudit(null);
        if (tab === "pricing") setPricing(null);
      }
    });
    await Promise.allSettled([overviewResult, listResult]);
    if (request === requestNumber.current) {
      setLoading(false);
      setUpdated(new Date().toISOString());
    }
  }, [tab]);
  useEffect(() => {
    if (isAdministrator) void refresh();
    return () => {
      requestNumber.current += 1;
    };
  }, [refresh, isAdministrator, authorizationCheck]);
  useEffect(() => {
    const handleReturn = (event?: HashChangeEvent) => {
      if (!window.location.hash.startsWith("#admin/payments")) return;
      const outcome = paymentCallbackResult();
      setTab("payments");
      setQuery("");
      if (outcome) {
        setQuickBooksReturn(outcome);
        if (event) setAuthorizationCheck((value) => value + 1);
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}#admin/payments`,
        );
      }
    };
    handleReturn();
    window.addEventListener("hashchange", handleReturn);
    return () => window.removeEventListener("hashchange", handleReturn);
  }, []);
  useEffect(() => {
    if (!authorizationTracking || !isAdministrator) return;
    let active = true;
    let checking = false;
    let sawClosed = false;
    const checkAuthorization = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const result = await api<QuickBooksStatus>("/api/quickbooks?action=status");
        if (!active) return;
        setQuickBooks(result);
        if (!result.pending) {
          setAuthorizationTracking(false);
          authorizationPopup.current = null;
          setAuthorizationMessage(
            result.connected
              ? "QuickBooks authorization is saved. You can close the Intuit window. Customer payments and refunds remain unavailable."
              : "The authorization check has finished. Review the current connection status below; customer payments remain unavailable.",
          );
        }
      } catch {
        if (active)
          setAuthorizationMessage(
            "The saved authorization status could not be checked yet. Complete the Intuit window, then return here and use Refresh if needed.",
          );
      } finally {
        checking = false;
      }
    };
    const onFocus = () => void checkAuthorization();
    const timer = window.setInterval(() => {
      // Some browser isolation policies report a separated popup as closed.
      // A closed window is never treated as proof of success or cancellation.
      if (authorizationPopup.current?.closed && !sawClosed) {
        sawClosed = true;
        window.clearInterval(timer);
        setAuthorizationMessage(
          "The authorization window has closed or separated from this page. Checking the saved connection status…",
        );
        void checkAuthorization();
      }
    }, 1000);
    const timeout = window.setTimeout(
      () => {
        setAuthorizationTracking(false);
        authorizationPopup.current = null;
        setAuthorizationMessage(
          "Authorization window tracking has stopped. Complete or close the Intuit window, then use Refresh to check the saved status.",
        );
      },
      10 * 60 * 1000,
    );
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener("focus", onFocus);
    };
  }, [authorizationTracking, isAdministrator]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialogRef.current;
    element?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !actionLock.current) {
        event.preventDefault();
        setDialog(null);
      }
      if (event.key !== "Tab" || !element) return;
      const elements = Array.from(
        element.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], video[controls]",
        ),
      );
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [dialog]);
  async function loadMore() {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    const request = requestNumber.current;
    try {
      if (tab === "people" && people?.cursor) {
        const result = await api<PeopleData>(
          `/api/admin?action=users&cursor=${encodeURIComponent(people.cursor)}`,
        );
        if (request === requestNumber.current)
          setPeople((previous) => ({
            ...result,
            users: [
              ...(previous?.users || []),
              ...result.users.filter(
                (p) => !previous?.users.some((old) => old.email === p.email),
              ),
            ],
          }));
      }
      if (tab === "payments" && payments?.cursor) {
        const result = await api<PaymentsData>(
          `/api/admin?action=payments&cursor=${encodeURIComponent(payments.cursor)}`,
        );
        if (request === requestNumber.current)
          setPayments((previous) => ({
            ...result,
            orders: [
              ...(previous?.orders || []),
              ...result.orders.filter(
                (p) => !previous?.orders.some((old) => old.id === p.id),
              ),
            ],
          }));
      }
      if (tab === "films" && films?.cursor) {
        const result = await api<FilmsData>(
          `/api/archive?action=admin&cursor=${encodeURIComponent(films.cursor)}`,
        );
        if (request === requestNumber.current)
          setFilms((previous) => ({
            ...result,
            films: [
              ...(previous?.films || []),
              ...result.films.filter(
                (f) =>
                  !previous?.films.some(
                    (old) => old.id === f.id && old.ownerEmail === f.ownerEmail,
                  ),
              ),
            ],
          }));
      }
      if (tab === "activity" && audit?.cursor) {
        const result = await api<AuditData>(
          `/api/admin?action=audit&cursor=${encodeURIComponent(audit.cursor)}`,
        );
        if (request === requestNumber.current)
          setAudit((previous) => ({
            ...result,
            events: [
              ...(previous?.events || []),
              ...result.events.filter(
                (e) => !previous?.events.some((old) => old.id === e.id),
              ),
            ],
          }));
      }
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setLoadingMore(false);
    }
  }
  async function invite() {
    if (!isOwner || actionLock.current || !inviteEmail.trim()) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    setInvitation(null);
    try {
      const result = await api<{ inviteUrl: string; expiresAt: string }>("/api/admin", {
        action: "invite",
        email: inviteEmail.trim().toLowerCase(),
      });
      setInvitation(result);
      setInviteEmail("");
      notify(
        "Administrator invitation created. Copy the private link and share it with the intended recipient.",
      );
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function copyInvitation() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.inviteUrl);
      notify("Private invitation link copied.");
    } catch {
      notify(
        "The clipboard is unavailable. Select and copy the invitation link below.",
        "info",
      );
    }
  }
  async function confirmPersonAction(action: PersonAction) {
    if (actionLock.current || action.person.role === "owner") return;
    if (action.action === "revokeAdmin" && !isOwner) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{ message?: string }>("/api/admin", {
        action: action.action,
        email: action.person.email,
      });
      setDialog(null);
      notify(result.message || "Account access updated.");
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  const hasQuickBooksAuthorization = Boolean(
    quickBooks?.hasSavedAuthorization ??
      (quickBooks?.authorizationStatus !== "disconnected" &&
        (quickBooks?.connected || quickBooks?.realmId)),
  );
  const needsQuickBooksReconnect = Boolean(
    hasQuickBooksAuthorization ||
      (quickBooks &&
        ["expired", "configuration-changed", "needs-attention"].includes(
          quickBooks.authorizationStatus,
        )),
  );
  async function connectQuickBooks() {
    if (
      !isOwner ||
      !quickBooks?.configured ||
      hasQuickBooksAuthorization ||
      quickBooks.remoteReviewRequired ||
      quickBooks.pending ||
      authorizationTracking ||
      !Number.isInteger(quickBooks.revision) ||
      actionLock.current
    )
      return;
    const width = Math.min(640, window.screen.availWidth || 640);
    const height = Math.min(760, window.screen.availHeight || 760);
    const left = Math.max(
      0,
      Math.round(window.screenX + (window.outerWidth - width) / 2),
    );
    const top = Math.max(
      0,
      Math.round(window.screenY + (window.outerHeight - height) / 2),
    );
    // Keep this synchronous with the owner's click so popup blockers can make
    // their decision before any server-side authorization attempt is created.
    let popup: Window | null = null;
    try {
      popup = window.open(
        "about:blank",
        "_blank",
        `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
      );
    } catch {
      /* A restricted browser may throw instead of returning null. */
    }
    if (!popup) {
      setQuickBooksError(
        "Your browser blocked the QuickBooks authorization window. Allow popups for Lineage Theatre and select Connect again. No authorization request was started.",
      );
      return;
    }
    authorizationPopup.current = popup;
    actionLock.current = true;
    setBusy(true);
    setQuickBooksError("");
    setQuickBooksReturn("");
    try {
      popup.opener = null;
      popup.document.title = "Opening QuickBooks authorization";
      popup.document.body.textContent = "Opening secure QuickBooks authorization…";
      const result = await api<{ authorizationUrl: string }>("/api/quickbooks", {
        action: "start",
        expectedRevision: quickBooks.revision,
        replaceExisting: false,
      });
      const authorization = new URL(result.authorizationUrl);
      if (
        authorization.origin !== "https://appcenter.intuit.com" ||
        authorization.pathname !== "/connect/oauth2" ||
        authorization.username ||
        authorization.password
      )
        throw new Error(
          "The QuickBooks authorization link could not be verified. Refresh and try again.",
        );
      if (popup.closed)
        throw new Error(
          "The authorization window was closed before QuickBooks opened. Refresh the connection status before trying again.",
        );
      popup.location.replace(authorization.href);
      setAuthorizationMessage(
        "Complete authorization in the opened Intuit window, then return here. This page rechecks the saved status when you return or close the window.",
      );
      setAuthorizationTracking(true);
    } catch (e) {
      try {
        popup.close();
      } catch {
        /* The owner may already have closed it. */
      }
      authorizationPopup.current = null;
      setAuthorizationMessage("");
      setQuickBooksError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function disconnectQuickBooks() {
    if (
      !isOwner ||
      !quickBooks ||
      !Number.isInteger(quickBooks.revision) ||
      actionLock.current
    )
      return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<QuickBooksStatus>("/api/quickbooks", {
        action: "disconnect",
        expectedRevision: quickBooks.revision,
      });
      setQuickBooks(result);
      setQuickBooksReturn("");
      setAuthorizationMessage("");
      setDialog(null);
      notify(
        result.message ||
          "QuickBooks authorization updated. Customer payments remain unavailable.",
        "info",
      );
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  const amountCents = /^\d+(\.\d{1,2})?$/.test(refundAmount)
    ? Math.round(Number(refundAmount) * 100)
    : 0;
  const refundableCents =
    dialog?.kind === "refund"
      ? Math.max(0, dialog.order.amountCents - (dialog.order.refundedCents || 0))
      : 0;
  // OAuth authorization alone never enables moving customer money.
  const refundReady = false;
  async function submitRefund(action: RefundAction) {
    if (
      actionLock.current ||
      !refundReady ||
      !refundConfirmed ||
      amountCents <= 0 ||
      amountCents > refundableCents ||
      refundReason.trim().length < 3
    )
      return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{ message?: string }>("/api/admin", {
        action: "refund",
        orderId: action.order.id,
        amountCents,
        reason: refundReason.trim(),
        idempotencyKey: action.idempotencyKey,
      });
      setDialog(null);
      notify(
        result.message ||
          "Refund request recorded. Check the payment record for its confirmed status.",
        "info",
      );
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function openRefund(order: Order) {
    setRefundAmount(((order.amountCents - (order.refundedCents || 0)) / 100).toFixed(2));
    setRefundReason("");
    setRefundConfirmed(false);
    setActionError("");
    setDialog({ kind: "refund", order, idempotencyKey: crypto.randomUUID() });
  }
  const markupPercent = /^\d+(\.\d{0,2})?$/.test(markup) ? Number(markup) : NaN;
  const validMarkup =
    Number.isFinite(markupPercent) && markupPercent >= 0 && markupPercent <= 1000;
  async function savePricing() {
    if (!pricing || !validMarkup || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<Pricing>("/api/admin", {
        action: "updatePricing",
        markupPercent,
        expectedRevision: pricing.revision,
      });
      setPricing(result);
      setMarkup((result.markupBasisPoints / 100).toFixed(2));
      notify(
        `Markup saved at ${(result.markupBasisPoints / 100).toFixed(2)}% for new quotes. Existing orders are unchanged.`,
      );
      try {
        await onPricingChanged();
      } catch {
        notify(
          "Markup saved. The film studio's pricing display could not refresh; reload it before reviewing a new quote.",
          "info",
        );
      }
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function chooseTab(next: Tab) {
    setTab(next);
    setQuery("");
    setError("");
    setActionError("");
  }
  const displayedPeople = (people?.users || []).filter((p) =>
    matches(query, p.email, p.name, p.role, p.status),
  );
  const displayedOrders = (payments?.orders || []).filter((o) =>
    matches(query, o.id, o.customerEmail, o.filmTitle, o.status),
  );
  const displayedFilms = (films?.films || []).filter((f) =>
    matches(query, f.title, f.ancestor, f.ownerEmail, f.status),
  );
  const displayedEvents = (audit?.events || []).filter((e) =>
    matches(query, e.actor, e.action, e.target, auditDetails(e.details)),
  );
  const cursor =
    tab === "people"
      ? people?.cursor
      : tab === "payments"
        ? payments?.cursor
        : tab === "films"
          ? films?.cursor
          : tab === "activity"
            ? audit?.cursor
            : undefined;
  if (!isAdministrator)
    return (
      <section className="admin-page">
        <Empty icon={ShieldCheck} title="Administrator access required">
          Your account does not have access to administration.
        </Empty>
      </section>
    );
  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <span className="admin-eyebrow">Lineage Theatre administration</span>
          <h1>The business behind the stories</h1>
          <p>People, payments, and the family films entrusted to your studio.</p>
        </div>
        <div className="admin-heading-actions">
          <Badge tone="good">
            <ShieldCheck size={13} />
            {isOwner ? "Owner" : "Administrator"}
          </Badge>
          <button
            className="button secondary small"
            disabled={loading || busy || loadingMore}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
            Refresh
          </button>
        </div>
      </div>
      <nav className="admin-tabs" aria-label="Administration" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`admin-tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`admin-panel-${item.id}`}
            className={tab === item.id ? "selected" : ""}
            disabled={busy}
            onClick={() => chooseTab(item.id)}
          >
            <item.icon size={17} />
            {item.name}
          </button>
        ))}
      </nav>
      <div
        id={`admin-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`admin-tab-${tab}`}
        className="admin-content"
        aria-busy={loading}
      >
        {(error || (tab === "overview" && overviewError)) && (
          <div className="admin-feedback error" role="alert">
            <AlertCircle size={19} />
            <div>
              <strong>We could not load this view</strong>
              <p>{error || overviewError}</p>
              <button
                className="text-button"
                onClick={() => void refresh()}
                disabled={loading}
              >
                Try again
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        )}
        {loading && (
          <div className="admin-loading" role="status">
            <Loader2 size={17} className="spin" />
            Refreshing administration records…
          </div>
        )}
        {tab === "overview" && (
          <>
            {overview?.statsPartial && (
              <div className="admin-feedback info" role="status">
                <AlertCircle size={18} />
                <p>
                  Overview totals cover the first 100 records in each category. Additional
                  records are available through the People, Payments, and Film archive
                  views.
                </p>
              </div>
            )}
            <div className="admin-metrics">
              {[
                {
                  name: "Registered people",
                  value: overview?.stats.users,
                  detail: overview
                    ? `${overview.stats.administrators} administrators · ${overview.stats.suspended} suspended`
                    : "Account records",
                  icon: Users,
                },
                {
                  name: "Archived films",
                  value: overview?.stats.films,
                  detail: "Films saved to the private archive",
                  icon: Film,
                },
                {
                  name: "Recorded payments",
                  value: overview
                    ? money(overview.stats.paymentTotalCents, overview.stats.currency)
                    : undefined,
                  detail: overview
                    ? `${overview.stats.paidOrders} paid orders`
                    : "Confirmed order records",
                  icon: CreditCard,
                },
                {
                  name: "Recorded refunds",
                  value: overview
                    ? money(overview.stats.refundTotalCents, overview.stats.currency)
                    : undefined,
                  detail: "Confirmed refund records",
                  icon: Activity,
                },
              ].map((metric) => (
                <article className="admin-metric" key={metric.name}>
                  <div>
                    <span>{metric.name}</span>
                    <metric.icon size={19} />
                  </div>
                  <strong>{metric.value ?? "—"}</strong>
                  <small>{metric.detail}</small>
                </article>
              ))}
            </div>
            <div className="admin-overview-grid">
              <section className="admin-card">
                <div className="admin-section-heading">
                  <div>
                    <h2>Studio connections</h2>
                    <p>Live readiness from the application server.</p>
                  </div>
                  <ShieldCheck size={23} />
                </div>
                {(
                  [
                    ["Story development", "GPT-6 Astra", overview?.connections.story],
                    ["Film production", "MagicLight", overview?.connections.magiclight],
                    ["Payments & refunds", "QuickBooks", overview?.connections.billing],
                  ] as const
                ).map(([label, provider, connection]) => (
                  <div className="admin-connection" key={label}>
                    <div
                      className={`admin-connection-icon ${connection?.available ? "ready" : "pending"}`}
                    >
                      {connection?.available ? (
                        <CheckCircle2 size={19} />
                      ) : (
                        <AlertCircle size={19} />
                      )}
                    </div>
                    <div>
                      <span>{label}</span>
                      <h3>{provider}</h3>
                      <p>{connection?.reason || "Availability has not been verified."}</p>
                    </div>
                    <Badge tone={connection?.available ? "good" : "pending"}>
                      {connection?.available ? "Connected" : "Setup pending"}
                    </Badge>
                  </div>
                ))}
              </section>
              <section className="admin-card admin-price-card">
                <span className="admin-eyebrow">Film pricing</span>
                <h2>Provider cost + your markup</h2>
                <p>
                  Set the percentage above MagicLight's production cost. A reference
                  credit rate is not a final film quote.
                </p>
                <div className="admin-reference-rate">
                  <strong>
                    {overview?.pricing
                      ? `${(overview.pricing.markupBasisPoints / 100).toFixed(2)}%`
                      : "—"}
                  </strong>
                  <span>Current markup above provider cost</span>
                </div>
                {overview?.pricing?.referenceRate && (
                  <p className="admin-fineprint">
                    Reference:{" "}
                    {money(
                      overview.pricing.referenceRate.amountCents,
                      overview.pricing.currency,
                    )}{" "}
                    per {overview.pricing.referenceRate.credits.toLocaleString()} credits.
                  </p>
                )}
                <div className="admin-price-status">
                  <AlertCircle size={17} />
                  <span>
                    {overview?.pricing?.estimate?.reason ||
                      "A verified production quote and payment connection are required before charging for a film."}
                  </span>
                </div>
                <button className="text-button" onClick={() => chooseTab("pricing")}>
                  Manage pricing
                  <ArrowRight size={15} />
                </button>
              </section>
            </div>
            <div className="admin-quick-links">
              {[
                {
                  tab: "people" as const,
                  title: "People & access",
                  description: "Review customers and manage account access.",
                  icon: Users,
                },
                {
                  tab: "films" as const,
                  title: "Private film archive",
                  description: "Find saved family films and view available masters.",
                  icon: Film,
                },
                {
                  tab: "activity" as const,
                  title: "Activity history",
                  description: "Review recorded administrative changes.",
                  icon: Activity,
                },
              ].map((item) => (
                <button key={item.tab} onClick={() => chooseTab(item.tab)}>
                  <item.icon size={22} />
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </div>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
          </>
        )}{" "}
        {tab === "people" && (
          <>
            {isOwner && (
              <section className="admin-card admin-invite">
                <div>
                  <UserPlus size={25} />
                  <h2>Invite an administrator</h2>
                  <p>
                    Create a private invitation for a teammate. The link is shown here for
                    you to share.
                  </p>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void invite();
                  }}
                >
                  <label>
                    Teammate email
                    <input
                      type="email"
                      required
                      autoComplete="off"
                      value={inviteEmail}
                      disabled={busy}
                      maxLength={254}
                      placeholder="teammate@example.com"
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !inviteEmail.trim()}
                  >
                    {busy ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <UserPlus size={16} />
                    )}
                    Create invitation
                  </button>
                </form>
                {actionError && !dialog && (
                  <div className="admin-inline-error" role="alert">
                    {actionError}
                  </div>
                )}
                {invitation && (
                  <div className="admin-invitation-result">
                    <div>
                      <CheckCircle2 size={18} />
                      <strong>Private invitation created</strong>
                      <button
                        className="icon-button"
                        aria-label="Hide invitation link"
                        onClick={() => setInvitation(null)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <p>
                      Share only with the intended recipient. Expires{" "}
                      {date(invitation.expiresAt)}. This invitation has not been emailed.
                    </p>
                    <label>
                      Invitation link
                      <input
                        readOnly
                        value={invitation.inviteUrl}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                    <button
                      className="button secondary small"
                      onClick={() => void copyInvitation()}
                    >
                      <Copy size={15} />
                      Copy private link
                    </button>
                  </div>
                )}
              </section>
            )}
            <section className="admin-card">
              <div className="admin-section-heading">
                <div>
                  <h2>People & access</h2>
                  <p>
                    {people
                      ? `${people.users.length} account records loaded`
                      : "Verified account records"}
                    . Owner access is protected.
                  </p>
                </div>
                <SearchField
                  value={query}
                  setValue={setQuery}
                  placeholder="Search loaded people"
                />
              </div>
              {people && !displayedPeople.length ? (
                <Empty
                  icon={Users}
                  title={query ? "No matching people" : "No account records returned"}
                >
                  {query
                    ? "Try a name, email, role, or status."
                    : "Registered accounts will appear here when available."}
                </Empty>
              ) : (
                people && (
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Person</th>
                          <th>Access</th>
                          <th>Status</th>
                          <th>Joined / last sign-in</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedPeople.map((person) => (
                          <tr key={person.email}>
                            <td>
                              <strong>{person.name || "Name not provided"}</strong>
                              <span>{person.email}</span>
                            </td>
                            <td>
                              <Badge tone={person.role === "owner" ? "good" : "neutral"}>
                                {humanize(person.role)}
                              </Badge>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  person.status === "active"
                                    ? "good"
                                    : person.status === "suspended"
                                      ? "danger"
                                      : "pending"
                                }
                              >
                                {humanize(person.status)}
                              </Badge>
                            </td>
                            <td>
                              <span>{date(person.createdAt)}</span>
                              <small>Last sign-in: {date(person.lastLoginAt)}</small>
                            </td>
                            <td>
                              <div className="admin-row-actions">
                                {person.role === "owner" ? (
                                  <span className="admin-protected">
                                    <ShieldCheck size={14} />
                                    Protected owner
                                  </span>
                                ) : (
                                  <>
                                    <button
                                      className="text-button"
                                      disabled={busy || person.email === user.email}
                                      onClick={() => {
                                        setActionError("");
                                        setDialog({
                                          kind: "person",
                                          action:
                                            person.status === "suspended"
                                              ? "activate"
                                              : "suspend",
                                          person,
                                        });
                                      }}
                                    >
                                      {person.status === "suspended"
                                        ? "Activate"
                                        : "Suspend"}
                                    </button>
                                    {isOwner && person.role === "admin" && (
                                      <button
                                        className="text-button admin-danger-text"
                                        disabled={busy}
                                        onClick={() => {
                                          setActionError("");
                                          setDialog({
                                            kind: "person",
                                            action: "revokeAdmin",
                                            person,
                                          });
                                        }}
                                      >
                                        Remove admin
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </section>
          </>
        )}
        {tab === "payments" && (
          <section className="admin-card">
            <section
              className="admin-quickbooks-panel"
              aria-labelledby="quickbooks-connection-title"
            >
              <div className="admin-quickbooks-heading">
                <div className="admin-quickbooks-symbol">
                  <CreditCard size={25} />
                </div>
                <div>
                  <span className="admin-eyebrow">Business authorization</span>
                  <h2 id="quickbooks-connection-title">QuickBooks connection</h2>
                  <p>
                    Connect the business account, then verify payment readiness
                    separately.
                  </p>
                </div>
                <Badge tone={quickBooks?.connected ? "good" : "pending"}>
                  {quickBooks?.remoteReviewRequired
                    ? "Review required"
                    : quickBooks?.connected
                      ? "Authorization saved"
                      : !quickBooks
                        ? loading
                          ? "Checking status"
                          : "Status unavailable"
                        : quickBooks.authorizationStatus === "not-configured"
                          ? "Setup required"
                          : quickBooks.authorizationStatus === "authorizing"
                            ? "Authorization in progress"
                            : needsQuickBooksReconnect
                              ? "Reconnect needed"
                              : "Awaiting authorization"}
                </Badge>
              </div>
              {quickBooksReturn && (
                <div className="admin-quickbooks-return" role="status">
                  {quickBooksReturn === "connected"
                    ? "Returned from QuickBooks. This page checks the saved authorization with the server; returning here does not enable payments."
                    : quickBooksReturn === "denied"
                      ? "QuickBooks authorization was declined or cancelled. No new authorization was completed."
                      : "QuickBooks could not complete the return. Review the current status below before trying again."}
                </div>
              )}
              {authorizationMessage && (
                <div className="admin-quickbooks-return" role="status">
                  {authorizationMessage}
                </div>
              )}
              <p className="admin-quickbooks-message">
                {quickBooks?.message ||
                  "The business authorization has not yet been verified."}
              </p>
              {quickBooksError && (
                <div className="admin-inline-error" role="alert">
                  {quickBooksError}
                </div>
              )}
              <div className="admin-quickbooks-readiness">
                <div>
                  <span>Account authorization</span>
                  <strong>
                    {quickBooks?.connected ? "Saved for this app" : "Not verified"}
                  </strong>
                  <small>
                    {quickBooks?.lastConnectedAt
                      ? `Last authorized ${date(quickBooks.lastConnectedAt)}`
                      : "Only the owner can authorize the connection."}
                    {quickBooks?.environment === "sandbox" ? " Test environment." : ""}
                  </small>
                </div>
                <div>
                  <span>Customer payments & refunds</span>
                  <strong>Unavailable</strong>
                  <small>
                    Saving QuickBooks authorization does not activate charges or refunds.
                  </small>
                </div>
              </div>
              <div className="admin-quickbooks-actions">
                {isOwner ? (
                  <>
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        loading ||
                        authorizationTracking ||
                        quickBooks?.pending ||
                        (quickBooks?.remoteReviewRequired &&
                          !hasQuickBooksAuthorization) ||
                        (!hasQuickBooksAuthorization && !quickBooks?.configured) ||
                        !Number.isInteger(quickBooks?.revision)
                      }
                      onClick={() => {
                        if (hasQuickBooksAuthorization) {
                          setActionError("");
                          setDialog({ kind: "disconnectQuickBooks" });
                        } else void connectQuickBooks();
                      }}
                    >
                      {busy && !dialog ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <ShieldCheck size={16} />
                      )}
                      {hasQuickBooksAuthorization
                        ? "Disconnect before reconnecting"
                        : needsQuickBooksReconnect
                          ? "Reconnect QuickBooks"
                          : "Connect QuickBooks"}
                    </button>
                    {!hasQuickBooksAuthorization && quickBooks?.pending && (
                      <button
                        className="button secondary"
                        disabled={busy || loading}
                        onClick={() => {
                          setActionError("");
                          setDialog({ kind: "disconnectQuickBooks" });
                        }}
                      >
                        Disconnect
                      </button>
                    )}
                    <p>
                      {hasQuickBooksAuthorization
                        ? "To change or renew authorization, disconnect the saved connection first. Existing order records stay here."
                        : "Complete authorization in the opened Intuit window, then return here."}
                    </p>
                  </>
                ) : (
                  <p>
                    The owner manages QuickBooks authorization. Administrators can review
                    its status here.
                  </p>
                )}
              </div>
            </section>
            <div className="admin-section-heading">
              <div>
                <h2>Payments & refunds</h2>
                <p>
                  Customer order records. Business authorization and payment readiness are
                  verified separately.
                </p>
              </div>
              <button
                className="button secondary small"
                disabled={!displayedOrders.length || loading}
                onClick={() => {
                  exportPayments(displayedOrders);
                  notify(`${displayedOrders.length} loaded payment records exported.`);
                }}
              >
                <Download size={15} />
                Export loaded rows
              </button>
            </div>
            <div className="admin-feedback info">
              <AlertCircle size={18} />
              <div>
                <strong>Customer charges and refunds remain unavailable</strong>
                <p>
                  {payments?.reason ||
                    overview?.connections.billing.reason ||
                    "QuickBooks payment access must be verified before this app can charge a customer or issue a refund."}
                </p>
              </div>
            </div>
            <div className="admin-list-toolbar">
              <SearchField
                value={query}
                setValue={setQuery}
                placeholder="Search loaded payments"
              />
              <span>
                {payments?.orders.length ?? "—"} records loaded · amounts shown in each
                order's currency
              </span>
            </div>
            {payments && !displayedOrders.length ? (
              <Empty
                icon={CreditCard}
                title={query ? "No matching payments" : "No payment records yet"}
              >
                {query
                  ? "Try an order number, customer email, film title, or status."
                  : "Confirmed customer orders will appear here when they are recorded."}
              </Empty>
            ) : (
              payments && (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Customer / film</th>
                        <th>Order</th>
                        <th>Status</th>
                        <th>Amount / refunded</th>
                        <th>Created</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedOrders.map((order) => (
                        <tr key={order.id}>
                          <td>
                            <strong>{order.filmTitle || "Untitled film"}</strong>
                            <span>{order.customerEmail}</span>
                          </td>
                          <td>
                            <span className="admin-record-id">{order.id}</span>
                            <small>
                              {order.provider === "quickbooks"
                                ? "QuickBooks"
                                : order.provider}
                            </small>
                          </td>
                          <td>
                            <Badge
                              tone={
                                order.status === "paid"
                                  ? "good"
                                  : /failed|cancel/.test(order.status)
                                    ? "danger"
                                    : "neutral"
                              }
                            >
                              {humanize(order.status)}
                            </Badge>
                          </td>
                          <td>
                            <strong>{money(order.amountCents, order.currency)}</strong>
                            <small>
                              {money(order.refundedCents || 0, order.currency)} refunded
                            </small>
                          </td>
                          <td>{date(order.createdAt)}</td>
                          <td>
                            <button
                              className="text-button"
                              disabled={
                                busy ||
                                ![
                                  "paid",
                                  "partially_refunded",
                                  "partially-refunded",
                                ].includes(order.status) ||
                                order.amountCents <= (order.refundedCents || 0)
                              }
                              onClick={() => openRefund(order)}
                            >
                              Review refund
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </section>
        )}
        {tab === "pricing" && (
          <section className="admin-card admin-pricing-editor">
            <div className="admin-section-heading">
              <div>
                <h2>Set your film markup</h2>
                <p>
                  Choose the percentage added above MagicLight's verified production cost.
                </p>
              </div>
              <Percent size={24} />
            </div>
            <div className="admin-pricing-columns">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void savePricing();
                }}
              >
                <label>
                  Markup percentage
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="0.01"
                    inputMode="decimal"
                    value={markup}
                    disabled={busy || loading || !pricing}
                    onChange={(e) => setMarkup(e.target.value)}
                    placeholder="0.00"
                    required
                  />
                  <small>
                    0% passes through the provider cost. You can set 0% to 1,000%.
                  </small>
                </label>
                <p>
                  Applies to new quotes only. Recorded orders and their original prices
                  remain unchanged.
                </p>
                {pricing && (
                  <p className="admin-fineprint">
                    Current saved markup: {(pricing.markupBasisPoints / 100).toFixed(2)}%
                    {pricing.updatedAt ? ` · Updated ${date(pricing.updatedAt)}` : ""}
                    {pricing.updatedBy ? ` by ${pricing.updatedBy}` : ""}
                  </p>
                )}
                {actionError && (
                  <div className="admin-inline-error" role="alert">
                    {actionError}
                  </div>
                )}
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    loading ||
                    !pricing ||
                    !validMarkup ||
                    Math.round(markupPercent * 100) === pricing.markupBasisPoints
                  }
                >
                  {busy ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  Save {validMarkup ? `${markupPercent.toFixed(2)}%` : ""} markup
                </button>
              </form>
              <div className="admin-price-example">
                <Badge>Illustrative example</Badge>
                <h3>A film that costs $10.00 to produce</h3>
                <div>
                  <span>MagicLight provider cost</span>
                  <strong>$10.00</strong>
                </div>
                <div>
                  <span>
                    Your markup {validMarkup ? `(${markupPercent.toFixed(2)}%)` : ""}
                  </span>
                  <strong>
                    {validMarkup ? money(Math.round((1000 * markupPercent) / 100)) : "—"}
                  </strong>
                </div>
                <div className="admin-price-total">
                  <span>Customer film price</span>
                  <strong>
                    {validMarkup
                      ? money(Math.round(1000 * (1 + markupPercent / 100)))
                      : "—"}
                  </strong>
                </div>
                <p>
                  This is a pricing illustration, not a film quote or payment. Actual
                  production still requires a verified MagicLight quote and the payment
                  connection.
                </p>
              </div>
            </div>
          </section>
        )}
        {tab === "films" && (
          <section className="admin-card">
            <div className="admin-section-heading">
              <div>
                <h2>The private film archive</h2>
                <p>
                  Films intentionally saved to the shared service, with account ownership
                  retained.
                </p>
              </div>
              <SearchField
                value={query}
                setValue={setQuery}
                placeholder="Search loaded films"
              />
            </div>
            <p className="admin-fineprint">
              {films?.films.length ?? "—"} films loaded. Projects stored only in a
              customer's browser do not appear here.
            </p>
            {films && !displayedFilms.length ? (
              <Empty
                icon={Film}
                title={
                  query
                    ? "No matching films"
                    : "The archive is waiting for its first film"
                }
              >
                {query
                  ? "Try an ancestor, title, customer email, or status."
                  : "Saved film records will appear here. A master can be played only when its video has been uploaded."}
              </Empty>
            ) : (
              films && (
                <div className="admin-film-grid">
                  {displayedFilms.map((film) => (
                    <article
                      className="admin-film-card"
                      key={`${film.ownerEmail}:${film.id}`}
                    >
                      <div className="admin-film-art">
                        <Film size={31} />
                        <Badge tone={film.hasVideo ? "good" : "pending"}>
                          {film.hasVideo ? "Video available" : "Record only"}
                        </Badge>
                      </div>
                      <div className="admin-film-info">
                        <h3>{film.title || "Untitled family film"}</h3>
                        <p>{film.ancestor || "Ancestor not specified"}</p>
                        <span className="admin-film-owner">{film.ownerEmail}</span>
                        <div className="admin-film-meta">
                          <span>{formatDuration(film.duration || 0)}</span>
                          <span>{humanize(film.status)}</span>
                        </div>
                        <small>Updated {date(film.updatedAt || film.createdAt)}</small>
                        <div className="admin-film-actions">
                          <button
                            className="button secondary small"
                            disabled={!film.hasVideo}
                            onClick={() => {
                              setActionError("");
                              setDialog({ kind: "film", film });
                            }}
                          >
                            <Play size={14} />
                            Watch film
                          </button>
                          {film.hasVideo && (
                            <a className="text-button" href={mediaUrl(film)} download>
                              <Download size={14} />
                              Download
                            </a>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )
            )}
          </section>
        )}
        {tab === "activity" && (
          <section className="admin-card">
            <div className="admin-section-heading">
              <div>
                <h2>Activity history</h2>
                <p>Recorded administrative actions and their account context.</p>
              </div>
              <SearchField
                value={query}
                setValue={setQuery}
                placeholder="Search loaded activity"
              />
            </div>
            {audit && !displayedEvents.length ? (
              <Empty
                icon={Activity}
                title={query ? "No matching activity" : "No activity records returned"}
              >
                {query
                  ? "Try an administrator email, action, or affected account."
                  : "Administrative events will appear here as they are recorded."}
              </Empty>
            ) : (
              audit && (
                <div className="admin-activity-list">
                  {displayedEvents.map((event) => (
                    <article key={event.id}>
                      <div className="admin-event-icon">
                        <Activity size={17} />
                      </div>
                      <div>
                        <h3>{humanize(event.action)}</h3>
                        <p>
                          {event.actor || "System"}
                          {event.target ? ` → ${event.target}` : ""}
                        </p>
                        {auditDetails(event.details) && (
                          <small>{auditDetails(event.details)}</small>
                        )}
                      </div>
                      <time dateTime={event.at}>{date(event.at)}</time>
                    </article>
                  ))}
                </div>
              )
            )}
          </section>
        )}
        {cursor && (
          <div className="admin-pagination">
            <p>Search and exports cover the records loaded so far.</p>
            <button
              className="button secondary"
              disabled={loading || loadingMore || busy}
              onClick={() => void loadMore()}
            >
              {loadingMore ? (
                <Loader2 className="spin" size={15} />
              ) : (
                <ArrowRight size={15} />
              )}
              Load more records
            </button>
          </div>
        )}
        <p className="admin-updated">
          {updated ? `Last refresh ${date(updated)}` : "Checking administrative records"}{" "}
          · Access and actions are verified by the server.
        </p>
      </div>{" "}
      {dialog && (
        <div
          className="admin-modal-backdrop"
          onClick={() => {
            if (!busy) setDialog(null);
          }}
        >
          <div
            className={`admin-modal ${dialog.kind === "film" ? "admin-video-modal" : ""}`}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-heading">
              <h2 id="admin-dialog-title">
                {dialog.kind === "film"
                  ? dialog.film.title || "Family film"
                  : dialog.kind === "refund"
                    ? "Review customer refund"
                    : dialog.kind === "disconnectQuickBooks"
                      ? "Disconnect QuickBooks"
                      : dialog.action === "revokeAdmin"
                        ? "Remove administrator access"
                        : dialog.action === "suspend"
                          ? "Suspend account access"
                          : "Restore account access"}
              </h2>
              <button
                className="icon-button"
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                <X size={19} />
              </button>
            </div>
            {dialog.kind === "disconnectQuickBooks" && (
              <>
                <p>
                  Disconnecting removes this app's stored QuickBooks authorization and
                  requests that Intuit revoke its access. Your customer accounts, order
                  records, and archived films remain here.
                </p>
                <p>
                  The owner will need to authorize QuickBooks again before this app can
                  use the connection. Customer charges and refunds remain unavailable.
                </p>
                <div className="admin-modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    Keep connection
                  </button>
                  <button
                    className="button admin-danger"
                    disabled={busy || !isOwner || !quickBooks}
                    onClick={() => void disconnectQuickBooks()}
                  >
                    {busy && <Loader2 size={16} className="spin" />}
                    Disconnect QuickBooks
                  </button>
                </div>
              </>
            )}
            {dialog.kind === "film" && (
              <>
                <p>
                  {dialog.film.ancestor} · {dialog.film.ownerEmail}
                </p>
                <video
                  key={dialog.film.id}
                  controls
                  playsInline
                  src={mediaUrl(dialog.film)}
                  onError={() =>
                    setActionError(
                      "The archived video could not be loaded. Refresh the archive and try again.",
                    )
                  }
                />
                <a className="button secondary" href={mediaUrl(dialog.film)} download>
                  <Download size={16} />
                  Download film
                </a>
              </>
            )}
            {dialog.kind === "person" && (
              <>
                <p>
                  <strong>{dialog.person.name || dialog.person.email}</strong>
                  <br />
                  {dialog.person.email}
                </p>
                <p>
                  {dialog.action === "revokeAdmin"
                    ? "This removes access to administration. The person's customer account and family films remain associated with their account."
                    : dialog.action === "suspend"
                      ? "This prevents the account from accessing the application until an administrator restores access. It does not delete the account or its films."
                      : "This allows the account to access the application again."}
                </p>
                <div className="admin-modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className={`button ${dialog.action === "activate" ? "primary" : "admin-danger"}`}
                    disabled={busy || dialog.person.role === "owner"}
                    onClick={() => void confirmPersonAction(dialog)}
                  >
                    {busy && <Loader2 className="spin" size={15} />}{" "}
                    {dialog.action === "activate"
                      ? "Restore access"
                      : dialog.action === "suspend"
                        ? "Suspend access"
                        : "Remove admin access"}
                  </button>
                </div>
              </>
            )}
            {dialog.kind === "refund" && (
              <>
                <div className="admin-refund-summary">
                  <span>{dialog.order.customerEmail}</span>
                  <strong>{dialog.order.filmTitle || "Untitled film"}</strong>
                  <p>
                    {money(dialog.order.amountCents, dialog.order.currency)} paid ·{" "}
                    {money(dialog.order.refundedCents || 0, dialog.order.currency)}{" "}
                    already refunded
                  </p>
                </div>
                {!refundReady && (
                  <div className="admin-feedback info">
                    <AlertCircle size={18} />
                    <p>
                      Refund submission is not enabled. QuickBooks account authorization
                      alone does not activate customer payments or refunds. No refund will
                      be submitted from this screen.
                    </p>
                  </div>
                )}
                <label>
                  Refund amount ({dialog.order.currency})
                  <input
                    inputMode="decimal"
                    value={refundAmount}
                    disabled={busy}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                  <small>
                    Maximum remaining amount:{" "}
                    {money(refundableCents, dialog.order.currency)}
                  </small>
                </label>
                <label>
                  Reason for this refund
                  <textarea
                    rows={3}
                    value={refundReason}
                    maxLength={1000}
                    disabled={busy}
                    onChange={(e) => setRefundReason(e.target.value)}
                    placeholder="Record why this refund is being issued"
                  />
                </label>
                <label className="admin-check">
                  <input
                    type="checkbox"
                    checked={refundConfirmed}
                    disabled={busy || !refundReady}
                    onChange={(e) => setRefundConfirmed(e.target.checked)}
                  />
                  I confirm this refund to the customer's original payment method. Once
                  submitted successfully, it cannot be undone.
                </label>
                <div className="admin-modal-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setDialog(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button admin-danger"
                    disabled={
                      busy ||
                      !refundReady ||
                      !refundConfirmed ||
                      amountCents <= 0 ||
                      amountCents > refundableCents ||
                      refundReason.trim().length < 3
                    }
                    onClick={() => void submitRefund(dialog)}
                  >
                    {busy && <Loader2 className="spin" size={15} />}Issue{" "}
                    {money(amountCents, dialog.order.currency)} refund
                  </button>
                </div>
              </>
            )}
            {actionError && (
              <div className="admin-inline-error" role="alert">
                {actionError}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
