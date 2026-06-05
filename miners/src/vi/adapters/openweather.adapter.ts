import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "openweather",
  source_type: "web",
  description: "OpenWeather current conditions + forecast",
  default_schedule: "0 */3 * * *",
  webhook_enabled: false,
  auth: { type: "api_key", key_env: "OPENWEATHER_API_KEY", required: true },

  async extract(input) {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) throw new Error("OPENWEATHER_API_KEY not set");

    const city = input.config?.city || "Los Angeles";
    const resp = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=imperial`
    );
    const data: any = await resp.json();
    const text = `Weather in ${city}: ${data.weather[0].description}, ${data.main.temp}°F, ` +
      `humidity ${data.main.humidity}%, wind ${data.wind.speed}mph. ` +
      `High ${data.main.temp_max}°F, low ${data.main.temp_min}°F.`;

    return {
      title: `Weather: ${city} ${new Date().toISOString().slice(0, 10)}`,
      source_id: `openweather:${city}:${new Date().toISOString().slice(0, 13)}`,
      chunks: [{ content: text, chunk_index: 0, chunk_total: 1 }],
    };
  },
};
