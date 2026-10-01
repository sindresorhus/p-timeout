export class TimeoutError extends Error {
	name = 'TimeoutError';

	constructor(message, options) {
		super(message, options);
		// V8-only, and it does exactly one thing here: it hides this constructor frame from the stack.
		// eslint-disable-next-line unicorn/no-useless-error-capture-stack-trace, unicorn/no-nonstandard-builtin-properties
		Error.captureStackTrace?.(this, TimeoutError);
	}
}

// An `AbortSignal` always has a reason once aborted, and that reason is whatever the caller passed to `abort()`, including `null`. Only hand-rolled signal objects can lack the property entirely.
const getAbortedReason = signal => 'reason' in signal
	? signal.reason
	: new DOMException('This operation was aborted.', 'AbortError');

// `setTimeout` stores its delay in a 32-bit signed integer, so this is the largest delay it can represent.
const maximumDelay = (2 ** 31) - 1;

const getOptionsError = (milliseconds, customTimers) => {
	if (typeof milliseconds !== 'number' || Math.sign(milliseconds) !== 1) {
		return new TypeError(`Expected \`milliseconds\` to be a positive number, got \`${milliseconds}\``);
	}

	if (typeof customTimers?.setTimeout !== 'function' || typeof customTimers?.clearTimeout !== 'function') {
		return new TypeError('Expected `customTimers` to have a `setTimeout` and a `clearTimeout` function');
	}
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

	// Best-effort cancellation of the input, so a throwing `.cancel()` can neither escape the timer callback as an uncaught exception nor prevent us from settling. Anything that is not callable is skipped by the same `try`. It always runs after the outcome is decided, as `.cancel()` may settle the input synchronously through the handlers we passed to `then`.
	const cancelInput = () => {
		try {
			promise.cancel?.();
		} catch {
			// Ignored: the outcome matters more than a failure to stop the work early.
		}
	};

	const wrappedPromise = new Promise((resolve, reject) => {
		const abort = () => {
			reject(getAbortedReason(signal));
			// The caller no longer wants the result, so stop the underlying work, the same as a timeout does.
			cancelInput();
		};

		// `input` is a `PromiseLike`, so it may settle during the call to `then`. Anything that has to win over its outcome, an invalid option or an abort the caller already committed to, is therefore decided before it is attached. Otherwise a synchronous thenable settles the wrapper first and buries both.
		const optionsError = getOptionsError(milliseconds, customTimers);
		const isAborted = !optionsError && signal?.aborted;

		if (optionsError) {
			reject(optionsError);
		} else if (isAborted) {
			abort();
		}

		// Use .then() instead of async IIFE to preserve stack traces. This also observes the input when it has already lost, so its rejection cannot escape as an unhandled rejection that crashes the process and hides the real error. It has to be the only handler on the input, as an extra one costs the input's rejection its caller frames in the stack trace.
		// eslint-disable-next-line unicorn/prefer-then-catch
		promise.then(resolve, reject);

		if (optionsError || isAborted) {
			return;
		}

		if (signal) {
			abortHandler = abort;
			signal.addEventListener('abort', abortHandler, {once: true});
		}

		// A delay that `setTimeout` cannot represent never elapses, so there is nothing to time out. Without this, `setTimeout` silently clamps anything above 2 ** 31 - 1 to 1ms and the timeout fires at once.
		if (milliseconds > maximumDelay) {
			return;
		}

		// We create the error outside of `setTimeout` to preserve the stack trace, but only when the timeout can actually reject with it, since capturing a stack trace is expensive and most promises settle first.
		const timeoutError = fallback || message === false || message instanceof Error
			? undefined
			: new TimeoutError(message ?? `Promise timed out after ${milliseconds} milliseconds`);

		// `.call(undefined, ...)` is needed for custom timers to avoid context issues
		timer = customTimers.setTimeout.call(undefined, () => {
			if (fallback) {
				try {
					resolve(fallback());
				} catch (error) {
					reject(error);
				}
			} else if (message === false) {
				resolve();
			} else {
				reject(message instanceof Error ? message : timeoutError);
			}

			// The input timed out even when a fallback takes over, and the readme promises `.cancel()` runs on timeout.
			cancelInput();
		}, milliseconds);
	});

	const cancelablePromise = wrappedPromise.finally(() => {
		// The outcome is already decided, so a failing cleanup step must neither change it nor stop the other step: a `clearTimeout` that throws must not leave the abort listener attached.
		try {
			cancelablePromise.clear();
		} catch {
			// Ignored. The timer handle is deliberately left in place so an explicit `clear()` can still retry.
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
