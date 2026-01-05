import admin from "firebase-admin";
import fetch from "node-fetch";

// Константи за системата
const BATTERY_VOLTAGE = 48; // V
const BATTERY_AH = 350; // Ah
const BATTERY_CAPACITY_WH = BATTERY_VOLTAGE * BATTERY_AH; // = 16800 Wh
const MAX_SOLAR_POWER = 1000; // W
const LOAD_POWER = 300; // W (постоянен товар)
const SIMULATION_INTERVAL_HOURS = 0.25; // 15 минути

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

  // 2. Соларна мощност според времето и час на деня
  const now = new Date();
  const hour = now.getHours();
  const isDaytime = hour >= 6 && hour <= 19;
  
  let solarPower = 0;
  
  if (isDaytime) {
    solarPower = Math.floor(MAX_SOLAR_POWER * sunFactor);
  } else {
    solarPower = 0; // Няма слънчева енергия през нощта
  }
  
  // 3. Коректна батерийна логика (Wh вместо %)
  let lastEnergyWh = BATTERY_CAPACITY_WH * 0.75; // default 75% от капацитета
  
  try {
    const lastDocSnapshot = await db.collection("solarData").orderBy("timestamp", "desc").limit(1).get();
    if (!lastDocSnapshot.empty) {
      const lastData = lastDocSnapshot.docs[0].data();
      
      // Четем или запазената енергия или конвертираме от % в Wh
      if (lastData.batteryEnergyWh !== undefined) {
        lastEnergyWh = lastData.batteryEnergyWh;
      } else if (lastData.batteryCharge !== undefined) {
        // Миграция: ако имаме само %, конвертираме
        lastEnergyWh = (lastData.batteryCharge / 100) * BATTERY_CAPACITY_WH;
      }
    }
  } catch (error) {
    console.warn(`⚠️ Error reading last data: ${error.message}`);
  }

  // Изчисляване на новата енергия в батерията
  const netPower = solarPower - LOAD_POWER; // W
  const energyDelta = netPower * SIMULATION_INTERVAL_HOURS; // Wh
  
  let newEnergyWh = lastEnergyWh + energyDelta;
  
  // Клампване между 0 и максималния капацитет
  newEnergyWh = Math.max(0, Math.min(BATTERY_CAPACITY_WH, newEnergyWh));
  
  const batteryPercent = (newEnergyWh / BATTERY_CAPACITY_WH) * 100;
  
  // 4. Изчисляване на общата произведена енергия за деня
  let totalEnergyToday = 0;
  
  try {
    // Намираме записа за началото на деня
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    
    const todayData = await db.collection("solarData")
      .where("timestamp", ">=", admin.firestore.Timestamp.fromDate(startOfDay))
      .get();
    
    // Сумираме всички енергии за деня
    todayData.forEach(doc => {
      const data = doc.data();
      if (data.energyPeriodWh) {
        totalEnergyToday += data.energyPeriodWh;
      }
    });
    
    // Добавяме текущата енергия
    totalEnergyToday += solarPower * SIMULATION_INTERVAL_HOURS;
    
  } catch (error) {
    console.warn(`⚠️ Error calculating today's energy: ${error.message}`);
    // Ако няма данни, използваме само текущата
    totalEnergyToday = solarPower * SIMULATION_INTERVAL_HOURS;
  }

  // 5. Запис в Firestore
  await db.collection("solarData").add({
    city: "Plovdiv",
    
    // МОЩНОСТ И ЕНЕРГИЯ
    powerW: solarPower,
    energyPeriodWh: solarPower * SIMULATION_INTERVAL_HOURS, // Енергия за този период
    totalEnergyTodayWh: totalEnergyToday, // Обща енергия за деня
    
    // БАТЕРИЯ
    batteryEnergyWh: newEnergyWh, // Реална енергия в Wh
    batteryCharge: Math.round(batteryPercent), // Процент за backwards compatibility
    batteryCapacityWh: BATTERY_CAPACITY_WH, // За справка
    
    // ПАРАМЕТРИ
    cloudCover,
    isDaytime,
    hour,
    netPowerW: netPower, // За отчитане на баланса
    
    // ТИМСТАМП
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log("✅ Simulation completed, data saved to Firestore");
  console.log(`📊 Stats: ${solarPower}W solar, ${Math.round(batteryPercent)}% battery, ${cloudCover}% clouds`);
  console.log(`🔋 Battery: ${Math.round(newEnergyWh)}/${BATTERY_CAPACITY_WH} Wh`);
  console.log(`📅 Today's energy: ${(totalEnergyToday / 1000).toFixed(2)} kWh`);
  console.log(`🌙 Daytime: ${isDaytime} (Hour: ${hour})`);
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
    1066: 80,  // Patchy snow possible
    1069: 70,  // Patchy sleet possible
    1072: 60,  // Patchy freezing drizzle possible
    1087: 80,  // Thundery outbreaks possible
    1114: 90,  // Blowing snow
    1117: 100, // Blizzard
    1135: 100, // Fog
    1147: 100, // Freezing fog
    1150: 50,  // Patchy light drizzle
    1153: 60,  // Light drizzle
    1168: 70,  // Freezing drizzle
    1171: 80,  // Heavy freezing drizzle
    1180: 60,  // Patchy light rain
    1183: 70,  // Light rain
    1186: 80,  // Moderate rain
    1189: 90,  // Heavy rain
    1192: 100, // Torrential rain shower
    1195: 100, // Heavy rain
    1198: 80,  // Light freezing rain
    1201: 90,  // Moderate or heavy freezing rain
    1204: 70,  // Light sleet
    1207: 80,  // Moderate or heavy sleet
    1210: 60,  // Patchy light snow
    1213: 70,  // Light snow
    1216: 80,  // Moderate snow
    1219: 90,  // Heavy snow
    1222: 100, // Patchy heavy snow
    1225: 100, // Heavy snow
    1237: 90,  // Ice pellets
    1240: 60,  // Light rain shower
    1243: 80,  // Moderate or heavy rain shower
    1246: 100, // Torrential rain shower
    1249: 70,  // Light sleet showers
    1252: 90,  // Moderate or heavy sleet showers
    1255: 70,  // Light snow showers
    1258: 90,  // Moderate or heavy snow showers
    1261: 80,  // Light showers of ice pellets
    1264: 100, // Moderate or heavy showers of ice pellets
    1273: 80,  // Patchy light rain with thunder
    1276: 100, // Moderate or heavy rain with thunder
    1279: 90,  // Patchy light snow with thunder
    1282: 100  // Moderate or heavy snow with thunder
  };
  
  return cloudMap[conditionCode] || 50; // Default 50% ако не разпознаем
}

