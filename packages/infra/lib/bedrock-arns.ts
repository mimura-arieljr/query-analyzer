const SUPPORTED_PREFIXES = ['global.', 'au.'];

// Foundation model ARNs the inference profile may route to.
export function foundationModelArns(profileId: string, modelId: string, homeRegion: string): string[] {
  const fm = (region: string) => `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
  if (profileId.startsWith('global.')) return [fm(''), fm(homeRegion)];
  if (profileId.startsWith('au.')) return [fm('ap-southeast-2'), fm('ap-southeast-4')];
  throw new Error(
    `Unsupported inference profile prefix in "${profileId}". Supported prefixes: ${SUPPORTED_PREFIXES.join(', ')}`,
  );
}

export function inferenceProfileArn(profileId: string, region: string, account: string): string {
  return `arn:aws:bedrock:${region}:${account}:inference-profile/${profileId}`;
}
