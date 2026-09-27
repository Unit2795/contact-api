import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { FormConfig } from "./config";

const TABLE_NAME = process.env.TABLE_NAME;
const DAY_SEC = 86400;

const client = new DynamoDBClient({});

// Each returns false once the cap is reached. Keys embed the UTC day/month, so counters reset
// naturally and old items are removed by the table's TTL on `expiresAt`.

export function consumeIpDaily(form: FormConfig, ip: string, now = new Date()): Promise<boolean> {
	const day = now.toISOString().slice(0, 10);
	return consume(`d#${form.id}#${clientBucket(ip)}#${day}`, form.ipDailyCap, now, 2 * DAY_SEC);
}

export function consumeFormMonthly(form: FormConfig, now = new Date()): Promise<boolean> {
	const month = now.toISOString().slice(0, 7);
	return consume(`m#${form.id}#${month}`, form.monthlyCap, now, 62 * DAY_SEC);
}

// One IPv6 host usually controls a whole /64 of addresses, so IPv6 clients are counted by their /64 prefix.
function clientBucket(ip: string): string {
	if (!ip.includes(":")) return ip;

	const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
	if (mappedIpv4) return mappedIpv4;

	// Expand "::" so the first four groups can be read, e.g. 2001:db8::1 -> 2001:db8:0:0:0:0:0:1.
	const [head, tail] = ip.split("::");
	const headGroups = head ? head.split(":") : [];
	const tailGroups = tail ? tail.split(":") : [];
	const zeros = tail === undefined ? [] : Array(8 - headGroups.length - tailGroups.length).fill("0");
	const groups = [...headGroups, ...zeros, ...tailGroups];
	return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
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
