require("dotenv").config({ path: process.env.ENV_PATH || ".env" });

const {
	createWasender,
	RetryConfig,
	FetchImplementation,
} = require("wasenderapi");

const apiKey = process.env.WASENDER_API_KEY;
const personalAccessToken = process.env.WASENDER_PERSONAL_ACCESS_TOKEN;
const webhookSecret = process.env.WASENDER_WEBHOOK_SECRET;

const retryOptions = {
	enabled: true,
	maxRetries: 3,
};

const wasender = createWasender(
	apiKey,
	personalAccessToken,
	undefined,
	undefined,
	retryOptions,
	webhookSecret
);

module.exports = {
	wasender,
	FetchImplementation,
	RetryConfig,
};
