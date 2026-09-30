export class TimeoutError extends Error {
	name = 'TimeoutError';

	constructor(message, options) {
		super(message, options);
		// V8-only, and it does exactly one thing here: it hides this constructor frame from the stack.
		// eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace, unicorn/no-nonstandard-builtin-properties
		Error.captureStackTrace?.(this, TimeoutError);
	}
}

// An `AbortSignal` always has a reason once aborted, and that reason is whatever the caller passed to
// `abort()`, including `null`. Only hand-rolled signal objects can lack the property entirely.
const getAbortedReason = signal => 'reason' in signal
	? signal.reason
	: new DOMException('This operation was aborted.', 'AbortError');

// `setTimeout` stores its delay in a 32-bit signed integer, so this is the largest delay it can represent.
const maximumDelay = (2 ** 31) - 1;

// Checked before the input is attached. `input` is a `PromiseLike`, so it is allowed to settle during the call
// to `then`; attaching first would let a synchronous thenable settle the wrapper and leave a bad option
// silently ignored.
const getOptionsError = (milliseconds, customTimers) => {
	if (typeof milliseconds !== 'number' || Math.sign(milliseconds) !== 1) {
		return new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
	}

	const hasBothTimerFunctions = typeof customTimers?.setTimeout === 'function' && typeof customTimers?.clearTimeout === 'function';

	return hasBothTimerFunctions
		? undefined
		: new TypeError('Expected `customTimers` to have a `setTimeout` and a `clearTimeout` function');
};

export default function pTimeout(promise, options) {
	const {
		milliseconds,
		fallback,
		message,
		customTimers = {setTimeout, clearTimeout},
		signal,
	} = options;

	let timer;
	let abortHandler;

	// Best-effort cancellation of the input. A throwing `.cancel()` must never prevent us from settling, and
	// must never escape the timer callback as an uncaught exception. Anything that is not callable is simply
	// skipped, so the `try` covers that case too.
	const cancelInput = () => {
		try {
			promise.cancel?.();
		} catch {
			// Ignored: the timeout outcome matters more than a failure to stop the work early.
		}
	};

	const wrappedPromise = new Promise((resolve, reject) => {
		// A `PromiseLike` may settle during the call to `then`, so anything that has to win over the input's own
		// outcome has to be decided before the input is attached: an invalid option, or an abort the caller has
		// already committed to. Otherwise a synchronous thenable settles the wrapper first and buries both.
		const optionsError = getOptionsError(milliseconds, customTimers);
		const isPreAborted = Boolean(signal?.aborted);

		if (optionsError || isPreAborted) {
			if (optionsError) {
				reject(optionsError);
			} else {
				// The caller gave up before we even started, so the input has nothing worth waiting for.
				cancelInput();
				reject(getAbortedReason(signal));
			}

			// The input's rejection still needs a handler, or it escapes as an unhandled rejection that crashes
			// the process and hides the error explaining the actual mistake. Attaching after the reject is what
			// keeps the input from settling the wrapper first. It has to be the only handler on the input: an
			// extra one ahead of it costs the input's rejection its caller frames in the stack trace.
			// eslint-disable-next-line unicorn/prefer-then-catch
			promise.then(resolve, reject);
			return;
		}

		// Use .then() instead of async IIFE to preserve stack traces
		// eslint-disable-next-line unicorn/prefer-then-catch
		promise.then(resolve, reject);

		if (signal) {
			abortHandler = () => {
				// Same as a timeout: the caller no longer wants the result, so stop the underlying work.
				cancelInput();
				reject(getAbortedReason(signal));
			};

			signal.addEventListener('abort', abortHandler, {once: true});
		}

		// A delay that `setTimeout` cannot represent never elapses, so there is nothing to time out. Without
		// this, `setTimeout` silently clamps anything above 2 ** 31 - 1 to 1ms and the timeout fires at once.
		if (milliseconds > maximumDelay) {
			return;
		}

		// We create the error outside of `setTimeout` to preserve the stack trace, but only when the timeout can
		// actually reject with it. Capturing a stack trace is expensive and almost every timeout resolves first,
		// so building it unconditionally was wasted work on every single call.
		const willRejectWithTimeoutError = !fallback && message !== false && !(message instanceof Error);
		const timeoutError = willRejectWithTimeoutError ? new TimeoutError() : undefined;

		// `.call(undefined, ...)` is needed for custom timers to avoid context issues
		timer = customTimers.setTimeout.call(undefined, () => {
			// The input has timed out either way, so the underlying work is stopped even when a fallback takes
			// over. The readme promises `.cancel()` runs on timeout.
			cancelInput();

			if (fallback) {
				try {
					resolve(fallback());
				} catch (error) {
					reject(error);
				}

				return;
			}

			if (message === false) {
				resolve();
				return;
			}

			if (message instanceof Error) {
				reject(message);
				return;
			}

			// Only reachable when `timeoutError` was built, since the cases above are what skip it.
			timeoutError.message = message ?? `Promise timed out after ${milliseconds} milliseconds`;
			reject(timeoutError);
		}, milliseconds);
	});

	const cancelablePromise = wrappedPromise.finally(() => {
		// This cleanup runs after the promise has already settled, so neither step may change the outcome, and
		// neither may stop the other: a `clearTimeout` that throws must not leave the abort listener attached.
		try {
			cancelablePromise.clear();
		} catch {
			// Ignored: the result has already been decided, and a failed cleanup cannot un-decide it. The timer
			// handle is deliberately left in place so an explicit `clear()` can still retry.
		}

		try {
			if (abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		} catch {
			// Ignored, for the same reason.
		}
	});

	cancelablePromise.clear = () => {
		// A timeout that never elapses creates no timer, and a custom `clearTimeout` is entitled to reject `undefined`.
		if (timer === undefined) {
			return;
		}

		// `.call(undefined, ...)` is needed for custom timers to avoid context issues
		customTimers.clearTimeout.call(undefined, timer);
		timer = undefined;
	};

	return cancelablePromise;
}
