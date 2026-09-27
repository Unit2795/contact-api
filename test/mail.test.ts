import { type SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { describe, expect, it, vi } from "vitest";
import { sendMail } from "../src/mail";
import { form } from "./fixtures";

describe("sendMail", () => {
	it("sends plain text to the form's recipient with Reply-To set to the submitter", async () => {
		const send = vi.spyOn(SESv2Client.prototype, "send").mockResolvedValue({} as never);
		const submission = { email: "someone@example.com", message: "Hello there, friend.", extra: { name: "Ann" } };

		await sendMail(form, submission, { ip: "203.0.113.7", userAgent: "test-agent" });

		const { input } = send.mock.lastCall?.[0] as SendEmailCommand;
		expect(input).toMatchObject({
			FromEmailAddress: "forms@example.com",
			Destination: { ToAddresses: ["owner@example.com"] },
			ReplyToAddresses: ["someone@example.com"],
			Content: { Simple: { Subject: { Data: "Test" } } },
		});
		expect(input.Content?.Simple?.Body?.Text?.Data).toBe(
			[
				"From: someone@example.com",
				"name: Ann",
				"",
				"Hello there, friend.",
				"",
				"---",
				"Form: test-form (test-site)",
				"IP: 203.0.113.7",
				"User agent: test-agent",
			].join("\n"),
		);
	});
});
