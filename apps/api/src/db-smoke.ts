import { createDatabaseRepository } from "./database-repository";

const repository = createDatabaseRepository();

try {
  const inbox = await repository.getReviewerInbox(new Date().toISOString());

  console.log(
    JSON.stringify(
      {
        items: inbox.items.length,
        needsReview: inbox.sections.needs_review.length,
        updated: inbox.sections.updated_since_review.length,
        waitingOnAuthor: inbox.sections.waiting_on_author.length
      },
      null,
      2
    )
  );
} finally {
  await repository.close?.();
}
