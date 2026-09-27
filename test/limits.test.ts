import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeFormMonthly, consumeIpDaily } from "../src/limits";
import { form } from "./fixtures";

const NOW = new Date("2026-09-22T12:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;

const send = vi.spyOn(DynamoDBClient.prototype, "send");

function lastInput() {
	return (send.mock.lastCall?.[0] as UpdateItemCommand).input;
}

afterEach(() => send.mockReset());

describe("limits", () => {
	it("increments a per-IP daily counter, conditioned on the cap", async () => {
		send.mockResolvedValue({} as never);
		expect(await consumeIpDaily(form, "203.0.113.7", NOW)).toBe(true);
		expect(lastInput()).toMatchObject({
			Key: { pk: { S: "d#test-form#203.0.113.7#2026-09-22" } },
			ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
			ExpressionAttributeValues: { ":cap": { N: "2" }, ":expiresAt": { N: String(NOW_SEC + 2 * 86400) } },
		});
	});

	it("keys the monthly counter by year and month", async () => {
		send.mockResolvedValue({} as never);
		expect(await consumeFormMonthly(form, NOW)).toBe(true);
		expect(lastInput()).toMatchObject({
			Key: { pk: { S: "m#test-form#2026-09" } },
			ExpressionAttributeValues: { ":cap": { N: "5" } },
		});
	});

	it("returns false when the cap is reached", async () => {
		send.mockRejectedValue(new ConditionalCheckFailedException({ message: "cap", $metadata: {} }) as never);
		expect(await consumeFormMonthly(form, NOW)).toBe(false);
	});

	it("rethrows other errors", async () => {
		send.mockRejectedValue(new Error("throttled") as never);
		await expect(consumeIpDaily(form, "1.2.3.4", NOW)).rejects.toThrow("throttled");
	});
});
