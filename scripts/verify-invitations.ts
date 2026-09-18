/**
 * Smoke-tests the invitation rules against a real MongoDB.
 *
 * The logic these rules live in could not be exercised where it was written —
 * no database was reachable — so this exists to run it somewhere one is.
 * It touches only addresses under a disposable prefix and deletes them after,
 * and it never sends email: every finding below was a database-side decision.
 *
 *   MONGODB_URI=... npx tsx scripts/verify-invitations.ts
 */
import { MongoClient } from "mongodb";

import { parseInviteeEmails } from "../src/lib/validation";

const PREFIX = "invite-verify-";
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("Set MONGODB_URI first.");
  process.exit(1);
}

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

async function main() {
  const client = new MongoClient(uri!);
  await client.connect();

  const db = client.db(new URL(uri!.replace("mongodb+srv://", "https://")).pathname.slice(1) || "ouncebook");
  const invitations = db.collection("waitlist_invitations");
  const inviter = `${PREFIX}a@example.com`;

  const cleanup = async () => {
    await invitations.deleteMany({
      $or: [
        { inviterEmail: { $regex: `^${PREFIX}` } },
        { inviteeEmail: { $regex: `^${PREFIX}` } },
      ],
    });
  };

  await cleanup();

  // The parser is pure, so assert it here rather than in a second harness.
  check(
    "parser: dedupes, lowercases, drops self and invalid",
    parseInviteeEmails("B@x.com, b@X.COM, nope, a@example.com", "a@example.com").emails,
    ["b@x.com"],
  );
  check(
    "parser: caps at five and reports truncation",
    parseInviteeEmails("1@a.com,2@a.com,3@a.com,4@a.com,5@a.com,6@a.com").truncated,
    true,
  );

  // Recording is idempotent per pair: the second write must report nothing new,
  // or the interface tells someone we notified people we did not.
  const list = `${PREFIX}b@example.com, ${PREFIX}c@example.com`;
  const { recordInvitations } = await import("../src/lib/invites");

  check("first submission records both", await recordInvitations(inviter, list), 2);
  check("resubmitting the same list records nothing new", await recordInvitations(inviter, list), 0);

  check(
    "pairs are stored pending",
    await invitations.countDocuments({ inviterEmail: inviter, status: "pending" }),
    2,
  );

  // Five per submission is no limit if submissions are unlimited.
  for (let i = 0; i < 6; i += 1) {
    const batch = Array.from({ length: 5 }, (_, n) => `${PREFIX}f${i}-${n}@example.com`).join(",");
    await recordInvitations(inviter, batch);
  }

  const total = await invitations.countDocuments({ inviterEmail: inviter });
  check("lifetime cap holds at 20", total, 20);

  await cleanup();
  await client.close();

  console.log(failures ? `\n${failures} failing` : "\nall good");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
