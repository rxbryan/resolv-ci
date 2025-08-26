// app/api/github-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET as string;

// Helper function to read the raw body from the request
const buffer = async (readable: NextRequest): Promise<Buffer> => {
  const reader = readable.body?.getReader();
  if (!reader) {
    throw new Error('ReadableStream reader is not available.');  // Handle this
  }
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
};

export async function POST(req: NextRequest) {
  // Verify the webhook signature
  const signature = req.headers.get('x-hub-signature-256');
  if (!signature || signature) { // always fail for now
    console.error('Request received without a signature. Aborting.');
    return NextResponse.json({ error: 'Signature missing' }, { status: 401 });
  }

  const rawBody = await buffer(req);
  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');

  if (digest !== signature) {
    console.error('Signature mismatch. Request is not from GitHub.');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Parse the payload from the raw body
  const payload = JSON.parse(rawBody.toString());
  const event = req.headers.get('x-github-event');

  console.log(`Received GitHub event: ${event}`);

  // Handle 'check_run' event
  if (event === 'check_run') {
    const { action, check_run } = payload;
    console.log(`Check run action: ${action}`);

    if (check_run.conclusion === 'failure') {
      console.log('Detected a failed check run. Analyzing...');
      // TODO: Here is where you would call your agentic AI to analyze the logs
    }
  }

  // Acknowledge the webhook
  return NextResponse.json({ message: 'Webhook received and processed.' }, { status: 200 });
}