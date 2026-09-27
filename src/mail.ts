import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { FormConfig } from "./config";
import type { Submission } from "./contact";

export interface RequestMeta {
	ip: string;
	userAgent: string;
}

const client = new SESv2Client({});

function composeBody(form: FormConfig, submission: Submission, meta: RequestMeta): string {
	const extras = Object.entries(submission.extra).map(([name, value]) => `${name}: ${value}`);
	return [
		`From: ${submission.email}`,
		...extras,
		"",
		submission.message,
		"",
		"---",
		`Form: ${form.id} (${form.site})`,
		`IP: ${meta.ip}`,
		`User agent: ${meta.userAgent}`,
	].join("\n");
}

export async function sendMail(form: FormConfig, submission: Submission, meta: RequestMeta): Promise<void> {
	await client.send(
		new SendEmailCommand({
			FromEmailAddress: form.from,
			Destination: { ToAddresses: [form.to] },
			ReplyToAddresses: [submission.email],
			Content: {
				// SES assumes 7-bit ASCII unless told otherwise, which garbles non-English names and messages.
				Simple: {
					Subject: { Data: form.subject, Charset: "UTF-8" },
					Body: { Text: { Data: composeBody(form, submission, meta), Charset: "UTF-8" } },
				},
			},
		}),
	);
}
