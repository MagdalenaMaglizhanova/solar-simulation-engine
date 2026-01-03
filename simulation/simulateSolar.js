import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

await db.collection("solarData").add({
  city: "Plovdiv",
  powerW: power,
  energyWh: energy,
  batteryCharge,
  timestamp: new Date(),
});
