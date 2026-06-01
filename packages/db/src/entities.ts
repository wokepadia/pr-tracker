import { EntitySchema } from "@mikro-orm/core";

export interface GithubInstallationRecord {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PullRequestRecord {
  id: string;
  installationId: string;
  githubNodeId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  state: string;
  isDraft: boolean;
  latestCommitSha: string;
  rawPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewEventRecord {
  id: string;
  pullRequestId: string;
  githubNodeId: string;
  reviewerLogin: string;
  decision: string;
  commitSha?: string;
  body?: string;
  submittedAt: Date;
  rawPayload: unknown;
}

export interface PullRequestReviewerRecord {
  id: string;
  pullRequestId: string;
  reviewerLogin: string;
  createdAt: Date;
}

export interface ReviewThreadRecord {
  id: string;
  pullRequestId: string;
  githubNodeId: string;
  isResolved: boolean;
  participantLogins: string[];
  filePath?: string;
  line?: number;
  lastActivityAt: Date;
  rawPayload: unknown;
}

export interface ActivityEventRecord {
  id: string;
  pullRequestId: string;
  githubDeliveryId?: string;
  eventType: string;
  actorLogin: string;
  occurredAt: Date;
  title: string;
  body?: string;
  rawPayload: unknown;
}

export interface WebhookDeliveryRecord {
  id: string;
  deliveryId: string;
  eventName: string;
  action?: string;
  installationId?: number;
  receivedAt: Date;
  rawPayload: unknown;
}

export interface LocalPullRequestStateRecord {
  id: string;
  pullRequestId: string;
  viewerLogin: string;
  lastSeenAt?: Date;
  isMuted: boolean;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const GithubInstallationEntity = new EntitySchema<GithubInstallationRecord>({
  name: "GithubInstallation",
  tableName: "github_installations",
  properties: {
    id: { type: "uuid", primary: true },
    githubInstallationId: { type: "number", unique: true },
    accountLogin: { type: "text" },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date", onUpdate: () => new Date() }
  }
});

export const PullRequestEntity = new EntitySchema<PullRequestRecord>({
  name: "PullRequest",
  tableName: "pull_requests",
  properties: {
    id: { type: "uuid", primary: true },
    installationId: { type: "uuid" },
    githubNodeId: { type: "text", unique: true },
    repository: { type: "text" },
    number: { type: "number" },
    title: { type: "text" },
    url: { type: "text" },
    authorLogin: { type: "text" },
    state: { type: "text" },
    isDraft: { type: "boolean" },
    latestCommitSha: { type: "text" },
    rawPayload: { type: "json" },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date", onUpdate: () => new Date() }
  },
  indexes: [
    { properties: ["repository", "number"] },
    { properties: ["installationId"] },
    { properties: ["updatedAt"] }
  ]
});

export const ReviewEventEntity = new EntitySchema<ReviewEventRecord>({
  name: "ReviewEvent",
  tableName: "review_events",
  properties: {
    id: { type: "uuid", primary: true },
    pullRequestId: { type: "uuid" },
    githubNodeId: { type: "text", unique: true },
    reviewerLogin: { type: "text" },
    decision: { type: "text" },
    commitSha: { type: "text", nullable: true },
    body: { type: "text", nullable: true },
    submittedAt: { type: "Date" },
    rawPayload: { type: "json" }
  },
  indexes: [{ properties: ["pullRequestId"] }, { properties: ["reviewerLogin"] }]
});

export const PullRequestReviewerEntity =
  new EntitySchema<PullRequestReviewerRecord>({
    name: "PullRequestReviewer",
    tableName: "pull_request_reviewers",
    properties: {
      id: { type: "uuid", primary: true },
      pullRequestId: { type: "uuid" },
      reviewerLogin: { type: "text" },
      createdAt: { type: "Date" }
    },
    uniques: [{ properties: ["pullRequestId", "reviewerLogin"] }]
  });

export const ReviewThreadEntity = new EntitySchema<ReviewThreadRecord>({
  name: "ReviewThread",
  tableName: "review_threads",
  properties: {
    id: { type: "uuid", primary: true },
    pullRequestId: { type: "uuid" },
    githubNodeId: { type: "text", unique: true },
    isResolved: { type: "boolean" },
    participantLogins: { type: "json" },
    filePath: { type: "text", nullable: true },
    line: { type: "number", nullable: true },
    lastActivityAt: { type: "Date" },
    rawPayload: { type: "json" }
  },
  indexes: [
    { properties: ["pullRequestId"] },
    { properties: ["isResolved"] },
    { properties: ["lastActivityAt"] }
  ]
});

export const ActivityEventEntity = new EntitySchema<ActivityEventRecord>({
  name: "ActivityEvent",
  tableName: "activity_events",
  properties: {
    id: { type: "uuid", primary: true },
    pullRequestId: { type: "uuid" },
    githubDeliveryId: { type: "text", nullable: true },
    eventType: { type: "text" },
    actorLogin: { type: "text" },
    occurredAt: { type: "Date" },
    title: { type: "text" },
    body: { type: "text", nullable: true },
    rawPayload: { type: "json" }
  },
  indexes: [
    { properties: ["pullRequestId"] },
    { properties: ["eventType"] },
    { properties: ["occurredAt"] }
  ],
  uniques: [
    {
      properties: ["githubDeliveryId", "eventType"]
    }
  ]
});

export const WebhookDeliveryEntity = new EntitySchema<WebhookDeliveryRecord>({
  name: "WebhookDelivery",
  tableName: "webhook_deliveries",
  properties: {
    id: { type: "uuid", primary: true },
    deliveryId: { type: "text", unique: true },
    eventName: { type: "text" },
    action: { type: "text", nullable: true },
    installationId: { type: "number", nullable: true },
    receivedAt: { type: "Date" },
    rawPayload: { type: "json" }
  },
  indexes: [
    { properties: ["eventName"] },
    { properties: ["installationId"] },
    { properties: ["receivedAt"] }
  ]
});

export const LocalPullRequestStateEntity =
  new EntitySchema<LocalPullRequestStateRecord>({
    name: "LocalPullRequestState",
    tableName: "local_pull_request_states",
    properties: {
      id: { type: "uuid", primary: true },
      pullRequestId: { type: "uuid" },
      viewerLogin: { type: "text" },
      lastSeenAt: { type: "Date", nullable: true },
      isMuted: { type: "boolean" },
      isPinned: { type: "boolean" },
      createdAt: { type: "Date" },
      updatedAt: { type: "Date", onUpdate: () => new Date() }
    },
    uniques: [{ properties: ["pullRequestId", "viewerLogin"] }]
  });

export const entities = [
  GithubInstallationEntity,
  PullRequestEntity,
  ReviewEventEntity,
  PullRequestReviewerEntity,
  ReviewThreadEntity,
  ActivityEventEntity,
  WebhookDeliveryEntity,
  LocalPullRequestStateEntity
];
