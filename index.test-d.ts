import {expectType} from 'tsd';
import pTimeout = require('.');
import {TimeoutError} from '.';

const delayedPromise: () => Promise<string> = () =>
	new Promise(resolve => setTimeout(() => resolve('foo'), 200));

pTimeout(delayedPromise(), 50).then(() => 'foo');
pTimeout(delayedPromise(), 50, () => {
	return pTimeout(delayedPromise(), 300);
});
pTimeout(delayedPromise(), 50).then(value => expectType<string>(value));
pTimeout(delayedPromise(), 50, 'error').then(value =>
	expectType<string>(value)
);
pTimeout(delayedPromise(), 50, new Error('error')).then(value =>
	expectType<string>(value)
);
pTimeout(delayedPromise(), 50, async () => 10).then(value => {
	expectType<string | number>(value);
});
pTimeout(delayedPromise(), 50, () => 10).then(value => {
	expectType<string | number>(value);
});

const timeoutError = new TimeoutError();
expectType<TimeoutError>(timeoutError);
