// Normalized data model shared by every connector, the engine and the UI.

export type SourceSystem = 'siebel' | 'jira' | 'outlook';
export type Tier = 'Platinum' | 'Gold' | 'Silver' | 'Bronze';
export type Severity = 1 | 2 | 3 | 4;
export type ItemStatus = 'New' | 'In Progress' | 'Waiting on Customer' | 'Blocked' | 'Resolved';

export interface Person {
  id: string;
  name: string;
  email: string;
  teamId: string;
  role: 'Engineer' | 'Team Lead' | 'Manager';
  skills: string[];
  capacityHoursPerWeek: number;
}

export interface Team {
  id: string;
  name: string;
  leadId: string;
  focus: string;
}

export interface Customer {
  id: string;
  name: string;
  domain: string;
  tier: Tier;
}

export interface WorkItem {
  id: string;               // internal id, e.g. "siebel:1-4XK9QZ"
  source: SourceSystem;
  externalId: string;       // as shown in the source system
  title: string;
  description: string;
  status: ItemStatus;
  severity: Severity;
  customerId: string;
  assigneeId: string;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  slaDueAt: string;
  effortHours: number;      // remaining effort estimate
  skills: string[];
  blockedByIds: string[];
  linkedIds: string[];      // cross-system links (Siebel SR <-> Jira issue)
  goLiveAt?: string;
}

export interface Email {
  id: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  body: string;
  receivedAt: string;
  mailbox: string;
}

/** Ground truth planted by the generator. Never read by the engine, only by eval. */
export interface EmailTruth {
  emailId: string;
  itemId: string | null;
  kind: 'escalation' | 'deadline_change' | 'deescalation' | 'customer_reply' | 'info' | 'noise' | 'injection';
  urgency: Urgency;
  deadline: string | null;
}

export type Urgency = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type Sentiment = 'positive' | 'neutral' | 'frustrated' | 'angry';
export type Impact = 'none' | 'single_user' | 'team' | 'business_critical';

/** What the AI (LLM or rule engine) extracts from one email. Fixed schema: the model never acts. */
export interface EmailSignals {
  ticketRefs: string[];
  isEscalation: boolean;
  isDeescalation: boolean;
  urgency: Urgency;
  deadline: string | null;  // ISO date-time or null
  customerImpact: Impact;
  sentiment: Sentiment;
  executiveInvolved: boolean;
  evidence: string;         // verbatim quote from the email
  summary: string;          // one line
  suspiciousInstructions: boolean;
}

export interface LinkResult {
  itemId: string | null;
  method: 'ticket-id' | 'thread' | 'customer+keywords' | 'none';
  confidence: number;
}

export interface ProcessedEmail {
  email: Email;
  link: LinkResult;
  signals: EmailSignals;
  engine: string;           // which engine produced the signals
  latencyMs: number;
}

export interface ScoreFactor {
  key: FactorKey;
  label: string;
  points: number;
  detail: string;
  emailId?: string;
  at?: string;              // for deadline factors: the deadline itself
}

export type FactorKey =
  | 'severity' | 'sla' | 'tier' | 'escalation' | 'executive' | 'deadline'
  | 'sentiment' | 'stale' | 'blocking' | 'waiting' | 'deescalation' | 'goLive' | 'override';

export type Band = 'P1' | 'P2' | 'P3' | 'P4';

/** A manager's manual priority decision. Always wins over the computed band, and is audited. */
export interface ManualOverride {
  itemId: string;
  band: Band;
  reason: string;
  by: string;
  at: string;
}

export type Weights = Record<Exclude<FactorKey, 'override'>, number>;

export interface ScoredItem {
  item: WorkItem;
  score: number;
  band: Band;
  factors: ScoreFactor[];
  override?: ManualOverride;
  previousScore?: number;
}

export interface PersonLoad {
  person: Person;
  openItems: number;
  queuedHours: number;
  capacityHours: number;    // capacity left this week
  loadRatio: number;        // queued hours vs capacity left this week
  atRiskItemIds: string[];  // items projected to miss SLA because of queue position
  status: 'ok' | 'busy' | 'overloaded';
}

export interface Handoff {
  itemId: string;
  fromId: string;
  toId: string;
  crossTeam?: boolean;      // no teammate had room, so the suggestion borrows someone from another team
  reason: string;
  projectedBreachAt: string;
  projectedFinishAfterHandoff: string;
}

export interface Reminder {
  id: string;
  personId: string;
  itemId: string;
  kind: 'sla' | 'stale' | 'customer-waiting' | 'escalation-unacked' | 'overload';
  message: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface PriorityChange {
  itemId: string;
  emailId: string;
  at: string;
  fromScore: number;
  toScore: number;
  fromBand: string;
  toBand: string;
  reason: string;
  evidence: string;
}

export interface Dataset {
  generatedAt: string;
  now: string;              // the demo clock
  teams: Team[];
  people: Person[];
  customers: Customer[];
  items: WorkItem[];
  emails: Email[];          // already received
  incoming: Email[];        // released one by one during the live demo
}
