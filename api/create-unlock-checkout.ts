import Stripe from "stripe";

type RequestBody = {
  jobId?: string;
  contractorUserId?: string;
};

type SoftrSingleRecordResponse = {
  data?: {
    id?: string;
    fields?: Record<string, unknown>;
  };
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const appBaseUrl = process.env.APP_BASE_URL || "https://kary9409.softr.app";

const softrApiKey = process.env.SOFTR_API_KEY;
const softrDatabaseId = process.env.SOFTR_DATABASE_ID;
const softrJobsTableId = process.env.SOFTR_JOBS_TABLE_ID;

const stripeUnlockTaxRateId = "txr_1TJDf33beV513bkPjM0mMxg0";

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-08-27.basil",
});

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, status: number, body: Record<string, unknown>) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return null;
}

async function getJobFields(jobId: string): Promise<Record<string, unknown>> {
  if (!softrApiKey || !softrDatabaseId || !softrJobsTableId) {
    throw new Error(
      "Missing Softr environment variables: SOFTR_API_KEY, SOFTR_DATABASE_ID, or SOFTR_JOBS_TABLE_ID"
    );
  }

  const url =
    `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
    `/tables/${softrJobsTableId}/records/${encodeURIComponent(jobId)}?fieldNames=true`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Softr-Api-Key": softrApiKey,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 404) {
    throw new Error("Job not found");
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to load job from Softr: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as SoftrSingleRecordResponse;
  return payload.data?.fields || {};
}

function isJobClosed(fields: Record<string, unknown>): boolean {
  const isClosed = toBoolean(fields["Is Closed"]);
  if (isClosed === true) {
    return true;
  }

  const remainingUnlocks = toNumber(fields["Remaining Unlocks"]);
  if (remainingUnlocks !== null) {
    return remainingUnlocks <= 0;
  }

  const maxUnlocks = toNumber(fields["Max Unlocks"]) ?? 4;
  const successfulUnlocks = toNumber(fields["Successful Unlocks"]);

  if (successfulUnlocks !== null) {
    return successfulUnlocks >= maxUnlocks;
  }

  return false;
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

    console.log("create-unlock-checkout input", {
      jobId,
      contractorUserId,
    });

    const jobFields = await getJobFields(jobId);

    console.log("job availability check", {
      jobId,
      isClosed: jobFields["Is Closed"],
      remainingUnlocks: jobFields["Remaining Unlocks"],
      successfulUnlocks: jobFields["Successful Unlocks"],
      maxUnlocks: jobFields["Max Unlocks"],
    });

    if (isJobClosed(jobFields)) {
      return sendJson(res, 409, {
        error: "This job is no longer available for unlock.",
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
              name: "GTARenovino Project Unlock",
              description: "Unlock homeowner phone number",
            },
            unit_amount: 3000,
          },
          quantity: 1,
          tax_rates: [stripeUnlockTaxRateId],
        },
      ],
      metadata: {
        jobId,
        contractorUserId,
        baseUnlockAmount: "3000",
        taxMode: "exclusive",
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

    const message =
      error?.message === "Job not found"
        ? "Job not found"
        : error?.message || "Unknown error";

    const status = message === "Job not found" ? 404 : 500;

    return sendJson(res, status, {
      error:
        status === 404
          ? "The selected job could not be found."
          : "Failed to create Stripe Checkout Session",
      details: message,
    });
  }
}
