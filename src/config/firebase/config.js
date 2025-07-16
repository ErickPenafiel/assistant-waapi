const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
	Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, "base64").toString(
		"utf-8"
	)
);

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = {
	db,
	admin,
};
