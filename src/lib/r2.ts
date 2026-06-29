import "server-only";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { appConfig, hasR2Config } from "@/lib/config";

let r2Client: S3Client | null = null;

export function getR2Bucket() {
  return appConfig.r2Bucket;
}

export function createR2Client() {
  if (!hasR2Config()) {
    throw new Error("Cloudflare R2 is not configured.");
  }

  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint:
        appConfig.r2Endpoint ||
        `https://${appConfig.r2AccountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: appConfig.r2AccessKeyId,
        secretAccessKey: appConfig.r2SecretAccessKey,
      },
    });
  }

  return r2Client;
}

export async function createR2SignedReadUrl(key: string) {
  const client = createR2Client();
  const command = new GetObjectCommand({
    Bucket: appConfig.r2Bucket,
    Key: key,
  });

  return getSignedUrl(client, command, {
    expiresIn: appConfig.r2SignedUrlTtlSeconds,
  });
}
