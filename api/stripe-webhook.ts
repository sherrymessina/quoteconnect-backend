import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const softrUnlockWebhookUrl = process.env.SOFTR_UNLOCK_WEBHOOK_URL;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

if (!stripeWebhookSecret) {
  throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable.");
}

if (!softrUnlockWebhookUrl) {
  throw new Error("Missing SOFTR_UNLOCK_WEBHOOK_URL environment variable.");
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

function sendJson(res: any, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const signature = req.headers["stripe-signature"];

  if (!signature || typeof signature !== "string") {
    return sendJson(res, 400, { error: "Missing Stripe signature" });
  }

  let event: Stripe.Event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      stripeWebhookSecret
    );
  } catch (error: any) {
    console.error("stripe-webhook signature verification failed:", error);
    return sendJson(res, 400, {
      error: "Invalid Stripe webhook signature",
      details: error?.message || "Unknown error",
    });
  }

  try {
    if (event.type !== "checkout.session.completed") {
      return sendJson(res, 200, {
        received: true,
        ignored: true,
        eventType: event.type,
      });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    const jobId = session.metadata?.jobId?.trim();
    const contractorUserId = session.metadata?.contractorUserId?.trim();
    const currency = session.currency?.toLowerCase();
    const amountTotal = session.amount_total ?? 0;

    if (!jobId || !contractorUserId) {
      return sendJson(res, 400, {
        error: "Missing required Stripe metadata: jobId and contractorUserId",
      });
    }

    if (currency !== "cad" || amountTotal !== 3000) {
      return sendJson(res, 400, {
        error: "Unexpected Stripe payment amount or currency",
        currency,
        amountTotal,
      });
    }

    const purchasedAt = session.created
      ? new Date(session.created * 1000).toISOString()
      : new Date().toISOString();

    const workflowPayload = {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeSessionId: session.id,
      paymentStatus: "Succeeded",
      amountPaid: 30,
      currency: "cad",
      purchasedAt,
      jobId,
      contractorUserId,
      customerEmail: session.customer_details?.email || session.customer_email || null,
    };

    const workflowResponse = await fetch(softrUnlockWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(workflowPayload),
    });

    if (!workflowResponse.ok) {
      const workflowText = await workflowResponse.text().catch(() => "");
      console.error("stripe-webhook failed to call Softr workflow:", workflowText);

      return sendJson(res, 500, {
        error: "Failed to forward payment to Softr workflow",
        status: workflowResponse.status,
        details: workflowText || "No response body",
      });
    }

    return sendJson(res, 200, {
      received: true,
      forwarded: true,
      sessionId: session.id,
      jobId,
      contractorUserId,
    });
  } catch (error: any) {
    console.error("stripe-webhook handler error:", error);
    return sendJson(res, 500, {
      error: "Stripe webhook handler failed",
      details: error?.message || "Unknown error",
    });
  }
}
