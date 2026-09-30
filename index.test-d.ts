/* eslint-disable @typescript-eslint/no-floating-promises -- the type-level calls below are the assertions */
/* eslint-disable unicorn/prefer-top-level-await -- a type test cannot await at the top level */
import {expectTypeOf, expectError} from 'nz';
import pTimeout, {TimeoutError} from './index.js';

const delayedPromise: () => Promise<string> = async () => new Promise(resolve => {
	setTimeout(() => {
		resolve('foo');
	}, 200);
});

pTimeout(delayedPromise(), {milliseconds: 50}).then(() => 'foo');
pTimeout(delayedPromise(), {milliseconds: 50, fallback: async () => pTimeout(delayedPromise(), {milliseconds: 300})});
pTimeout(delayedPromise(), {milliseconds: 50}).then(value => {
	expectTypeOf(value).toBe<string>();
});
pTimeout(delayedPromise(), {milliseconds: 50, message: 'error'}).then(value => {
	expectTypeOf(value).toBe<string>();
});
pTimeout(delayedPromise(), {milliseconds: 50, message: false}).then(value => {
	expectTypeOf(value).toBe<string | undefined>();
});
pTimeout(delayedPromise(), {milliseconds: 50, message: false, fallback: () => 10}).then(value => {
	expectTypeOf(value).toBe<string | number | undefined>();
});
pTimeout(delayedPromise(), {milliseconds: 50, message: new Error('error')}).then(value => {
	expectTypeOf(value).toBe<string>();
});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: async () => 10}).then(value => {
	expectTypeOf(value).toBe<string | number>();
});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: () => 10}).then(value => {
	expectTypeOf(value).toBe<string | number>();
});

const customTimers = {setTimeout, clearTimeout};
pTimeout(delayedPromise(), {milliseconds: 50, customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, message: 'foo', customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, message: new Error('error'), customTimers});
pTimeout(delayedPromise(), {milliseconds: 50, fallback: () => 10});

expectError(pTimeout(delayedPromise(), {
	milliseconds: 50,
	fallback: () => 10,
	customTimers: {
		setTimeout,
	},
}));

// Note: TypeScript should catch invalid setTimeout implementations

expectError(pTimeout(delayedPromise(), {})); // `milliseconds` is required

const timeoutError = new TimeoutError();
expectTypeOf(timeoutError).toBe<TimeoutError>();
