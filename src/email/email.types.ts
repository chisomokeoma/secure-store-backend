// Names shared between the EmailService (producer) and EmailProcessor
// (consumer). Job *name* is BullMQ's discriminator — different names can
// have different handlers in the processor. For now both branches go
// through the same Nodemailer call, but breaking them out lets us add
// per-kind metrics or different retry policies later.

export const EMAIL_QUEUE_NAME = 'email';

export enum EmailJobName {
  GENERIC = 'generic',
  TEST = 'test',
}

// What the processor receives. The body is fully rendered before enqueue
// (locked-in semantics — template edits don't retro-mutate queued jobs).
export interface EmailJobPayload {
  to: string;
  subject: string;
  text: string;
  // Reserved for the HTML template upgrade. The processor falls through
  // gracefully when this is absent.
  html?: string;
}
