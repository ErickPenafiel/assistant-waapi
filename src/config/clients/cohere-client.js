require("dotenv").config();

const cohere = require("cohere-ai");

const cohereClient = new cohere.CohereClientV2({
	token: process.env.COHERE_API_KEY,
});

module.exports = {
	cohereClient,
};
