import Stripe from "stripe";

type RequestBody = {
  jobId?: string;
  contractorUserId?: string;
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const appBaseUrl = process.env.APP_BASE_URL || "https://kary9409.softr.app";

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-08-27.basil",
});

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", appBaseUrl);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, status: number, body: Record<string, unknown>) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body: RequestBody =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const jobId = body.jobId?.trim();
    const contractorUserId = body.contractorUserId?.trim();

    if (!jobId || !contractorUserId) {
      return sendJson(res, 400, {
        error: "Missing required fields: jobId and contractorUserId",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${appBaseUrl}/unlock-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/unlock-cancel`,
      line_items: [
        {
          price_data: {
            currency: "cad",
            product_data: {
              name: "QuoteConnect Job Unlock",
              description: "One-time unlock for homeowner phone number",
            },
            unit_amount: 3000,
          },
          quantity: 1,
        },
      ],
      metadata: {
        jobId,
        contractorUserId,
      },
    });

    if (!session.url) {
      return sendJson(res, 500, {
        error: "Stripe session created but no checkout URL was returned",
      });
    }

    return sendJson(res, 200, { url: session.url });
  } catch (error: any) {
    console.error("create-unlock-checkout error:", error);
    return sendJson(res, 500, {
      error: "Failed to create Stripe Checkout Session",
      details: error?.message || "Unknown error",
    });
  }
}
