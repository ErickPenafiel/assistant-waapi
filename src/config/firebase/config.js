const admin = require("firebase-admin");
const serviceAccount = require("./quiropractica-wemen-firebase-adminsdk-vz0gp-c71b4e6b1f.json");

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = {
	db,
	admin,
};
