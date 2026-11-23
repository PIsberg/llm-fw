/**
 * How `llm-fw start` stops (#863).
 *
 * The signal handlers are registered before any resource exists, so they
 * must not name one: they once closed over `const` bindings declared further
 * down, and a SIGINT during startup threw a ReferenceError from the handler.
 * Each resource is registered here as it is created, and stop() closes what
 * has been registered by then. It runs once however often it is asked (a
 * second Ctrl-C, or the stop-request file and a signal together), closes
 * every step even when one fails, and exits after `timeoutMs` even when a
 * step never settles, naming the steps that did not finish.
 */
export interface LifecycleOptions {
  /** Synchronous teardown that must happen first: hosts file, port redirect, pid file. */
  cleanup: () => void
  exit: (code: number) => void
  log: (format: string, ...args: unknown[]) => void
  timeoutMs: number
}

export class Lifecycle {
  private readonly closers: { what: string; close: () => unknown }[] = []
  private stopping = false

  constructor(private readonly options: LifecycleOptions) {}

  /** Close `what` on stop. Registered in creation order. */
  add(what: string, close: () => unknown): void {
    this.closers.push({ what, close })
  }

  stop(code = 0): void {
    if (this.stopping) return
    this.stopping = true
    const { cleanup, exit, log, timeoutMs } = this.options
    try {
      cleanup()
    } catch (err) {
      log('[shutdown] cleanup failed:', err)
    }
    const pending = new Set(this.closers.map(c => c.what))
    const steps = this.closers.map(({ what, close }) =>
      Promise.resolve()
        .then(close)
        .then(
          () => { pending.delete(what) },
          (err: unknown) => {
            pending.delete(what)
            // Constant format string with the name as an argument, so a name
            // can never forge a log line through a `%s`.
            log('[shutdown] %s did not close cleanly:', what, err)
          },
        ))
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        log('[shutdown] gave up after %d ms waiting for: %s', timeoutMs, [...pending].join(', '))
        resolve()
      }, timeoutMs)
    })
    void Promise.race([Promise.all(steps), bound]).then(() => {
      clearTimeout(timer)
      exit(code)
    })
  }
}
