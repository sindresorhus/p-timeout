'use strict';
const delay = require('delay');

class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TimeoutError';
	}
}

module.exports = (promise, ms, fallback) => new Promise((resolve, reject) => {
	if (typeof ms !== 'number' && ms >= 0) {
		throw new TypeError('Expected `ms` to be a positive number');
	}

	delay(ms).then(() => {
		if (typeof fallback === 'function') {
			resolve(fallback());
			return;
		}

		const message = typeof fallback === 'string' ? fallback : `Promise timed out after ${ms} milliseconds`;
		const err = fallback instanceof Error ? fallback : new TimeoutError(message);

		reject(err);
	});
	promise.then(resolve, reject);
});
module.exports.TimeoutError = TimeoutError;
