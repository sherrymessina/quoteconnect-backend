import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const softrUnlockWebhookUrl = process.env.SOFTR_UNLOCK_WEBHOOK_URL;

// New env vars for reading the Jobs table
const softrApiKey = process.env.SOFTR_API_KEY;
const softrDatabaseId = process.env.SOFTR_DATABASE_ID;
const softrJobsTableId = process.env.SOFTR_JOBS_TABLE_ID;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

if (!stripeWebhookSecret) {
  throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable.");
}

if (!softrUnlockWebhookUrl) {
  throw new Error("Missing SOFTR_UNLOCK_WEBHOOK_URL environment variable.");
}

if (!softrApiKey) {
  throw new Error("Missing SOFTR_API_KEY environment variable.");
}

if (!softrDatabaseId) {
  throw new Error("Missing SOFTR_DATABASE_ID environment variable.");
}

if (!softrJobsTableId) {
  throw new Error("Missing SOFTR_JOBS_TABLE_ID environment variable.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-08-27.basil",
});

async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

async function getJobPhoneSnapshot(jobId: string): Promise<string> {
  const url =
    `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
    `/tables/${softrJobsTableId}/records?limit=1000&fieldNames=true`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Softr-Api-Key": softrApiKey!,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to load Jobs table records: ${response.status} ${text}`);
  }

  const json = await response.json();
  const records = Array.isArray(json?.data) ? json.data : [];
  const jobRecord = records.find((record: any) => record?.id === jobId);

  if (!jobRecord) {
    throw new Error(`Job record not found for jobId: ${jobId}`);
  }

  const fields = jobRecord.fields || {};

  return (
    fields["Phone Number"] ||
    fields["Phone"] ||
    fields["phoneNumber"] ||
    fields["phone"] ||
    ""
  );
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getHeaderValue(req.headers["stripe-signature"]);

    if (!signature) {
      return res.status(400).json({ error: "Missing Stripe signature header" });
    }

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      stripeWebhookSecret!
    );

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({
        received: true,
        ignored: true,
        eventType: event.type,
      });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    const paymentStatus = session.payment_status;
    const currency = (session.currency || "").toLowerCase();
    const amountTotal = session.amount_total ?? 0;

    if (paymentStatus !== "paid") {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Session not paid",
      });
    }

    if (currency !== "cad") {
      return res.status(400).json({
        error: `Invalid currency: ${currency}`,
      });
    }

    if (amountTotal !== 3000) {
      return res.status(400).json({
        error: `Invalid amount: ${amountTotal}`,
      });
    }

    const jobId = session.metadata?.jobId || "";
    const contractorUserId = session.metadata?.contractorUserId || "";
    const customerEmail =
      session.customer_details?.email ||
      session.customer_email ||
      "";

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId in session metadata" });
    }

    if (!contractorUserId) {
      return res.status(400).json({
        error: "Missing contractorUserId in session metadata",
      });
    }

    const phoneSnapshot = await getJobPhoneSnapshot(jobId);

    const workflowPayload = {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeSessionId: session.id,
      paymentStatus: "Succeeded",
      amountPaid: 30,
      currency: "cad",
      purchasedAt: new Date().toISOString(),
      jobId,
      contractorUserId,
      customerEmail,
      phoneSnapshot,
    };

    const workflowResponse = await fetch(softrUnlockWebhookUrl!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(workflowPayload),
    });

    if (!workflowResponse.ok) {
      const text = await workflowResponse.text();
      return res.status(500).json({
        error: "Failed to send payload to Softr workflow",
        details: text,
      });
    }

    return res.status(200).json({
      received: true,
      forwarded: true,
      phoneSnapshotIncluded: true,
    });
  } catch (error: any) {
    console.error("stripe-webhook error:", error);
    return res.status(400).json({
      error: error?.message || "Webhook error",
    });
  }
}
