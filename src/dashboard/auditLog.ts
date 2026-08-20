import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { BlockEvent, AuditConfig } from '../types.js';
import { getLlmFwDir } from '../config/paths.js';
import { RULESET_VERSION } from '../detection/ruleset.js';
import { createLogger } from '../logger.js';

const log = createLogger('audit');

/**
 * A durable destination for events. Both sinks below implement it, and
 * EventBus.emit() fans out to whatever it was given, so adding a sink never
 * means touching the scanners that produce events.
 *
 * `write` is synchronous and must never throw: it runs inside the request path.
 */
export interface AuditSink {
  write(event: BlockEvent): void;
}

/**
 * Durable audit trail.
 *
 * Events otherwise live only in an in-memory ring sized by dashboard.maxEvents
 * (100 by default), so a busy hour erases the morning and a restart erases
 * everything. That is fine for a developer watching a live dashboard and
 * useless for the two questions a company actually asks: "show me every block
 * for this service last quarter" and "prove this record was not edited".
 *
 * The file is newline-delimited JSON — greppable, tailable, and the format every
 * log shipper already understands, so the SIEM story is "point Vector/Fluent
 * Bit at this file" rather than a bespoke integration.
 *
 * Writes are append-only and asynchronous: an audit sink must never be able to
 * add latency to, or fail, a request that the firewall already decided to
 * allow. A failed write is reported once and then counted, not retried into a
 * queue that could grow without bound.
 */
export class AuditLog {
  private readonly config: AuditConfig;
  private stream: fs.WriteStream | null = null;
  private path: string;
  private writeFailures = 0;
  private warned = false;
  /** Bytes written to the current generation, counted in process. */
  private bytesWritten = 0;
  /** True while a rotation's flush-and-rename is in flight. */
  private rotating = false;
  /** Resolves when the in-flight rotation has finished; null when idle. */
  private rotation: Promise<void> | null = null;
  /** Lines that arrived mid-rotation, replayed into the new generation. */
  private pending: string[] = [];

  constructor(config: AuditConfig) {
    this.config = config;
    this.path = config.file ?? join(getLlmFwDir(), 'audit.jsonl');
  }

  /** Absolute path of the current audit file. */
  get filePath(): string { return this.path; }

  /** Count of writes that failed since start, surfaced by /metrics. */
  get failures(): number { return this.writeFailures; }

  open(): void {
    if (!this.config.enabled || this.stream || this.rotating) return;
    try {
      fs.mkdirSync(dirname(this.path), { recursive: true });
      // Continue counting from whatever a previous run left behind, so an
      // append across restarts still rotates at the configured size.
      this.bytesWritten = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0;
    } catch (err) {
      this.noteFailure(err);
    }
    this.stream = fs.createWriteStream(this.path, { flags: 'a' });
    this.stream.on('error', (err) => this.noteFailure(err));
  }

  async close(): Promise<void> {
    // A rotation in flight owns the stream; closing underneath it would leave
    // the replacement stream open and the held lines unwritten.
    if (this.rotation) await this.rotation;
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>(resolve => stream.end(() => resolve()));
  }

  /**
   * Append one event. Records are self-describing: the ruleset version travels
   * with every line, because an audit read six months later must not depend on
   * knowing which build was deployed at the time.
   */
  write(event: BlockEvent): void {
    if (!this.config.enabled) return;
    if (!this.stream && !this.rotating) this.open();

    const record = {
      ...event,
      ruleset: RULESET_VERSION,
      // Payloads can carry customer data and secrets. Off by default so
      // enabling the audit log never silently starts writing prompt text to
      // disk; `includePayloads` is the deliberate opt-in.
      ...(this.config.includePayloads ? {} : { payload_full: undefined, payload_preview: undefined }),
    };

    const line = JSON.stringify(record) + '\n';
    // A rotation is a flush plus a rename, both asynchronous. Events that
    // arrive during that window are held rather than written, because writing
    // them would either land them in the file about to be renamed away or
    // re-create the file underneath the rename.
    if (this.rotating) {
      this.pending.push(line);
      return;
    }
    if (!this.stream) return;
    try {
      this.stream.write(line);
      this.bytesWritten += Buffer.byteLength(line);
    } catch (err) {
      this.noteFailure(err);
    }
    this.rotateIfNeeded();
  }

  private noteFailure(err: unknown): void {
    this.writeFailures++;
    if (this.warned) return;
    this.warned = true;
    // Once, not per event: a full disk would otherwise turn one problem into a
    // second one by flooding the console.
    log.error(`write failed (${(err as Error)?.message ?? String(err)}). ` +
      `Further failures are counted in llmfw_audit_write_failures_total.`);
  }

  /**
   * Size-based rotation to `<file>.1`. Deliberately simple: a single previous
   * generation bounds disk use without pretending to be logrotate, which is
   * what a production deployment should use on the file anyway.
   */
  private rotateIfNeeded(): void {
    const max = this.config.maxFileBytes ?? 64 * 1024 * 1024;
    // Deliberately the in-process byte count, not statSync: writes go through a
    // buffered stream, so the on-disk size lags arbitrarily behind and a
    // size check against it would rotate late or never. It also keeps a syscall
    // off the request path, which is where every write happens.
    if (this.bytesWritten < max || this.rotating) return;

    const previous = this.path + '.1';
    const stream = this.stream;
    this.stream = null;
    this.rotating = true;

    // The rename must wait for the stream to flush and close. Renaming first
    // would move a file the buffered tail has not reached yet, so the last
    // records of the old generation would reappear at the head of the new one.
    this.rotation = new Promise<void>((resolve) => {
      const finish = (): void => {
        try {
          if (fs.existsSync(previous)) fs.unlinkSync(previous);
          if (fs.existsSync(this.path)) fs.renameSync(this.path, previous);
        } catch (err) {
          this.noteFailure(err);
        }
        this.bytesWritten = 0;
        const next = fs.createWriteStream(this.path, { flags: 'a' });
        next.on('error', (err) => this.noteFailure(err));
        this.stream = next;
        this.rotating = false;
        const held = this.pending;
        this.pending = [];
        for (const line of held) {
          next.write(line);
          this.bytesWritten += Buffer.byteLength(line);
        }
        this.rotation = null;
        resolve();
      };
      if (stream) stream.end(finish); else finish();
    });
  }
}

/**
 * Fire-and-forget webhook shipper for a SIEM or collector.
 *
 * Batched and bounded: a slow collector must not become the firewall's latency,
 * and a collector that is down must not grow an unbounded queue in a process
 * that is also holding request buffers. When the queue is full the oldest
 * records are dropped and counted — losing old telemetry beats losing the
 * service.
 */
export class AuditWebhook {
  private queue: BlockEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  private failures = 0;

  constructor(
    private readonly url: string,
    private readonly maxQueue = 1000,
    private readonly flushMs = 2000,
    private readonly headers: Record<string, string> = {},
  ) {}

  get droppedCount(): number { return this.dropped; }
  get failureCount(): number { return this.failures; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }

  write(event: BlockEvent): void {
    // Drop the OLDEST and keep the newest. Returning early here instead would
    // discard the incoming event as well, so a full queue would shed roughly
    // half of everything rather than sliding forward over the newest records.
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(event);
  }

  async flush(): Promise<void> {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify({ ruleset: RULESET_VERSION, events: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.failures++;
    } catch {
      // Dropped rather than requeued: a collector that has been down for an
      // hour would otherwise hand back an hour of backlog the moment it
      // returns, and the file sink is the durable record either way.
      this.failures++;
    }
  }
}
