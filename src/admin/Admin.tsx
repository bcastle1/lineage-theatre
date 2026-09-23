import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  Film,
  FileText,
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
import ProductionPreparation from "../studio/ProductionPreparation";
import QuickBooksPaymentTest from "./QuickBooksPaymentTest";
import HostedCheckoutSettings from "./HostedCheckoutSettings";
import SourceAgreementEditor from "./SourceAgreementEditor";
import "./admin.css";

type Tab = "overview" | "people" | "payments" | "pricing" | "agreement" | "films" | "activity";
type Connection = { available: boolean; reason: string };
type Pricing = {
  markupBasisPoints: number;
  planningCreditsPerClip: number;
  planningSecondsPerClip: number;
  planningRendersPerClip: number;
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
    hostedRefundsUnverified?: number;
    testOrders?: number;
    currency: string;
  };
  connections: { story: Connection; magiclight: Connection; billing: Connection };
  quality?: { preference: string; label: string; verified: boolean };
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
  accessStatus: User["accessStatus"];
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
  sandbox?: boolean;
  managedPayment?: boolean;
  checkoutMethod?: string | null;
  requiresReview?: boolean;
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
type RegistrationPolicy = {
  approvalRequired: boolean;
  revision: number;
  updatedAt?: string | null;
  updatedBy?: string | null;
};
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
  refreshStatus?: string;
  lastRefreshedAt?: string | null;
  accessTokenStorage?: "memory-only" | "migration-required" | "none";
  realmId?: string | null;
  revocationStatus?: string | null;
  companyVerification?: {
    verifiedAt: string;
    companyName: string;
    legalName: string | null;
    country: string | null;
    accountingAccessVerified: true;
  } | null;
  paymentReady: false;
  refundReady: false;
  message: string;
};
function verifiedQuickBooksCompany(status: QuickBooksStatus | null) {
  return status?.connected &&
    !status.pending &&
    !status.remoteReviewRequired &&
    status.companyVerification?.accountingAccessVerified === true
    ? status.companyVerification
    : null;
}
type AuthorizationAttempt = {
  url: string;
  revision: number;
  expiresAt: number;
};
function authorizationAttemptCurrent(
  attempt: AuthorizationAttempt | null,
  status: QuickBooksStatus | null,
  isOwner: boolean,
) {
  return Boolean(
    isOwner &&
      attempt &&
      attempt.expiresAt > Date.now() &&
      (!status ||
        status.revision < attempt.revision ||
        (status.revision === attempt.revision &&
          status.pending &&
          !status.connected &&
          !status.remoteReviewRequired)),
  );
}
type FilmsData = { films: ArchivedFilm[]; cursor?: string };
type AuditData = { events: AuditEvent[]; cursor?: string };
type PersonAction = {
  kind: "person";
  action: "approve" | "suspend" | "activate" | "revokeAdmin";
  person: Person;
};
type RefundAction = { kind: "refund"; order: Order; idempotencyKey: string };
type Dialog =
  | PersonAction
  | RefundAction
  | { kind: "film"; film: ArchivedFilm }
  | { kind: "registrationPolicy"; approvalRequired: boolean; expectedRevision: number }
  | { kind: "disconnectQuickBooks" };
