import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  getInvitationCollection,
  getSuppressionCollection,
  getWaitlistCollection,
} from "@/lib/mongodb";
import { sendInvitationEmail, sendNamedYouEmail } from "@/lib/smtp";
import { parseInviteeEmails } from "@/lib/validation";

/** Lifetime ceiling on how many people one account can have us contact. */
const MAX_INVITATIONS_PER_INVITER = 20;

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://ouncebook.com"
).replace(/\/$/, "");

function unsubscribeSecret() {
  return (
    process.env.UNSUBSCRIBE_SECRET ??
    process.env.VERIFICATION_TOKEN_SALT ??
    process.env.IP_HASH_SALT ??
    "ouncebook-unsubscribe-salt"
  );
}

export function signUnsubscribeToken(email: string) {
  return createHmac("sha256", unsubscribeSecret())
    .update(email.toLowerCase())
    .digest("hex");
}

export function verifyUnsubscribeToken(email: string, token: string) {
  const expected = signUnsubscribeToken(email);

  // Compare digests so length differences cannot throw and lengths always match.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(token).digest();

  return timingSafeEqual(a, b);
}

export function buildUnsubscribeUrl(email: string) {
  const params = new URLSearchParams({
    email,
    token: signUnsubscribeToken(email),
  });

  return `${SITE_URL}/api/invites/unsubscribe?${params.toString()}`;
}

/**
 * Stores the people someone said they would bring.
 *
 * Deliberately independent of the waitlist row's state: someone already on the
 * list — verified or waiting — must still be able to name people, and they are
 * the likeliest to do it. Returns how many pairs are now on record for them.
 *
 * Never throws. A failure here must not cost someone their own signup.
 */
export async function recordInvitations(inviterEmail: string, rawList?: string) {
  if (!rawList) {
    return 0;
  }

  const inviter = inviterEmail.toLowerCase();
  const { emails } = parseInviteeEmails(rawList, inviter);

  if (!emails.length) {
    return 0;
  }

  try {
    const invitations = await getInvitationCollection();

    // Five per submission is not a limit if submissions are unlimited. Cap the
    // lifetime total so one account cannot mail the world a handful at a time.
    const already = await invitations.countDocuments({ inviterEmail: inviter });
    const room = MAX_INVITATIONS_PER_INVITER - already;

    if (room <= 0) {
      return 0;
    }

    const now = new Date();
    const batch = emails.slice(0, room);

    const result = await invitations.bulkWrite(
      batch.map((inviteeEmail) => ({
        updateOne: {
          filter: { inviterEmail: inviter, inviteeEmail },
          update: {
            $setOnInsert: {
              inviterEmail: inviter,
              inviteeEmail,
              createdAt: now,
              status: "pending" as const,
              notifiedAt: null,
              mutual: false,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    // Newly recorded, not merely submitted. Re-sending the same list writes
    // nothing, and telling someone we notified five people when we notified
    // none would be a lie the interface has no way to walk back.
    return result.upsertedCount ?? 0;
  } catch (error) {
    console.error("Recording invitations failed", { inviter }, error);

    // A concurrent duplicate can fail the batch after some upserts landed;
    // report what actually got written rather than claiming nothing did.
    const partial = (error as { result?: { upsertedCount?: number } })?.result
      ?.upsertedCount;

    return typeof partial === "number" ? partial : 0;
  }
}

/**
 * Acts on the invitations a member recorded at signup.
 *
 * Called only after that member verifies their own address. That ordering is
 * the whole safety model: without it, anyone could make this server email
 * arbitrary addresses, which is both an abuse vector and the fastest way to get
 * the sending domain blocklisted — taking the verification emails down with it.
 *
 * Failures are logged and swallowed. A member's own signup must never fail
 * because notifying someone else did.
 */
export async function dispatchInvitationsFor(inviterEmail: string) {
  const inviter = inviterEmail.toLowerCase();

  try {
    const [invitations, waitlist, suppressions] = await Promise.all([
      getInvitationCollection(),
      getWaitlistCollection(),
      getSuppressionCollection(),
    ]);

    const pending = await invitations
      .find({ inviterEmail: inviter, status: "pending" })
      .toArray();

    for (const invitation of pending) {
      const invitee = invitation.inviteeEmail;

      try {
        if (await suppressions.findOne({ email: invitee })) {
          await invitations.updateOne(
            { _id: invitation._id },
            { $set: { status: "skipped", notifiedAt: new Date() } },
          );
          continue;
        }

        const [inviteeEntry, reciprocal] = await Promise.all([
          waitlist.findOne({ email: invitee }),
          invitations.findOne({
            inviterEmail: invitee,
            inviteeEmail: inviter,
          }),
        ]);

        // A reciprocal row only counts once its author proved they own that
        // address. Anyone can sign up as someone else and name a target; if an
        // unverified row could make a match, that alone would tell the target
        // an account exists under the other address.
        const mutual = Boolean(
          reciprocal &&
            (inviteeEntry?.status === "verified" || inviteeEntry?.verifiedAt),
        );

        if (inviteeEntry) {
          await sendNamedYouEmail({
            to: invitee,
            inviterEmail: inviter,
            mutual,
          });

          if (mutual && !(await suppressions.findOne({ email: inviter }))) {
            // Both sides consented by naming each other, so both get told —
            // unless this one asked us never to contact them.
            await sendNamedYouEmail({
              to: inviter,
              inviterEmail: invitee,
              mutual: true,
            });
          }
        } else {
          await sendInvitationEmail({
            to: invitee,
            inviterEmail: inviter,
            unsubscribeUrl: buildUnsubscribeUrl(invitee),
          });
        }

        await invitations.updateOne(
          { _id: invitation._id },
          { $set: { status: "sent", notifiedAt: new Date(), mutual } },
        );
      } catch (error) {
        console.error("Invitation dispatch failed", { invitee }, error);
      }
    }
  } catch (error) {
    console.error("Invitation dispatch batch failed", error);
  }
}
