require("dotenv").config({ path: process.env.ENV_PATH || ".env" });
const express = require("express");
const bodyParser = require("body-parser");
const WebhookController = require("./src/controllers/webhookController");
const MessageQueueService = require("./src/services/messagesQueueService");

const app = express();
const port = process.env.PORT || 5500;

app.get("/", (req, res) => {
  res.send(`Webhook is running! ${process.env.NAME_ASSISTANT}`);
});

app.use("/webhook", bodyParser.raw({ type: "*/*" }));
app.post("/webhook", WebhookController.handleWebhook);

process.on("SIGINT", () => {
  console.log("Cerrando servidor...");
  MessageQueueService.cleanup();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Webhook escuchando en puerto ${port}`);
});