const tabs = [
  { id: "overview" as const, name: "Overview", icon: LayoutDashboard },
  { id: "people" as const, name: "People", icon: Users },
  { id: "payments" as const, name: "Payments", icon: CreditCard },
  { id: "pricing" as const, name: "Pricing", icon: Percent },
  { id: "agreement" as const, name: "Source agreement", icon: FileText },
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
      "Payment type",
      "Refund verification",
    ],
    ...orders.map((o) => [
      o.id,
      o.customerEmail,
      o.filmTitle,
      o.checkoutMethod === "quickbooks-hosted-invoice" && o.status === "captured" ? "Payment recorded by QuickBooks" : o.status,
      o.currency,
      (o.amountCents / 100).toFixed(2),
      o.checkoutMethod === "quickbooks-hosted-invoice" ? "" : ((o.refundedCents || 0) / 100).toFixed(2),
      o.createdAt,
      o.provider,
      o.sandbox ? "Test payment" : "Live payment",
      o.checkoutMethod === "quickbooks-hosted-invoice" ? "Not verified; check QuickBooks" : "Recorded confirmed refunds",
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
  const [registrationPolicy, setRegistrationPolicy] = useState<RegistrationPolicy | null>(null);
  const [registrationPolicyError, setRegistrationPolicyError] = useState("");
  const [payments, setPayments] = useState<PaymentsData | null>(null);
  const [quickBooks, setQuickBooks] = useState<QuickBooksStatus | null>(null);
  const [quickBooksError, setQuickBooksError] = useState("");
  const [verifyingCompany, setVerifyingCompany] = useState(false);
  const [refreshingAuthorization, setRefreshingAuthorization] = useState(false);
  const [quickBooksReturn, setQuickBooksReturn] = useState(paymentCallbackResult);
  const [authorizationCheck, setAuthorizationCheck] = useState(0);
  const [authorizationAttempt, setAuthorizationAttempt] =
    useState<AuthorizationAttempt | null>(null);
  const authorizationTracking = Boolean(authorizationAttempt);
  const [authorizationMessage, setAuthorizationMessage] = useState("");
  const [films, setFilms] = useState<FilmsData | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [markup, setMarkup] = useState("");
  const [planningCredits, setPlanningCredits] = useState("");
  const [planningSeconds, setPlanningSeconds] = useState("");
  const [planningRenders, setPlanningRenders] = useState("");
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
  const adminMounted = useRef(true);
  const isOwner = user.role === "owner";
  const isAdministrator = isOwner || user.role === "admin";
  useEffect(() => {
    adminMounted.current = true;
    return () => {
      adminMounted.current = false;
      authorizationPopup.current = null;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++requestNumber.current;
    setLoading(true);
    setError("");
    setOverviewError("");
    if (tab === "payments") setQuickBooksError("");
    if (tab === "people") setRegistrationPolicyError("");
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
        const policyRequest = api<RegistrationPolicy>("/api/admin?action=registrationPolicy")
          .then(result => { if (request === requestNumber.current) setRegistrationPolicy(result); })
          .catch(e => {
            if (request === requestNumber.current) {
              setRegistrationPolicy(null);
              setRegistrationPolicyError(errorText(e));
            }
          });
        try {
          const result = await api<PeopleData>("/api/admin?action=users");
          if (request === requestNumber.current) setPeople(result);
        } finally { await policyRequest; }
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
          setPlanningCredits(String(result.planningCreditsPerClip));
          setPlanningSeconds(String(result.planningSecondsPerClip));
          setPlanningRenders(String(result.planningRendersPerClip));
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
        setAuthorizationAttempt(null);
        authorizationPopup.current = null;
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
    if (!authorizationAttempt) return;
    if (!authorizationAttemptCurrent(authorizationAttempt, quickBooks, isOwner)) {
      setAuthorizationAttempt(null);
      authorizationPopup.current = null;
      setAuthorizationMessage(
        quickBooks?.connected
          ? "QuickBooks authorization is saved. Check the hosted checkout setup below."
          : "This authorization link is no longer active. Review the current connection status below.",
      );
    }
  }, [authorizationAttempt, quickBooks, isOwner]);
  useEffect(() => {
    if (!authorizationAttempt || !isOwner) return;
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
        setAuthorizationAttempt(null);
        authorizationPopup.current = null;
        setAuthorizationMessage(
          "This authorization link has expired. Close the Intuit window and use Refresh to check the saved status before starting again.",
        );
      },
      Math.max(0, authorizationAttempt.expiresAt - Date.now()),
    );
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener("focus", onFocus);
    };
  }, [authorizationAttempt, isOwner]);
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
    if (action.action === "approve" && (action.person.role !== "customer" || action.person.accessStatus !== "pending")) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{ message?: string; user: Person }>("/api/admin", {
        action: action.action,
        email: action.person.email,
      });
      if (result.user?.email !== action.person.email ||
        (action.action === "approve" && result.user.accessStatus !== "approved") ||
        (action.action === "suspend" && result.user.accessStatus !== "suspended") ||
        (action.action === "activate" && !["approved", "pending"].includes(result.user.accessStatus)) ||
        (action.action === "revokeAdmin" && result.user.role !== "customer")) {
        throw new Error("The saved account change could not be confirmed. Refresh People before trying again.");
      }
      setPeople(previous => previous ? { ...previous, users: previous.users.map(person => person.email === result.user.email ? result.user : person) } : previous);
      setDialog(null);
      notify(result.message || (action.action === "approve" ? `${result.user.email} is approved for studio access.` : "Account access updated."));
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function confirmRegistrationPolicy(action: Extract<Dialog, { kind: "registrationPolicy" }>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<RegistrationPolicy>("/api/admin", {
        action: "updateRegistrationPolicy",
        approvalRequired: action.approvalRequired,
        expectedRevision: action.expectedRevision,
      });
      if (result.approvalRequired !== action.approvalRequired || !Number.isInteger(result.revision) || result.revision <= action.expectedRevision) {
        throw new Error("The saved registration policy could not be confirmed. Refresh People before trying again.");
      }
      setRegistrationPolicy(result);
      setDialog(null);
      notify(result.approvalRequired
        ? "New registrations will require administrator approval."
        : "New registrations can enter the studio immediately. Accounts already waiting still need approval.");
      await refresh();
    } catch (e) { setActionError(errorText(e)); }
    finally { actionLock.current = false; setBusy(false); }
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
  const companyVerification = verifiedQuickBooksCompany(quickBooks);
  const canRefreshQuickBooks = Boolean(
    isOwner && quickBooks?.configured && hasQuickBooksAuthorization &&
    ["expired", "authorized"].includes(quickBooks.authorizationStatus) &&
    !quickBooks.pending && !quickBooks.remoteReviewRequired &&
    Number.isSafeInteger(quickBooks.revision),
  );
  async function refreshQuickBooksAuthorization() {
    if (!canRefreshQuickBooks || !quickBooks || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setRefreshingAuthorization(true);
    setQuickBooksError("");
    try {
      const result = await api<QuickBooksStatus & { refreshed: boolean }>("/api/quickbooks", {
        action: "refresh", expectedRevision: quickBooks.revision,
      });
      if (!adminMounted.current) return;
      setQuickBooks(result);
      if (result.connected && !result.pending && !result.remoteReviewRequired) {
        notify(result.refreshed
          ? "Authorization renewed. No payment was made."
          : "The existing authorization is still current. No payment was made.", "info");
      } else {
        setQuickBooksError("Authorization renewal was not confirmed. Review its status before another action.");
      }
    } catch (e) {
      if (adminMounted.current) {
        setQuickBooksError(errorText(e));
        // Read the result of the single attempt; never retry a token rotation.
        try {
          const current = await api<QuickBooksStatus>("/api/quickbooks?action=status");
          if (adminMounted.current) setQuickBooks(current);
        } catch {
          if (adminMounted.current) setQuickBooks(null);
        }
      }
    } finally {
      actionLock.current = false;
      if (adminMounted.current) { setBusy(false); setRefreshingAuthorization(false); }
    }
  }
  async function verifyQuickBooksCompany() {
    if (
      !isOwner ||
      !quickBooks?.connected ||
      quickBooks.pending ||
      quickBooks.remoteReviewRequired ||
      !Number.isInteger(quickBooks.revision) ||
      actionLock.current
    )
      return;
    actionLock.current = true;
    setBusy(true);
    setVerifyingCompany(true);
    setQuickBooksError("");
    try {
      const result = await api<QuickBooksStatus>("/api/quickbooks", {
        action: "verifyCompany",
        expectedRevision: quickBooks.revision,
      });
      if (!adminMounted.current) return;
      setQuickBooks(result);
      if (verifiedQuickBooksCompany(result)) {
        notify(
          "Company verified for accounting access. Review the hosted checkout setup below.",
          "info",
        );
      } else {
        setQuickBooksError(
          "Company verification was not confirmed. Refresh the connection status before trying again.",
        );
      }
    } catch (e) {
      if (adminMounted.current) {
        setQuickBooks((previous) =>
          previous ? { ...previous, companyVerification: null } : previous,
        );
        setQuickBooksError(errorText(e));
      }
    } finally {
      actionLock.current = false;
      if (adminMounted.current) {
        setBusy(false);
        setVerifyingCompany(false);
      }
    }
  }
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
    const startedAt = Date.now();
    try {
      popup.opener = null;
      popup.document.title = "Opening QuickBooks authorization";
      popup.document.body.textContent = "Opening secure QuickBooks authorization…";
      const result = await api<{
        authorizationUrl: string;
        revision: number;
        expiresAt: string;
      }>("/api/quickbooks", {
        action: "start",
        expectedRevision: quickBooks.revision,
        replaceExisting: false,
      });
      const authorization = new URL(result.authorizationUrl);
      const expiresAt = Math.min(
        Date.parse(result.expiresAt),
        startedAt + 10 * 60 * 1000,
      );
      if (
        authorization.origin !== "https://appcenter.intuit.com" ||
        authorization.pathname !== "/connect/oauth2" ||
        authorization.username ||
        authorization.password ||
        !Number.isInteger(result.revision) ||
        result.revision !== quickBooks.revision + 1 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        throw new Error(
          "The QuickBooks authorization link could not be verified. Refresh and try again.",
        );
      if (!adminMounted.current) {
        popup.close();
        return;
      }
      setAuthorizationAttempt({
        url: authorization.href,
        revision: result.revision,
        expiresAt,
      });
      setQuickBooks((previous) =>
        previous && previous.revision > result.revision
          ? previous
          : {
              ...quickBooks,
              revision: result.revision,
              pending: true,
              authorizationStatus: "authorizing",
              message:
                "An authorization request has started. Complete the Intuit authorization to connect this app.",
            },
      );
      setAuthorizationMessage(
        "Complete authorization in the Intuit window, then return here. If the window did not appear, use Open QuickBooks authorization below. This page checks the saved status when you return.",
      );
      try {
        if (popup.closed) throw new Error("Authorization window unavailable");
        popup.location.replace(authorization.href);
      } catch {
        try {
          popup.close();
        } catch {
          /* The browser may have separated this window. */
        }
        authorizationPopup.current = null;
        setAuthorizationMessage(
          "Your authorization request is ready, but this browser did not show the Intuit window. Use Open QuickBooks authorization below, then return here.",
        );
      }
    } catch (e) {
      try {
        popup.close();
      } catch {
        /* The owner may already have closed it. */
      }
      authorizationPopup.current = null;
      if (adminMounted.current) {
        setAuthorizationAttempt(null);
        setAuthorizationMessage("");
        setQuickBooksError(errorText(e));
      }
    } finally {
      actionLock.current = false;
      if (adminMounted.current) setBusy(false);
    }
  }
  function reopenQuickBooksAuthorization(event: MouseEvent<HTMLAnchorElement>) {
    if (
      actionLock.current ||
      !authorizationAttemptCurrent(authorizationAttempt, quickBooks, isOwner)
    ) {
      event.preventDefault();
      if (!actionLock.current) {
        setAuthorizationAttempt(null);
        setAuthorizationMessage(
          "This authorization link is no longer active. Use Refresh to check the connection before starting again.",
        );
      }
      return;
    }
    // Let this direct, owner-driven link open the validated URL. It reuses the
    // original request and never extends its expiry or creates another grant.
    setAuthorizationMessage(
      "Complete authorization in the Intuit window, then return here. Opening this link does not confirm a connection or enable customer payments.",
    );
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
    setAuthorizationAttempt(null);
    authorizationPopup.current = null;
    setAuthorizationMessage("");
    setBusy(true);
    setActionError("");
    try {
      const result = await api<QuickBooksStatus>("/api/quickbooks", {
        action: "disconnect",
        expectedRevision: Math.max(
          quickBooks.revision,
          authorizationAttempt?.revision ?? 0,
        ),
      });
      setQuickBooks(result);
      setQuickBooksReturn("");
      setAuthorizationMessage("");
      setDialog(null);
      notify(
        result.message ||
          "QuickBooks authorization updated. Review the current checkout settings.",
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
  // Only saved sandbox orders use the test refund path. The server rechecks access.
  const refundReady = dialog?.kind === "refund" && dialog.order.sandbox === true && dialog.order.managedPayment === true;
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
      const result = await api<{ message?: string; requiresReview?: boolean }>("/api/admin", {
        action: "refund",
        orderId: action.order.id,
        amountCents,
        reason: refundReason.trim(),
        idempotencyKey: action.idempotencyKey,
      });
      setDialog(null);
      notify(
        result.message || (result.requiresReview
          ? "The test refund needs review. Do not submit another refund; check the saved order status."
          : "Test refund confirmed. No live money was moved."),
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
  async function paymentRecordAction(order: Order, action: "paymentDiagnostics" | "accountingExport" | "reconcilePayment") {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try {
      if (action === "reconcilePayment") {
        const result = await api<{ requiresReview: boolean }>("/api/admin", { action, orderId: order.id });
        notify(result.requiresReview ? "This order still needs review. No payment or refund was repeated." : "Saved payment status checked.", "info");
        await refresh();
      } else {
        const result = await api(`/api/admin?action=${action}&id=${encodeURIComponent(order.id)}`);
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url;
        link.download = `${order.sandbox ? "TEST-" : ""}${action}-${order.id}.json`;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        notify(action === "paymentDiagnostics" ? "Payment support details downloaded." : "Accounting review exported. Nothing was posted to your books.", "info");
      }
    } catch (e) { notify(errorText(e), "error"); }
    finally { actionLock.current = false; setBusy(false); }
  }
  const markupPercent = /^\d+(\.\d{0,2})?$/.test(markup) ? Number(markup) : NaN;
  const validMarkup =
    Number.isFinite(markupPercent) && markupPercent >= 0 && markupPercent <= 1000;
  const planningValues = {
    planningCreditsPerClip: /^\d+$/.test(planningCredits) ? Number(planningCredits) : NaN,
    planningSecondsPerClip: /^\d+$/.test(planningSeconds) ? Number(planningSeconds) : NaN,
    planningRendersPerClip: /^\d+$/.test(planningRenders) ? Number(planningRenders) : NaN,
  };
  const validPlanning = Object.entries(planningValues).every(([field, value]) => Number.isSafeInteger(value) && value >= 1
    && value <= (field === "planningCreditsPerClip" ? 1_000_000 : field === "planningSecondsPerClip" ? 60 : 20));
  const pricingChanged = pricing && (Math.round(markupPercent * 100) !== pricing.markupBasisPoints
    || planningValues.planningCreditsPerClip !== pricing.planningCreditsPerClip
    || planningValues.planningSecondsPerClip !== pricing.planningSecondsPerClip
    || planningValues.planningRendersPerClip !== pricing.planningRendersPerClip);
  async function savePricing() {
    if (!pricing || !validMarkup || !validPlanning || !pricingChanged || actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<Pricing>("/api/admin", {
        action: "updatePricing",
        markupPercent,
        ...planningValues,
        expectedRevision: pricing.revision,
      });
      setPricing(result);
      setMarkup((result.markupBasisPoints / 100).toFixed(2));
      setPlanningCredits(String(result.planningCreditsPerClip));
      setPlanningSeconds(String(result.planningSecondsPerClip));
      setPlanningRenders(String(result.planningRendersPerClip));
      notify(
        `Pricing settings saved with ${(result.markupBasisPoints / 100).toFixed(2)}% markup for new film prices. Existing orders are unchanged.`,
      );
      try {
        await onPricingChanged();
      } catch {
        notify(
          "Pricing settings saved. The film studio's pricing display could not refresh; reload it before reviewing a new quote.",
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
    matches(query, p.email, p.name, p.role, p.status, p.accessStatus),
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
        {tab === "agreement" && <SourceAgreementEditor disabled={busy || loading} actionLock={actionLock} onBusyChange={setBusy} />}
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
                  detail: overview?.stats.hostedRefundsUnverified
                    ? `Excludes ${overview.stats.hostedRefundsUnverified} hosted payments; check QuickBooks for their refunds`
                    : "Confirmed refund records",
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
            {(overview?.stats.testOrders ?? 0) > 0 && <p className="admin-fineprint">{overview?.stats.testOrders} test payments are excluded from the live payment and refund totals above.</p>}
            {isOwner && <ProductionPreparation operator />}
            <div className="admin-overview-grid">
              <section className="admin-card">
                <div className="admin-section-heading">
                  <div>
                    <h2>Studio status</h2>
                    <p>
                      Provider connections and production settings for administrators.
                      Readiness is reported by the application server.
                    </p>
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
                    <Badge
                      tone={connection ? (connection.available ? "good" : "pending") : "neutral"}
                    >
                      {connection
                        ? connection.available
                          ? "Connection verified"
                          : "Setup pending"
                        : loading
                          ? "Checking"
                          : "Not verified"}
                    </Badge>
                  </div>
                ))}
                <div className="admin-quality-status">
                  <div>
                    <h3>Production quality</h3>
                    <Badge tone={overview?.quality?.verified ? "good" : "pending"}>
                      {overview?.quality?.verified ? "Quality verified" : "Not verified"}
                    </Badge>
                  </div>
                  <p>
                    {overview?.quality
                      ? overview.quality.preference === "highest"
                        ? "Default preference: highest available animation and output quality."
                        : `Configured preference: ${overview.quality.preference}.`
                      : "The production quality preference could not be verified."}
                  </p>
                  <p>
                    {overview?.quality?.verified
                      ? overview.quality.label
                      : "Confirm MagicLight's supported settings before production. The final film also requires a verified service connection, production quote, and payment setup."}
                  </p>
                </div>
              </section>
              <section className="admin-card admin-price-card">
                <span className="admin-eyebrow">Film pricing</span>
                <h2>Provider cost + your markup</h2>
                <p>
                  Use an actual provider quote when available, or your saved planning
                  rates plus markup to set a fixed film price.
                </p>
                <div className="admin-reference-rate">
                  <strong>
                    {overview?.pricing
                      ? `${(overview.pricing.markupBasisPoints / 100).toFixed(2)}%`
                      : "—"}
                  </strong>
                  <span>Current markup above the production cost basis</span>
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
                    Film prices can be prepared from your planning rates. Saved customer
                    prices stay fixed. Payment and production readiness are verified separately.
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
            <section className="admin-card admin-registration-policy" aria-labelledby="registration-policy-title">
              <div className="admin-section-heading">
                <div>
                  <h2 id="registration-policy-title">Registration approval</h2>
                  <p>Control access for new accounts. Accounts already awaiting approval must be approved individually.</p>
                </div>
                <label className="admin-check">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={registrationPolicy?.approvalRequired ?? true}
                    disabled={busy || loading || !registrationPolicy}
                    onChange={event => {
                      if (!registrationPolicy) return;
                      setActionError("");
                      setDialog({ kind: "registrationPolicy", approvalRequired: event.target.checked, expectedRevision: registrationPolicy.revision });
                    }}
                  />
                  Require approval for new registrations
                </label>
              </div>
              {registrationPolicy ? <p>
                {registrationPolicy.approvalRequired
                  ? "New accounts wait for approval before entering the studio. Approve each employee's registered account below to give them access to the film and payment workflows without administrator permissions."
                  : "New accounts can enter the studio immediately. Payment and film production remain subject to their service availability and the customer's confirmation."}
              </p> : <p role="status">{registrationPolicyError ? "Registration policy is unavailable. Refresh to try again." : "Checking registration policy…"}</p>}
              {registrationPolicyError && <p className="admin-inline-error" role="alert">{registrationPolicyError}</p>}
              {registrationPolicy?.updatedAt && <p className="field-note">Updated {date(registrationPolicy.updatedAt)}{registrationPolicy.updatedBy ? ` by ${registrationPolicy.updatedBy}` : ""}.</p>}
            </section>
            {isOwner && (
              <section className="admin-card admin-invite">
                <div>
                  <UserPlus size={25} />
                  <h2>Invite an administrator</h2>
                  <p>
                    Grant administration only to teammates who manage the application.
                    Employees testing films and payments can register normally and be approved below.
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
                    . Approval grants studio access; administrator invitations grant management permissions. Owner access is protected.
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
                                  person.accessStatus === "approved"
                                    ? "good"
                                    : person.accessStatus === "suspended"
                                      ? "danger"
                                      : "pending"
                                }
                              >
                                {person.accessStatus === "approved" ? "Approved" : person.accessStatus === "suspended" ? "Suspended" : "Awaiting approval"}
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
                                    {person.role === "customer" && person.accessStatus === "pending" && (
                                      <button
                                        className="button primary small"
                                        disabled={busy}
                                        onClick={() => {
                                          setActionError("");
                                          setDialog({ kind: "person", action: "approve", person });
                                        }}
                                      >Approve account</button>
                                    )}
                                    <button
                                      className="text-button"
                                      disabled={busy || person.email === user.email}
                                      onClick={() => {
                                        setActionError("");
                                        setDialog({
                                          kind: "person",
                                          action:
                                            person.accessStatus === "suspended"
                                              ? "activate"
                                              : "suspend",
                                          person,
                                        });
                                      }}
                                    >
                                      {person.accessStatus === "suspended"
                                        ? "Restore account"
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
              {authorizationAttemptCurrent(authorizationAttempt, quickBooks, isOwner) &&
                authorizationAttempt && (
                  <div className="admin-quickbooks-fallback">
                    <a
                      className="button secondary"
                      href={authorizationAttempt.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={reopenQuickBooksAuthorization}
                      aria-disabled={busy}
                    >
                      Open QuickBooks authorization <ArrowRight size={16} />
                    </a>
                    <p>
                      Use this if the Intuit window is missing. Opens the same request in
                      a new window or tab; available until{" "}
                      {new Date(authorizationAttempt.expiresAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      .
                    </p>
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
                    {quickBooks?.accessTokenStorage === "memory-only" ? " Access tokens stay in server memory only."
                      : quickBooks?.accessTokenStorage === "migration-required" ? " Refresh authorization to update token storage." : ""}
                  </small>
                </div>
                <div>
                  <span>Hosted checkout</span>
                  <strong>{payments?.connectionReady ? "Configured" : "Setup required"}</strong>
                  <small>
                    Customers pay on QuickBooks. Refunds for hosted invoices are managed there.
                  </small>
                </div>
              </div>
              <div className="admin-quickbooks-company">
                <div className="admin-quickbooks-company-heading">
                  <div>
                    <h3>
                      {companyVerification
                        ? "Accounting access verified"
                        : "Company verification"}
                    </h3>
                    <p>
                      This checks accounting access only. Merchant eligibility, customer
                      payments, and refunds remain unverified. The check may renew a
                      temporary access token if this server no longer has it in memory.
                    </p>
                  </div>
                  {isOwner && (
                    <button
                      className="button secondary small"
                      disabled={
                        busy ||
                        loading ||
                        !quickBooks?.connected ||
                        quickBooks.pending ||
                        quickBooks.remoteReviewRequired ||
                        !Number.isInteger(quickBooks?.revision)
                      }
                      onClick={() => void verifyQuickBooksCompany()}
                    >
                      {verifyingCompany ? (
                        <Loader2 className="spin" size={16} />
                      ) : (
                        <CheckCircle2 size={16} />
                      )}
                      {verifyingCompany
                        ? "Checking company…"
                        : companyVerification
                          ? "Verify company again"
                          : "Verify company"}
                    </button>
                  )}
                </div>
                {companyVerification ? (
                  <dl>
                    <div>
                      <dt>Company</dt>
                      <dd>{companyVerification.companyName}</dd>
                    </div>
                    {companyVerification.legalName && (
                      <div>
                        <dt>Legal name</dt>
                        <dd>{companyVerification.legalName}</dd>
                      </div>
                    )}
                    {companyVerification.country && (
                      <div>
                        <dt>Country</dt>
                        <dd>{companyVerification.country}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Verified</dt>
                      <dd>{date(companyVerification.verifiedAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="admin-fineprint">
                    {quickBooks?.connected
                      ? "The owner can verify which company this authorization can access."
                      : "Authorize QuickBooks before verifying the company."}
                  </p>
                )}
              </div>
              <div className="admin-quickbooks-actions">
                {isOwner ? (
                  <>
                    {canRefreshQuickBooks && (
                      <button className="button secondary"
                        disabled={busy || loading || authorizationTracking}
                        onClick={() => void refreshQuickBooksAuthorization()}>
                        {refreshingAuthorization && <Loader2 size={16} className="spin" />}
                        {refreshingAuthorization ? "Renewing authorization…" : "Refresh authorization"}
                      </button>
                    )}
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
                      {busy && !dialog && !verifyingCompany && !refreshingAuthorization ? (
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
                        ? canRefreshQuickBooks
                          ? "Refresh renews the existing authorization without making a payment. Disconnect only to replace this connection. Existing order records stay here."
                          : "Review the connection status before reconnecting. Existing order records stay here."
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
              {isOwner && <QuickBooksPaymentTest
                disabled={busy || loading || authorizationTracking}
                connectionRevision={quickBooks?.revision}
                actionLock={actionLock}
                onBusyChange={setBusy}
              />}
            </section>
            <HostedCheckoutSettings isOwner={isOwner} disabled={busy || loading} onSaved={() => void refresh()} />
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
                <strong>{payments?.connectionReady ? "QuickBooks-hosted checkout is configured" : "Hosted checkout setup is incomplete"}</strong>
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
                            {order.sandbox && <Badge tone="pending">Test payment</Badge>}
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
                                ["paid", "captured"].includes(order.status)
                                  ? "good"
                                  : /failed|cancel/.test(order.status)
                                    ? "danger"
                                    : "neutral"
                              }
                            >
                              {order.checkoutMethod === "quickbooks-hosted-invoice" && order.status === "captured" ? "Payment recorded by QuickBooks" : humanize(order.status)}
                            </Badge>
                          </td>
                          <td>
                            <strong>{money(order.amountCents, order.currency)}</strong>
                            <small>
                              {order.checkoutMethod === "quickbooks-hosted-invoice" ? "Refunds: check QuickBooks" : `${money(order.refundedCents || 0, order.currency)} refunded`}
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
                                  "captured",
                                  "partially_refunded",
                                  "partially-refunded",
                                ].includes(order.status) ||
                                order.amountCents <= (order.refundedCents || 0) || order.checkoutMethod === "quickbooks-hosted-invoice"
                              }
                              onClick={() => openRefund(order)}
                            >
                              {order.sandbox ? "Review test refund" : "Review refund"}
                            </button>
                            {order.checkoutMethod === "quickbooks-hosted-invoice" && <a className="text-button" href="https://qbo.intuit.com/app/invoices" target="_blank" rel="noopener noreferrer">Manage invoice in QuickBooks</a>}
                            {order.managedPayment && <>
                              {(order.requiresReview || order.checkoutMethod === "quickbooks-hosted-invoice") && <button className="text-button" disabled={busy} onClick={() => void paymentRecordAction(order, "reconcilePayment")}>Check saved status</button>}
                              <button className="text-button" disabled={busy} onClick={() => void paymentRecordAction(order, "paymentDiagnostics")}>Download support details</button>
                              <button className="text-button" disabled={busy} onClick={() => void paymentRecordAction(order, "accountingExport")}>Export accounting review</button>
                            </>}
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
                <h2>Provider cost plus your markup</h2>
                <p>
                  Use an actual provider quote when available. Otherwise, use the planning rates below plus your saved markup to set the customer's fixed film price.
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
                    placeholder="50.00"
                    required
                  />
                  <small>
                    0% passes through the provider cost. You can set 0% to 1,000%.
                  </small>
                </label>
                {pricing && pricing.markupBasisPoints !== 5000 && <button type="button" className="button secondary small"
                  disabled={busy || loading} onClick={() => setMarkup("50.00")}>Use 50% markup</button>}
                <p>
                  Applies to new film prices only. Recorded orders and their original prices
                  remain unchanged.
                </p>
                {pricing && (
                  <p className="admin-fineprint">
                    {pricing.revision === 0 ? "Default markup" : "Current saved markup"}: {(pricing.markupBasisPoints / 100).toFixed(2)}%
                    {pricing.updatedAt ? ` · Updated ${date(pricing.updatedAt)}` : ""}
                    {pricing.updatedBy ? ` by ${pricing.updatedBy}` : ""}
                  </p>
                )}
                <fieldset className="admin-planning-assumptions" disabled={busy || loading || !pricing}>
                  <legend>Film price calculation</legend>
                  <p>Use planning rates when exact production costs are unavailable. The calculated total becomes the fixed retail price after adding your saved markup.</p>
                  <label>Credits per clip
                    <input type="number" min="1" max="1000000" step="1" inputMode="numeric" value={planningCredits}
                      onChange={event => setPlanningCredits(event.target.value)} required />
                    <small>Default 286: 80,000 credits divided by up to 280 videos, rounded up. Actual usage depends on the selected generation settings.</small>
                  </label>
                  <label>Seconds per clip
                    <input type="number" min="1" max="60" step="1" inputMode="numeric" value={planningSeconds}
                      onChange={event => setPlanningSeconds(event.target.value)} required />
                    <small>Default 6 seconds is a planning assumption, not a verified provider clip duration.</small>
                  </label>
                  <label>Renders per clip
                    <input type="number" min="1" max="20" step="1" inputMode="numeric" value={planningRenders}
                      onChange={event => setPlanningRenders(event.target.value)} required />
                    <small>Default 1 render. Increase this to budget for repeated attempts.</small>
                  </label>
                  <p>Published reference checked September 22, 2026: MagicLight Pro API pack, $88 for 80,000 credits and up to 280 Hailuo-series videos. <a href="https://magiclight.ai/openclaw/pricing/" target="_blank" rel="noopener noreferrer">View provider pricing</a>.</p>
                  <p>Final quality, narration, dialogue, music, assembly and retries may change BROCO's actual cost. The customer pays the saved, approved total; BROCO absorbs any cost difference. These assumptions do not verify provider capabilities or enable the payment connection.</p>
                </fieldset>
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
                    !validPlanning ||
                    !pricingChanged
                  }
                >
                  {busy ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  Save pricing settings
                </button>
              </form>
              <div className="admin-price-example">
                <Badge>Price calculation example</Badge>
                <h3>A $10.00 production cost basis</h3>
                <div>
                  <span>Provider quote or planning cost</span>
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
                  An actual provider quote is preferred. When planning rates supply the cost basis,
                  the customer still approves one fixed total. Later changes to these settings do not reprice an existing order.
                </p>
              </div>
            </div>
          </section>
        )}
        {tab === "pricing" && <HostedCheckoutSettings isOwner={isOwner} disabled={busy || loading} onSaved={() => void refresh()} />}
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
                    ? dialog.order.sandbox ? "Review test refund" : "Review customer refund"
                    : dialog.kind === "disconnectQuickBooks"
                      ? "Disconnect QuickBooks"
                    : dialog.kind === "registrationPolicy"
                      ? dialog.approvalRequired ? "Require registration approval" : "Open registration without approval"
                      : dialog.action === "approve"
                        ? "Approve studio access"
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
            {dialog.kind === "registrationPolicy" && (
              <>
                <p>{dialog.approvalRequired
                  ? "Newly registered accounts will wait for an administrator to approve them before entering the studio, making payments, or producing films."
                  : "Anyone who registers a new account will be able to enter the studio immediately and use payment and film production when those services are available. New accounts will not receive administrator permissions."}</p>
                <p>Existing approved accounts keep their access. Accounts already awaiting approval still need individual approval, and suspended accounts remain suspended.</p>
                <div className="admin-modal-actions">
                  <button className="button secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</button>
                  <button className="button primary" disabled={busy} onClick={() => void confirmRegistrationPolicy(dialog)}>
                    {busy && <Loader2 size={16} className="spin" />}
                    {dialog.approvalRequired ? "Require approval" : "Allow new accounts without approval"}
                  </button>
                </div>
              </>
            )}
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
                  {dialog.action === "approve"
                    ? "Approve this account to enter the studio and use the same payment and film production workflows as a customer. Each purchase still requires confirmation, and each service must be available. This does not grant administrator permissions."
                    : dialog.action === "revokeAdmin"
                    ? "This removes access to administration. The person's customer account and family films remain associated with their account."
                    : dialog.action === "suspend"
                      ? "This prevents the account from accessing the application until an administrator restores access. It does not delete the account or its films."
                      : "This removes the suspension. If this account has not yet been approved, it will return to awaiting approval before studio, payment, or film production access is allowed."}
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
                    className={`button ${dialog.action === "activate" || dialog.action === "approve" ? "primary" : "admin-danger"}`}
                    disabled={busy || dialog.person.role === "owner"}
                    onClick={() => void confirmPersonAction(dialog)}
                  >
                    {busy && <Loader2 className="spin" size={15} />}{" "}
                    {dialog.action === "approve"
                      ? "Approve this account"
                      : dialog.action === "activate"
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
                  {dialog.order.sandbox && <Badge tone="pending">Test payment · no live money</Badge>}
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
                    maxLength={500}
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
                  {dialog.order.sandbox ? "I confirm this sandbox test refund. No live money will be moved." : "I confirm this refund to the customer's original payment method. Once submitted successfully, it cannot be undone."}
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
                    {money(amountCents, dialog.order.currency)} {dialog.order.sandbox ? "test refund" : "refund"}
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
