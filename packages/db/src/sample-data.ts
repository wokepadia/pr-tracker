import type { MikroORM } from "@mikro-orm/postgresql";
import {
  sampleActors,
  sampleLastSeenAtByPullRequestId,
  samplePullRequests
} from "@pr-tracker/core";
import { deterministicUuid } from "./ids";

const sampleInstallationId = "00000000-0000-4000-8000-000000000001";

export async function seedSampleData(orm: MikroORM): Promise<void> {
  const connection = orm.em.getConnection();
  const now = new Date().toISOString();

  await connection.execute(
    `
      insert into github_installations (
        id,
        github_installation_id,
        account_login,
        created_at,
        updated_at
      )
      values (?, ?, ?, ?, ?)
      on conflict (github_installation_id)
      do update set account_login = excluded.account_login, updated_at = excluded.updated_at
    `,
    [sampleInstallationId, 1, "acme", now, now]
  );

  for (const pullRequest of samplePullRequests) {
    await connection.execute(
      `
        insert into pull_requests (
          id,
          installation_id,
          github_node_id,
          repository,
          number,
          title,
          url,
          author_login,
          state,
          is_draft,
          latest_commit_sha,
          raw_payload,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
        on conflict (github_node_id)
        do update set
          title = excluded.title,
          state = excluded.state,
          is_draft = excluded.is_draft,
          latest_commit_sha = excluded.latest_commit_sha,
          raw_payload = excluded.raw_payload,
          updated_at = excluded.updated_at
      `,
      [
        deterministicUuid(`pull-request:${pullRequest.id}`),
        sampleInstallationId,
        pullRequest.id,
        pullRequest.repository,
        pullRequest.number,
        pullRequest.title,
        pullRequest.url,
        pullRequest.authorId,
        pullRequest.state,
        pullRequest.isDraft,
        pullRequest.latestCommitSha,
        JSON.stringify(pullRequest),
        pullRequest.createdAt,
        pullRequest.updatedAt
      ]
    );

    for (const reviewerId of pullRequest.requestedReviewerIds) {
      await connection.execute(
        `
          insert into pull_request_reviewers (
            id,
            pull_request_id,
            reviewer_login,
            created_at
          )
          values (?, ?, ?, ?)
          on conflict (pull_request_id, reviewer_login) do nothing
        `,
        [
          deterministicUuid(`reviewer:${pullRequest.id}:${reviewerId}`),
          deterministicUuid(`pull-request:${pullRequest.id}`),
          reviewerId,
          now
        ]
      );
    }

    for (const review of pullRequest.reviews) {
      await connection.execute(
        `
          insert into review_events (
            id,
            pull_request_id,
            github_node_id,
            reviewer_login,
            decision,
            commit_sha,
            body,
            submitted_at,
            raw_payload
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          on conflict (github_node_id)
          do update set
            decision = excluded.decision,
            commit_sha = excluded.commit_sha,
            body = excluded.body,
            submitted_at = excluded.submitted_at,
            raw_payload = excluded.raw_payload
        `,
        [
          deterministicUuid(`review:${review.id}`),
          deterministicUuid(`pull-request:${pullRequest.id}`),
          review.id,
          review.reviewerId,
          review.decision,
          review.commitSha ?? null,
          review.body ?? null,
          review.submittedAt,
          JSON.stringify(review)
        ]
      );
    }

    for (const thread of pullRequest.threads) {
      await connection.execute(
        `
          insert into review_threads (
            id,
            pull_request_id,
            github_node_id,
            is_resolved,
            participant_logins,
            file_path,
            line,
            last_activity_at,
            raw_payload
          )
          values (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb)
          on conflict (github_node_id)
          do update set
            is_resolved = excluded.is_resolved,
            participant_logins = excluded.participant_logins,
            file_path = excluded.file_path,
            line = excluded.line,
            last_activity_at = excluded.last_activity_at,
            raw_payload = excluded.raw_payload
        `,
        [
          deterministicUuid(`thread:${thread.id}`),
          deterministicUuid(`pull-request:${pullRequest.id}`),
          thread.id,
          thread.isResolved,
          JSON.stringify(thread.participantIds),
          thread.filePath ?? null,
          thread.line ?? null,
          thread.lastActivityAt,
          JSON.stringify(thread)
        ]
      );
    }

    for (const event of pullRequest.activity) {
      await connection.execute(
        `
          insert into activity_events (
            id,
            pull_request_id,
            github_delivery_id,
            event_type,
            actor_login,
            occurred_at,
            title,
            body,
            raw_payload
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          on conflict (id)
          do update set
            event_type = excluded.event_type,
            actor_login = excluded.actor_login,
            occurred_at = excluded.occurred_at,
            title = excluded.title,
            body = excluded.body,
            raw_payload = excluded.raw_payload
        `,
        [
          deterministicUuid(`activity:${event.id}`),
          deterministicUuid(`pull-request:${pullRequest.id}`),
          null,
          event.type,
          event.actorId,
          event.occurredAt,
          event.title,
          event.body ?? null,
          JSON.stringify(event)
        ]
      );
    }
  }

  for (const [pullRequestId, lastSeenAt] of Object.entries(
    sampleLastSeenAtByPullRequestId
  )) {
    await connection.execute(
      `
        insert into local_pull_request_states (
          id,
          pull_request_id,
          viewer_login,
          last_seen_at,
          is_muted,
          is_pinned,
          created_at,
          updated_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (pull_request_id, viewer_login)
        do update set last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
      `,
      [
        deterministicUuid(`local-state:${pullRequestId}:viewer`),
        deterministicUuid(`pull-request:${pullRequestId}`),
        "viewer",
        lastSeenAt ?? null,
        false,
        false,
        now,
        now
      ]
    );
  }

  void sampleActors;
}
