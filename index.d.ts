/**
 * Timeout a promise after a specified amount of time.
 *
 * If you pass in a cancelable promise, specifically a promise with a `.cancel()` method, that method will be called when the `pTimeout` promise times out.
 *
 * @param input - Promise to decorate.
 * @param ms - Milliseconds before timing out.
 * @param message - Specify a custom error message or error. If you do a custom error, it's recommended to sub-class `pTimeout.TimeoutError`. Default: `'Promise timed out after 50 milliseconds'`.
 * @returns A decorated `input` that times out after `ms` time.
 */
export default function pTimeout<ValueType>(
	input: PromiseLike<ValueType>,
	ms: number,
	message?: string | Error
): Promise<ValueType>;

/**
 * Timeout a promise after a specified amount of time.
 *
 * If you pass in a cancelable promise, specifically a promise with a `.cancel()` method, that method will be called when the `pTimeout` promise times out.
 *
 * @param input - Promise to decorate.
 * @param ms - Milliseconds before timing out.
 * @param fallback - Do something other than rejecting with an error on timeout. You could for example retry.
 * @returns A decorated `input` that times out after `ms` time.
 *
 * @example
 *
 * import delay from 'delay';
 * import pTimeout from 'p-timeout';
 *
 * const delayedPromise = () => delay(200);
 *
 * pTimeout(delayedPromise(), 50, () => {
 * 	return pTimeout(delayedPromise(), 300);
 * });
 */
export default function pTimeout<ValueType, ReturnType>(
	input: PromiseLike<ValueType>,
	ms: number,
	fallback: () => ReturnType | Promise<ReturnType>
): Promise<ValueType | ReturnType>;

export class TimeoutError extends Error {
	readonly name: 'TimeoutError';
	constructor(message?: string);
}
