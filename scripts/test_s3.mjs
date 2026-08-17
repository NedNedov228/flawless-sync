import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "nKFVQWBwr8ke3KsF",
    secretAccessKey: "RYOoFP0pHQQkNRlygwexsqlzuc7ahTbJ",
  },
  endpoint: "https://vm18027.akenai.host",
  forcePathStyle: true,
  // Since we are running in Node, we can't easily test the Stealth Token without custom fetch,
  // but let's test if we can even reach the endpoint without it (should fail or get 403).
});

async function run() {
  try {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: "obsidian-vault",
        MaxKeys: 1,
      })
    );
    console.log("Success:", response);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

run();
