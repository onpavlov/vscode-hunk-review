import * as assert from 'node:assert';
import {
	createUserAvatarResolver,
	githubAvatarUri,
	parseGithubNoreplyUsername,
} from '../userAvatar.js';

suite('parseGithubNoreplyUsername', () => {
	test('extracts the username from the id-prefixed noreply format', () => {
		assert.strictEqual(
			parseGithubNoreplyUsername('12345+octocat@users.noreply.github.com'),
			'octocat',
		);
	});

	test('extracts the username from the id-less noreply format', () => {
		assert.strictEqual(parseGithubNoreplyUsername('octocat@users.noreply.github.com'), 'octocat');
	});

	test('is case-insensitive on the domain', () => {
		assert.strictEqual(
			parseGithubNoreplyUsername('octocat@USERS.NOREPLY.GITHUB.COM'),
			'octocat',
		);
	});

	test('returns undefined for a regular email', () => {
		assert.strictEqual(parseGithubNoreplyUsername('octocat@example.com'), undefined);
	});

	test('returns undefined for an empty string', () => {
		assert.strictEqual(parseGithubNoreplyUsername(''), undefined);
	});
});

suite('githubAvatarUri', () => {
	test('builds the github.com/<user>.png URL', () => {
		assert.strictEqual(githubAvatarUri('octocat').toString(), 'https://github.com/octocat.png');
	});

	test('percent-encodes the username', () => {
		assert.strictEqual(
			githubAvatarUri('a b').toString(),
			'https://github.com/a%20b.png',
		);
	});
});

suite('createUserAvatarResolver', () => {
	// The `hunk-review.githubUsername` setting is unset by default in the test host,
	// so refresh() falls through to the injected git email here.
	test('uri() is undefined before the first refresh()', () => {
		const resolver = createUserAvatarResolver(async () => undefined);
		assert.strictEqual(resolver.uri(), undefined);
	});

	test('falls back to a noreply email parsed username when no setting is configured', async () => {
		const resolver = createUserAvatarResolver(async () => '99+octocat@users.noreply.github.com');
		await resolver.refresh();
		assert.strictEqual(resolver.uri()?.toString(), 'https://github.com/octocat.png');
	});

	test('stays undefined when the email is not a github noreply address', async () => {
		const resolver = createUserAvatarResolver(async () => 'someone@example.com');
		await resolver.refresh();
		assert.strictEqual(resolver.uri(), undefined);
	});

	test('stays undefined when there is no email at all', async () => {
		const resolver = createUserAvatarResolver(async () => undefined);
		await resolver.refresh();
		assert.strictEqual(resolver.uri(), undefined);
	});
});
