import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false,
  },
};

type SoftrRecordResponse = {
  data?: {
    id?: string;
    tableId?: string;
    fields?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  };
};

type SoftrListResponse = {
  data?: Array<{
    id?: string;
    tableId?: string;
    fields?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }>;
  metadata?: {
    offset?: number;
    limit?: number;
    total?: number;
  };
};

type SoftrTableResponse = {
  data?: {
    id?: string;
    name?: string;
    fields?: Array<{
      id: string;
      name: string;
      type?: string;
      allowMultipleEntries?: boolean;
      readonly?: boolean;
      required?: boolean;
      locked?: boolean;
    }>;
  };
};

type SoftrFieldDef = {
  id: string;
  name: string;
  type?: string;
  allowMultipleEntries?: boolean;
  readonly?: boolean;
  required?: boolean;
  locked?: boolean;
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const softrApiKey = process.env.SOFTR_API_KEY;
const softrDatabaseId = process.env.SOFTR_DATABASE_ID;
const softrJobsTableId = process.env.SOFTR_JOBS_TABLE_ID;
const softrUnlocksTableId = process.env.SOFTR_UNLOCKS_TABLE_ID;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

if (!stripeWebhookSecret) {
  throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable.");
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

if (!softrUnlocksTableId) {
  throw new Error("Missing SOFTR_UNLOCKS_TABLE_ID environment variable.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-08-27.basil",
});

let unlockFieldCache: Record<string, SoftrFieldDef> | null = null;

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

function softrHeaders() {
  return {
    "Softr-Api-Key": softrApiKey!,
    "Content-Type": "application/json",
  };
}

async function getSingleRecordById(
  tableId: string,
  recordId: string
): Promise<Record<string, unknown>> {
  const url =
    `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
    `/tables/${tableId}/records/${encodeURIComponent(recordId)}?fieldNames=true`;

  const response = await fetch(url, {
    method: "GET",
    headers: softrHeaders(),
  });

  if (response.status === 404) {
    throw new Error(`Record not found: ${recordId}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to load record ${recordId}: ${response.status} ${text}`);
  }

  const json = (await response.json()) as SoftrRecordResponse;
  return json.data?.fields || {};
}

async function getTableFields(tableId: string): Promise<Record<string, SoftrFieldDef>> {
  if (tableId === softrUnlocksTableId && unlockFieldCache) {
    return unlockFieldCache;
  }

  const url =
    `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
    `/tables/${tableId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Softr-Api-Key": softrApiKey!,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to load table metadata: ${response.status} ${text}`);
  }

  const json = (await response.json()) as SoftrTableResponse;
  const fields = Array.isArray(json.data?.fields) ? json.data!.fields! : [];

  const byName: Record<string, SoftrFieldDef> = {};
  for (const field of fields) {
    byName[field.name] = field;
  }

  if (tableId === softrUnlocksTableId) {
    unlockFieldCache = byName;
  }

  return byName;
}

function requireField(
  fieldsByName: Record<string, SoftrFieldDef>,
  fieldName: string
): SoftrFieldDef {
  const field = fieldsByName[fieldName];
  if (!field) {
    throw new Error(`Unlocks field not found: ${fieldName}`);
  }
  return field;
}

function linkedValue(field: SoftrFieldDef, recordId: string) {
  return field.allowMultipleEntries ? [recordId] : recordId;
}

async function getJobPhoneSnapshot(jobId: string): Promise<string> {
  const fields = await getSingleRecordById(softrJobsTableId!, jobId);

  return String(
    fields["Phone Number"] ||
      fields["Phone"] ||
      fields["phoneNumber"] ||
      fields["phone"] ||
      ""
  );
}

async function findExistingUnlockByStripeSessionId(
  stripeSessionId: string
): Promise<string | null> {
  let offset = 0;
  const limit = 200;

  while (true) {
    const url =
      `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
      `/tables/${softrUnlocksTableId}/records?limit=${limit}&offset=${offset}&fieldNames=true`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Softr-Api-Key": softrApiKey!,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Failed to search existing unlocks: ${response.status} ${text}`);
    }

    const json = (await response.json()) as SoftrListResponse;
    const records = Array.isArray(json.data) ? json.data : [];

    for (const record of records) {
      const sessionValue = String(record.fields?.["Stripe Session ID"] || "");
      if (sessionValue === stripeSessionId) {
        return record.id || null;
      }
    }

    const total = Number(json.metadata?.total || 0);
    offset += records.length;

    if (!records.length || offset >= total) {
      break;
    }
  }

  return null;
}

async function createUnlockRecord(params: {
  jobId: string;
  contractorUserId: string;
  customerEmail: string;
  stripeSessionId: string;
  phoneSnapshot: string;
  purchasedAt: string;
}) {
  const unlockFields = await getTableFields(softrUnlocksTableId!);

  const jobField = requireField(unlockFields, "Job");
  const statusTextField = requireField(unlockFields, "Status Text");
  const jobIdRawField = requireField(unlockFields, "Job ID Raw");
  const contractorUserIdField = requireField(unlockFields, "Contractor User ID");
  const unlockOwnerEmailField = requireField(unlockFields, "Unlock Owner Email");
  const phoneSnapshotRawField = requireField(unlockFields, "Phone Snapshot Raw");
  const stripeSessionIdField = requireField(unlockFields, "Stripe Session ID");
  const amountPaidField = requireField(unlockFields, "Amount Paid");
  const purchasedAtField = requireField(unlockFields, "Purchased At");

  const payloadFields: Record<string, unknown> = {
    [jobField.id]: linkedValue(jobField, params.jobId),
    [statusTextField.id]: "Succeeded",
    [jobIdRawField.id]: params.jobId,
    [contractorUserIdField.id]: params.contractorUserId,
    [phoneSnapshotRawField.id]: params.phoneSnapshot,
    [stripeSessionIdField.id]: params.stripeSessionId,
    [amountPaidField.id]: 30,
    [purchasedAtField.id]: params.purchasedAt,
  };

  if (params.customerEmail) {
    payloadFields[unlockOwnerEmailField.id] = params.customerEmail;
  }

  const url =
    `https://tables-api.softr.io/api/v1/databases/${softrDatabaseId}` +
    `/tables/${softrUnlocksTableId}/records`;

  const response = await fetch(url, {
    method: "POST",
    headers: softrHeaders(),
    body: JSON.stringify({
      fields: payloadFields,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to create unlock record: ${response.status} ${text}`);
  }

  return (await response.json()) as SoftrRecordResponse;
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

    const jobId = (session.metadata?.jobId || "").trim();
    const contractorUserId = (session.metadata?.contractorUserId || "").trim();
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

    const existingUnlockId = await findExistingUnlockByStripeSessionId(session.id);
    if (existingUnlockId) {
      return res.status(200).json({
        received: true,
        duplicate: true,
        unlockRecordId: existingUnlockId,
      });
    }

    const phoneSnapshot = await getJobPhoneSnapshot(jobId);
    const purchasedAt = new Date().toISOString();

    const created = await createUnlockRecord({
      jobId,
      contractorUserId,
      customerEmail,
      stripeSessionId: session.id,
      phoneSnapshot,
      purchasedAt,
    });

    return res.status(200).json({
      received: true,
      created: true,
      unlockRecordId: created.data?.id || null,
      jobLinked: true,
    });
  } catch (error: any) {
    console.error("stripe-webhook error:", error);
    return res.status(400).json({
      error: error?.message || "Webhook error",
    });
  }
}
