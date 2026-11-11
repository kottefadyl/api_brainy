import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// T48: link previews for the Saved links template (needs internet access for the public pages).
const url = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}/graphql`;
let token;
async function gql(query, variables = {}, expectError = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (expectError) { assert.ok(body.errors?.length, 'expected a rejection'); return body.errors[0].message; }
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}
const preview = (link, expectError) => gql('query($url:String!){linkPreview(url:$url){url available title description siteName image video}}', { url: link }, expectError);

assert.match(await preview('https://example.com', true), /Sign in/);
token = (await gql('mutation($input:RegisterInput!){register(input:$input){token}}', { input: { name: 'Link Tester', email: `links-${randomUUID()}@example.test`, password: 'temporary-test-password' } })).register.token;

const created = (await gql('mutation{createCollectionFromTemplate(templateId:"links",name:"Liens",language:"fr"){id templateId}}')).createCollectionFromTemplate;
assert.equal(created.templateId, 'links');

for (const blocked of ['http://127.0.0.1/', 'http://localhost:3000/graphql', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/', 'https://example.com:8443/']) {
  assert.match(await preview(blocked, true), /public web address/, blocked);
}

const page = (await preview('https://example.com/')).linkPreview;
assert.equal(page.available, true);
assert.equal(page.title, 'Example Domain');

const video = (await preview('https://youtube.com/shorts/fWB9blq0H34?si=1gaNhS1bqtlFnuUr')).linkPreview;
assert.equal(video.video, true);
assert.equal(video.siteName, 'YouTube');
assert.ok(video.title, 'YouTube title');
assert.match(video.image ?? '', /^data:image\/(jpeg|webp|png);base64,/);

const again = (await preview('https://youtube.com/shorts/fWB9blq0H34?si=1gaNhS1bqtlFnuUr')).linkPreview;
assert.equal(again.title, video.title, 'served from cache');

await gql('mutation($id:String!){deleteCollection(id:$id)}', { id: created.id });
console.log(`LINK_PREVIEW_SMOKE_PASSED (${video.title})`);
