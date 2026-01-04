import admin from "firebase-admin";
import fetch from "node-fetch";

async function runSimulation() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();

  // 1. Вземаме данни от времето
  const city = "Plovdiv";
  const weatherRes = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${city}`);
  const weatherData = await weatherRes.json();
  
  const cloudCover = weatherData.current.cloud || 0; // проценти облаци
  const sunFactor = (100 - cloudCover) / 100;        // 1.0 = пълно слънце, 0 = облачно

  // 2. Соларна мощност според времето + време на деня
  const now = new Date();
  const hour = now.getHours();
  const isDaytime = hour >= 6 && hour <= 20;
  
  let maxSolarPower = 0;
  if (isDaytime) {
    // Синусова крива: пик в обяд (12:00)
    const solarHour = (hour - 6) / 14; // 0-1 през деня
    const solarPosition = Math.sin(solarHour * Math.PI); // 0 в 6:00 и 20:00, 1 в 13:00
    maxSolarPower = Math.floor(1000 * solarPosition * sunFactor);
  } else {
    // Нощем почти няма слънчева мощност
    maxSolarPower = Math.floor(50 * sunFactor); // минимална мощност
  }

  const solarPower = Math.max(0, maxSolarPower);

  // 3. Симулираме батерията - КОРИГИРАНО ИЗЧИСЛЕНИЕ
  const lastDocSnapshot = await db.collection("solarData").orderBy("timestamp", "desc").limit(1).get();
  let lastBatteryCharge = 75; // default 75% (не 50!)
  
  if (!lastDocSnapshot.empty) {
    lastBatteryCharge = lastDocSnapshot.docs[0].data().batteryCharge || 75;
  }

  // Консумация според времето на деня
  const baseLoadPower = 200; // базов товар (всекидневни устройства)
  const daytimeLoadBonus = isDaytime ? 300 : 0; // повече консумация през деня
  const loadPower = baseLoadPower + daytimeLoadBonus;

  // Батериен капацитет: 10 kWh = 10000 Wh
  const BATTERY_CAPACITY_WH = 10000;
  
  // Изчисляваме промяната за интервал от 15 минути (0.25 часа)
  const timeIntervalHours = 0.25; // 15 минути = 0.25 часа
  
  // Нетна мощност (положителна = зареждане, отрицателна = разреждане)
  const netPowerW = solarPower - loadPower;
  
  // Енергийна промяна в Wh
  const energyDeltaWh = netPowerW * timeIntervalHours;
  
  // Нова енергия в батерията (Wh)
  const currentEnergyWh = (lastBatteryCharge / 100) * BATTERY_CAPACITY_WH;
  const newEnergyWh = Math.max(0, Math.min(BATTERY_CAPACITY_WH, currentEnergyWh + energyDeltaWh));
  
  // Нов заряд в проценти
  let newBatteryCharge = Math.round((newEnergyWh / BATTERY_CAPACITY_WH) * 100);
  
  // 🔹 ВАЖНО: Никога не позволявай да падне под 20% (реалистично)
  newBatteryCharge = Math.max(20, newBatteryCharge);

  // 4. Обща произведена енергия (симулирана)
  const energyWh = solarPower > 0 ? 
    Math.floor(2000 + Math.random() * 1000) : // Ден
    Math.floor(1800 + Math.random() * 500);   // Нощ

  // 5. Допълнителни реалистични данни
  const solarVoltage = 220 + Math.random() * 20;
  const batteryVoltage = 48 + Math.random() * 4;

  // 6. Запис в Firestore
  await db.collection("solarData").add({
    city,
    powerW: solarPower,
    energyWh: energyWh,
    batteryCharge: newBatteryCharge,
    solarVoltage: solarVoltage,
    batteryVoltage: batteryVoltage,
    loadPowerW: loadPower,
    cloudCover,
    isDaytime,
    hour: hour,
    timestamp: new Date()
  });

  console.log("🌤️ =================================");
  console.log(`🕒 Време: ${now.toLocaleTimeString('bg-BG')}`);
  console.log(`🌥️  Облачност: ${cloudCover}% (Слънчев фактор: ${sunFactor.toFixed(2)})`);
  console.log(`☀️  Соларна мощност: ${solarPower}W`);
  console.log(`💡 Консумация: ${loadPower}W`);
  console.log(`🔋 Батерия: ${lastBatteryCharge}% → ${newBatteryCharge}%`);
  console.log(`📊 Нетна мощност: ${netPowerW > 0 ? '+' : ''}${netPowerW}W`);
  console.log(`🌙 Ден/Нощ: ${isDaytime ? '☀️ Ден' : '🌙 Нощ'}`);
  console.log("✅ Данните са записани във Firestore");
}

runSimulation().catch(err => {
  console.error("❌ Simulation failed:", err);
  process.exit(1);
});
