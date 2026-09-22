/**
 * Client-ID der offiziellen Twitch-App „MinisStreamSuite“ (dev.twitch.tv/console).
 *
 * Die Suite meldet sich per Device Code Flow an – dafür braucht es nur diese ID, kein
 * Client-Secret. Eine Client-ID ist nicht geheim (Twitch zeigt sie z.B. beim Login an),
 * deshalb darf sie im Quellcode stehen. Damit muss niemand selbst eine Twitch-App anlegen.
 *
 * Wer die Suite forkt und unter eigenem Namen verteilt: bitte eine eigene Twitch-App
 * anlegen (Client-Typ „Öffentlich“) und hier deren Client-ID eintragen.
 * In der App kann jeder außerdem eine eigene Client-ID eintragen (Übersicht → Erweitert).
 */
export const BUNDLED_CLIENT_ID = 'blwmc4k4szse2r1b72d9nxcfsqhaxw';