// Fallback симулация без API
async function runFallbackSimulation(db) {
  console.log("🔄 Running fallback simulation (no weather API)");
  
  const now = new Date();
  const hour = now.getHours();
  const isDaytime = hour >= 6 && hour <= 19;
  
  // Симулация без API
  let solarPower = 0;
  if (isDaytime) {
    solarPower = Math.floor(500 + Math.random() * 400); // 500-900W през ден
  } else {
    solarPower = 0; // Няма слънчева енергия през нощта
  }
  
  let lastEnergyWh = BATTERY_CAPACITY_WH * 0.75;
  
  try {
    const lastDocSnapshot = await db.collection("solarData").orderBy("timestamp", "desc").limit(1).get();
    if (!lastDocSnapshot.empty) {
      const lastData = lastDocSnapshot.docs[0].data();
      if (lastData.batteryEnergyWh !== undefined) {
        lastEnergyWh = lastData.batteryEnergyWh;
      } else if (lastData.batteryCharge !== undefined) {
        lastEnergyWh = (lastData.batteryCharge / 100) * BATTERY_CAPACITY_WH;
      }
    }
  } catch (error) {
    console.warn(`⚠️ Error reading last data: ${error.message}`);
  }

  const netPower = solarPower - LOAD_POWER;
  const energyDelta = netPower * SIMULATION_INTERVAL_HOURS;
  let newEnergyWh = lastEnergyWh + energyDelta;
  newEnergyWh = Math.max(0, Math.min(BATTERY_CAPACITY_WH, newEnergyWh));
  
  const batteryPercent = (newEnergyWh / BATTERY_CAPACITY_WH) * 100;
  
  // Изчисляване на дневна енергия
  let totalEnergyToday = 0;
  
  try {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    
    const todayData = await db.collection("solarData")
      .where("timestamp", ">=", admin.firestore.Timestamp.fromDate(startOfDay))
      .get();
    
    todayData.forEach(doc => {
      const data = doc.data();
      if (data.energyPeriodWh) {
        totalEnergyToday += data.energyPeriodWh;
      }
    });
    
    totalEnergyToday += solarPower * SIMULATION_INTERVAL_HOURS;
    
  } catch (error) {
    console.warn(`⚠️ Error calculating today's energy: ${error.message}`);
    totalEnergyToday = solarPower * SIMULATION_INTERVAL_HOURS;
  }

  await db.collection("solarData").add({
    city: "Plovdiv",
    powerW: solarPower,
    energyPeriodWh: solarPower * SIMULATION_INTERVAL_HOURS,
    totalEnergyTodayWh: totalEnergyToday,
    batteryEnergyWh: newEnergyWh,
    batteryCharge: Math.round(batteryPercent),
    batteryCapacityWh: BATTERY_CAPACITY_WH,
    cloudCover: isDaytime ? 40 : 80,
    isDaytime: isDaytime,
    hour: hour,
    netPowerW: netPower,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`✅ Fallback simulation: ${solarPower}W, ${Math.round(batteryPercent)}% battery`);
  console.log(`🔋 Battery: ${Math.round(newEnergyWh)}/${BATTERY_CAPACITY_WH} Wh`);
  console.log(`📅 Today's energy: ${(totalEnergyToday / 1000).toFixed(2)} kWh`);
}

runSimulation().catch(err => {
  console.error("❌ Simulation failed:", err);
  process.exit(1);
});
