import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderTemplate, promptHelp, availableVariables, daypart, conditionsFor, resetWeatherCache, contextFor } from "../../lib/drop-template.js";
import { sanitizeStation, type Station } from "../../lib/station-profile.js";
import { buildSystemPrompt } from "../../lib/formats.js";

const station: Station = {
  id: "krap", name: "KRAP", callsign: "KRAP", frequency: "97.7 FM", tagline: "Houston's underground", city: "Houston", tz: "America/Chicago",
  genres: [], links: [], skipArtists: [], connection: { kind: "none" }, lat: 29.76, lon: -95.37, variables: { sponsor: "Joe's Pizza" },
};
// Tuesday 21 Oct 2026, 20:45 UTC = 3:45 PM in Chicago (CDT)
const NOW = new Date("2026-10-21T20:45:00Z");
const ctx = (extra: object = {}) => contextFor({ station, now: NOW, ...extra });
const fetchMock = vi.fn();

beforeEach(() => { resetWeatherCache(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("time, date and station variables", () => {
  it("fills in the station's local time and date", async () => {
    const out = await renderTemplate("{{greeting}}! It's {{time}} on {{date}}, a {{daypart}} on {{callsign}} {{frequency}}.", ctx());
    expect(out.text).toBe("Good afternoon! It's 3:45 PM on Wednesday, October 21, a afternoon on KRAP 97.7 FM.".replace("Wednesday", "Wednesday"));
    expect(out.missing).toEqual([]);
  });

  it("uses the station's time zone, not the server's", async () => {
    const tokyo = { ...station, tz: "Asia/Tokyo" };
    expect((await renderTemplate("{{time}} {{weekday}}", contextFor({ station: tokyo, now: NOW }))).text).toBe("5:45 AM Thursday");
    expect((await renderTemplate("{{hour}} {{time_24}}", ctx())).text).toBe("3 15:45");
  });

  it("names the parts of the day", () => {
    expect([5, 11, 12, 16, 17, 20, 21, 4].map(daypart)).toEqual(["morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
  });

  it("is case-insensitive about names", async () => {
    expect((await renderTemplate("{{ STATION }} / {{Time}}", ctx())).text).toBe("KRAP / 3:45 PM");
  });
});

describe("fallbacks, choices and missing values", () => {
  it("uses a fallback only when there is no value, and removes unknown placeholders", async () => {
    const out = await renderTemplate("Hi {{dj|friends}}, call {{hotline|the studio}} or {{nonsense}}.", ctx());
    expect(out.text).toBe("Hi friends, call the studio or.");
    expect(out.missing).toEqual(["nonsense"]);
  });

  it("picks one choice, using the random source", async () => {
    const pick = (r: number) => renderTemplate("{{pick: Stay tuned | Don't go anywhere | More after this}}", ctx({ rng: () => r }));
    expect((await pick(0)).text).toBe("Stay tuned");
    expect((await pick(0.5)).text).toBe("Don't go anywhere");
    expect((await pick(0.99)).text).toBe("More after this");
  });

  it("never lets braces through, even when malformed", async () => {
    const out = await renderTemplate("Oops {{ and }} and {{time", ctx());
    expect(out.text).not.toMatch(/[{}]/);
  });

  it("leaves single-brace persona placeholders and plain text alone", async () => {
    expect((await renderTemplate("Next: {artist} - {title}", ctx())).text).toBe("Next: {artist} - {title}");
    expect(await renderTemplate("No placeholders.", ctx())).toEqual({ text: "No placeholders.", used: [], missing: [] });
  });
});

describe("DJ, song, length and station variables", () => {
  it("fills the DJ, song and length from the context", async () => {
    const out = await renderTemplate("{{dj}} here. That was {{title}} by {{artist}}. {{target_seconds}}s, about {{target_words}} words. Thanks to {{sponsor}}.",
      ctx({ persona: { name: "DJ Midnight" }, song: { artist: "Ada", title: "Analytical Love" }, targetSeconds: 10 }));
    expect(out.text).toBe("DJ Midnight here. That was Analytical Love by Ada. 10s, about 25 words. Thanks to Joe's Pizza.");
  });

  it("does not let a station variable replace a built-in one", () => {
    const clean = sanitizeStation({ name: "X", variables: "time=never\nsponsor=Joe\nBad Name=x\nlocal_ad=Buy now" });
    expect("station" in clean && clean.station.variables).toEqual({ sponsor: "Joe", local_ad: "Buy now" });
  });
});

describe("weather", () => {
  const forecast = () => fetchMock.mockResolvedValue(new Response(JSON.stringify({ current: { temperature_2m: 16.7, weather_code: 3 } })));

  it("fills in temperature and sky from the station's location, in its unit", async () => {
    forecast();
    expect((await renderTemplate("It's {{weather}}. {{temp}} and {{conditions}}.", ctx())).text).toBe("It's 62 degrees and overcast. 62 degrees and overcast.");
    expect(String(fetchMock.mock.calls[0][0])).toContain("latitude=29.76");
    expect((await renderTemplate("{{temp}}", contextFor({ station: { ...station, tempUnit: "C" }, now: NOW }))).text).toBe("17 degrees");
  });

  it("asks only when a placeholder needs it, and once per few minutes", async () => {
    forecast();
    await renderTemplate("{{time}}", ctx());
    expect(fetchMock).not.toHaveBeenCalled();
    await renderTemplate("{{weather}}", ctx());
    await renderTemplate("{{weather}}", ctx());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back, or drops the placeholder, when the weather is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await renderTemplate("Out there it's {{weather|nice}}.", ctx())).text).toBe("Out there it's nice.");
    resetWeatherCache();
    const out = await renderTemplate("Weather: {{weather}}.", ctx());
    expect(out).toMatchObject({ text: "Weather:.", missing: ["weather"] });
  });

  it("looks up the city when there are no coordinates", async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(String(url).includes("geocoding") ? { results: [{ latitude: 1.5, longitude: 2.5 }] } : { current: { temperature_2m: 0, weather_code: 0 } })));
    const noCoords: Station = { ...station, lat: undefined, lon: undefined };
    expect((await renderTemplate("{{conditions}}", contextFor({ station: noCoords, now: NOW }))).text).toBe("clear");
    expect(String(fetchMock.mock.calls[0][0])).toContain("name=Houston");
    expect(String(fetchMock.mock.calls[1][0])).toContain("latitude=1.5");
  });

  it("maps weather codes to plain words", () => {
    expect([0, 2, 3, 45, 61, 73, 95].map(conditionsFor)).toEqual(["clear", "partly cloudy", "overcast", "foggy", "rainy", "snowy", "stormy"]);
  });
});

describe("telling the writer", () => {
  it("lists only the placeholders this context can fill, and says not to invent values", () => {
    const names = availableVariables(ctx()).map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(["time", "weather", "callsign", "sponsor"]));
    expect(names).not.toContain("dj");                                          // no persona
    expect(names).not.toContain("artist");
    const noLocation = availableVariables(contextFor({ station: { ...station, lat: undefined, lon: undefined, city: undefined }, now: NOW })).map((v) => v.name);
    expect(noLocation).not.toContain("weather");
    const help = promptHelp(ctx());
    expect(help).toMatch(/never guess or invent the time/);
    expect(help).toMatch(/\{\{pick: first \| second \| third\}\}/);
    expect(help).toMatch(/\{\{time\}\} \(the current local time/);
  });

  it("goes into the writing prompt with the length target", () => {
    const prompt = buildSystemPrompt({ station: "KRAP", placeholders: promptHelp(ctx()), targetSeconds: 10 });
    expect(prompt).toMatch(/Placeholders:/);
    expect(prompt).toMatch(/about 10 seconds when spoken, roughly 25 words/);
    expect(buildSystemPrompt({ station: "KRAP" })).not.toMatch(/Placeholders|Length:/);
  });
});
