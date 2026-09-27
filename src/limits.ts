import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { FormConfig } from "./config";

const TABLE_NAME = process.env.TABLE_NAME;
const DAY_SEC = 86400;

const client = new DynamoDBClient({});

// Each returns false once the cap is reached. Keys embed the UTC day/month, so counters reset
// naturally and old items are removed by the table's TTL on `expiresAt`.

export function consumeIpDaily(form: FormConfig, ip: string, now = new Date()): Promise<boolean> {
	const day = now.toISOString().slice(0, 10);
	return consume(`d#${form.id}#${ip}#${day}`, form.ipDailyCap, now, 2 * DAY_SEC);
}

export function consumeFormMonthly(form: FormConfig, now = new Date()): Promise<boolean> {
	const month = now.toISOString().slice(0, 7);
	return consume(`m#${form.id}#${month}`, form.monthlyCap, now, 62 * DAY_SEC);
}

// Atomic increment-if-below-cap: a single conditional write, no read-then-write race.
async function consume(key: string, cap: number, now: Date, ttlSec: number): Promise<boolean> {
	const expiresAt = Math.floor(now.getTime() / 1000) + ttlSec;
	try {
		await client.send(
			new UpdateItemCommand({
				TableName: TABLE_NAME,
				Key: { pk: { S: key } },
				UpdateExpression: "ADD #count :one SET expiresAt = if_not_exists(expiresAt, :expiresAt)",
				ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
				ExpressionAttributeNames: { "#count": "count" },
				ExpressionAttributeValues: {
					":one": { N: "1" },
					":cap": { N: String(cap) },
					":expiresAt": { N: String(expiresAt) },
				},
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return false;
		throw error;
	}
}
