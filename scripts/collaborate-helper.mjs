// T52: sharing a collection requires a collaboration. Smokes call this before addCollectionMember.
const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const call = async (query, token) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables: {} }) });
  const result = await response.json();
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
};

/** Makes the two people collaborators: the second accepts the first one's personal link. */
export async function collaborate(inviterToken, ...otherTokens) {
  const { collaborationInviteToken: token } = await call('query{collaborationInviteToken}', inviterToken);
  for (const other of otherTokens) await call(`mutation{acceptCollaboration(token:${JSON.stringify(token)}){userId}}`, other);
}
