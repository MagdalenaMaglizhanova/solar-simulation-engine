import admin from "firebase-admin";
import fetch from "node-fetch";

async function runSimulation() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();

  // 🔹 ДЕБЪГ: Проверка на API ключа
  console.log("API Key exists:", !!process.env.WEATHER_API_KEY);
  
  if (!process.env.WEATHER_API_KEY) {
    console.error("❌ Missing WEATHER_API_KEY in environment variables!");
    // Можеш да продължиш със симулация без API
    return runFallbackSimulation(db);
  }

  let cloudCover = 0;
  let sunFactor = 1;
  
  try {
    // 1. Вземаме данни от времето
    const city = "Plovdiv";
    const weatherRes = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${city}`);
    
    // 🔹 ДЕБЪГ: Проверка на статуса
    console.log("API Status:", weatherRes.status, weatherRes.statusText);
    
    if (!weatherRes.ok) {
      throw new Error(`API returned ${weatherRes.status}: ${weatherRes.statusText}`);
    }
    
    const weatherData = await weatherRes.json();
    
    // 🔹 ДЕБЪГ: Виж пълния отговор
    console.log("Full API Response structure:", Object.keys(weatherData));
    if (weatherData.current) {
      console.log("Current data keys:", Object.keys(weatherData.current));
    }
    
    // 🔹 ПРАВИЛНО ИЗВЛИЧАНЕ НА ОБЛАЧНОСТТА
    // Пробвай различни варианти, тъй като API може да се е променил
    if (weatherData.current.cloud !== undefined) {
      cloudCover = weatherData.current.cloud;
    } else if (weatherData.current.condition && weatherData.current.condition.code) {
      // Ако има condition код, превърни го в облачност
      const conditionCode = weatherData.current.condition.code;
      cloudCover = estimateCloudCoverFromCondition(conditionCode);
    } else {
      // Fallback
      cloudCover = 30;
      console.warn("⚠️ Could not find cloud data, using fallback 30%");
    }
    
    sunFactor = (100 - cloudCover) / 100;
    
    console.log(`✅ Weather data: ${cloudCover}% cloud cover, sun factor: ${sunFactor}`);

  } catch (error) {
    console.error(`❌ Error fetching weather: ${error.message}`);
    // Fallback стойности
    cloudCover = 30;
    sunFactor = 0.7;
  }

  // 2. Соларна мощност според времето
  const maxSolarPower = 1000; // W за целия панел
  const solarPower = Math.floor(maxSolarPower * sunFactor);

  // 3. Симулираме батерията
  let lastBatteryCharge = 75; // default 75% (по-реалистично)
  
  try {
    const lastDocSnapshot = await db.collection("solarData").orderBy("timestamp", "desc").limit(1).get();
    if (!lastDocSnapshot.empty) {
      lastBatteryCharge = lastDocSnapshot.docs[0].data().batteryCharge || 75;
    }
  } catch (error) {
    console.warn(`⚠️ Error reading last data: ${error.message}`);
  }

  const loadPower = 300; // текущо включени уреди W
  
  // 🔹 КОРИГИРАНО: Промяна на батерията за 15 минути (0.25 часа)
  const batteryDelta = (solarPower - loadPower) * 0.25; // Wh за 15 минути
  let newBatteryCharge = Math.min(100, Math.max(20, lastBatteryCharge + batteryDelta));

  // 4. Запис в Firestore
  await db.collection("solarData").add({
    city: "Plovdiv",
    powerW: solarPower,
    energyWh: solarPower * 0.25, // Произведена енергия за 15 минути
    batteryCharge: newBatteryCharge,
    cloudCover,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log("✅ Simulation completed, data saved to Firestore");
  console.log(`📊 Stats: ${solarPower}W solar, ${newBatteryCharge}% battery, ${cloudCover}% clouds`);
}

// Помощна функция за превръщане на condition код в облачност
function estimateCloudCoverFromCondition(conditionCode) {
  // Примерни стойности според weatherapi.com condition codes
  const cloudMap = {
    1000: 0,   // Sunny
    1003: 30,  // Partly cloudy
    1006: 70,  // Cloudy
    1009: 90,  // Overcast
    1030: 40,  // Mist
    1063: 50,  // Patchy rain possible
    // Добави повече кодове според нуждите
  };
  
  return cloudMap[conditionCode] || 50; // Default 50% ако не разпознаем
}

// Fallback симулация без API
async function runFallbackSimulation(db) {
  console.log("🔄 Running fallback simulation (no weather API)");
  
  const now = new Date();
  const hour = now.getHours();
  const isDaytime = hour >= 6 && hour <= 20;
  
  // Симулация без API
  const solarPower = isDaytime ? 
    Math.floor(500 + Math.random() * 400) : // 500-900W през ден
    Math.floor(Math.random() * 100);       // 0-100W нощем
  
  let lastBatteryCharge = 75;
  
  try {
    const lastDocSnapshot = await db.collection("solarData").orderBy("timestamp", "desc").limit(1).get();
    if (!lastDocSnapshot.empty) {
      lastBatteryCharge = lastDocSnapshot.docs[0].data().batteryCharge || 75;
    }
  } catch (error) {
    console.warn(`⚠️ Error reading last data: ${error.message}`);
  }

  const loadPower = 300;
  const batteryDelta = (solarPower - loadPower) * 0.25;
  let newBatteryCharge = Math.min(100, Math.max(20, lastBatteryCharge + batteryDelta));

  await db.collection("solarData").add({
    city: "Plovdiv",
    powerW: solarPower,
    energyWh: solarPower * 0.25,
    batteryCharge: newBatteryCharge,
    cloudCover: isDaytime ? 40 : 80,
    isDaytime: isDaytime,
    hour: hour,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`✅ Fallback simulation: ${solarPower}W, ${newBatteryCharge}% battery`);
}

runSimulation().catch(err => {
  console.error("❌ Simulation failed:", err);
  process.exit(1);
});
