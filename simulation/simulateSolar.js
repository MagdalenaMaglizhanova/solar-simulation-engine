import admin from "firebase-admin";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// примерен запис
await db.collection("solarData").add({
  city: "Plovdiv",
  powerW: 780,
  energyWh: 195,
  batteryCharge: 42,
  timestamp: new Date()
});

console.log("Simulation completed, data saved to Firestore");
