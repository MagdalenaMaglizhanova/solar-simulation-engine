import admin from "firebase-admin";

async function runSimulation() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();

  // Примерни симулационни стойности
  const power = Math.floor(Math.random() * 1000); // W
  const energy = Math.floor(Math.random() * 500); // Wh
  const batteryCharge = Math.floor(Math.random() * 100); // %

  // Запис в Firestore
  await db.collection("solarData").add({
    city: "Plovdiv",
    powerW: power,
    energyWh: energy,
    batteryCharge: batteryCharge,
    timestamp: new Date()
  });

  console.log("Simulation completed, data saved to Firestore");
}

// Стартираме функцията
runSimulation().catch(err => {
  console.error("Simulation failed:", err);
  process.exit(1); // GitHub Action ще види, че е failed
});
