// Which of the ITU's call sign series a callsign belongs to, and the country
// (or, for a handful of series, the organisation) it was allocated to -- the
// "callsign prefix grouping" the vessel filter bar offers (Task 18).
//
// This is a different ITU table from the one frontend/src/utils/mmsi.js
// carries, and neither is derived from the other. mmsi.js reads the Maritime
// Identification Digits buried inside an MMSI -- three digits, at an offset
// that depends on which of six MMSI forms is in play, used by exactly one
// radio service. This module reads the call sign itself -- free text a crew
// types in -- against ITU Radio Regulations Appendix 42, the Table of
// International Call Sign Series, which every radio service (maritime,
// aeronautical, amateur, broadcast) draws its prefixes from alike. A country
// appearing in both tables (most do) still gets two independent entries, one
// per table, because the two numbers/letters mean different things and
// happen to share no structure to reuse.
//
// Sourced from the ITU's own published allocation table, via its structured
// mirror at the Wikipedia article "ITU prefix" (itself built from ITU RR
// Appendix 42) -- not retyped from memory. A callsign whose leading
// characters fall outside every series below resolves to null, the honest
// answer for a series this table doesn't cover or a string that isn't a real
// callsign at all -- never a guess.
//
// A few rows are not countries: C7 (World Meteorological Organization), 4U
// (United Nations), 4Y (ICAO). They are kept rather than pruned to "real
// countries only" -- that is what the ITU itself allocated those series to,
// and quietly dropping real rows from a source table is exactly the kind of
// invented-by-omission this project's provenance rule warns against.
//
// The first pass through this table (an AI-summarised read of the article)
// dropped two rows: a smaller territory's own carve-out nested *inside* a
// larger country's block, which a plain "list every prefix range" pass has
// no reason to notice is two rows rather than one. B is China's block, but
// BM-BQ and BU-BX inside it are Taiwan's; HB is Switzerland's, but HB0,
// HB3Y and HBL inside it are Liechtenstein's. Both were caught by re-pulling
// the article's raw wikitext (github.com/... mirrors of ITU RR Appendix 42
// agree) and diffing every one of its ~230 rows against this table, rather
// than the spot-check of a dozen entries the first pass shipped with -- the
// spot check had no way to catch an omission, only a wrong entry. The two
// carve-outs sit as their own rows below, immediately after the block they
// nest inside, and are ordered ahead of it by parseSeries/PARSED_SERIES'
// longest-commonPrefix-first sort (see there) precisely so a Taiwanese or
// Liechtenstein callsign resolves to the carve-out and not the country
// wrapped around it.
//
// Each row is [series, name]. `series` is either an exact prefix ("A2", "B")
// or a range over one shared trailing position ("AA-AL", "SSA-SSM") -- see
// parseSeries for how the two shapes are told apart and reduced to the same
// three numbers.
const CALLSIGN_SERIES = [
  ["AA-AL", "United States"], ["AM-AO", "Spain"], ["AP-AS", "Pakistan"],
  ["AT-AW", "India"], ["AX", "Australia"], ["AY-AZ", "Argentina"],
  ["A2", "Botswana"], ["A3", "Tonga"], ["A4", "Oman"], ["A5", "Bhutan"],
  ["A6", "United Arab Emirates"], ["A7", "Qatar"], ["A8", "Liberia"], ["A9", "Bahrain"],
  ["B", "China"],
  // Taiwan's carve-out inside China's B block -- see the header note above.
  ["BM-BQ", "Taiwan"], ["BU-BX", "Taiwan"],
  ["CA-CE", "Chile"], ["CF-CK", "Canada"], ["CL-CM", "Cuba"], ["CN", "Morocco"],
  ["CO", "Cuba"], ["CP", "Bolivia"], ["CQ-CU", "Portugal"], ["CV-CX", "Uruguay"],
  ["CY-CZ", "Canada"], ["C2", "Nauru"], ["C3", "Andorra"], ["C4", "Cyprus"],
  ["C5", "The Gambia"], ["C6", "The Bahamas"], ["C7", "World Meteorological Organization"],
  ["C8-C9", "Mozambique"],
  ["DA-DR", "Germany"], ["DS-DT", "South Korea"], ["DU-DZ", "Philippines"],
  ["D2-D3", "Angola"], ["D4", "Cape Verde"], ["D5", "Liberia"], ["D6", "Comoros"],
  ["D7-D9", "South Korea"],
  ["EA-EH", "Spain"], ["EI-EJ", "Ireland"], ["EK", "Armenia"], ["EL", "Liberia"],
  ["EM-EO", "Ukraine"], ["EP-EQ", "Iran"], ["ER", "Moldova"], ["ES", "Estonia"],
  ["ET", "Ethiopia"], ["EU-EW", "Belarus"], ["EX", "Kyrgyzstan"], ["EY", "Tajikistan"],
  ["EZ", "Turkmenistan"], ["E2", "Thailand"], ["E3", "Eritrea"],
  ["E4", "Palestinian Authority"], ["E5", "Cook Islands"], ["E6", "Niue"],
  ["E7", "Bosnia and Herzegovina"],
  ["F", "France"],
  ["G", "United Kingdom"],
  ["HA", "Hungary"], ["HB", "Switzerland"],
  // Liechtenstein's carve-out inside Switzerland's HB block -- see the
  // header note above. Three specific series, not a contiguous range.
  ["HB0", "Liechtenstein"], ["HB3Y", "Liechtenstein"], ["HBL", "Liechtenstein"],
  ["HC-HD", "Ecuador"], ["HE", "Switzerland"],
  ["HF", "Poland"], ["HG", "Hungary"], ["HH", "Haiti"], ["HI", "Dominican Republic"],
  ["HJ-HK", "Colombia"], ["HL", "South Korea"], ["HM", "North Korea"], ["HN", "Iraq"],
  ["HO-HP", "Panama"], ["HQ-HR", "Honduras"], ["HS", "Thailand"], ["HT", "Nicaragua"],
  ["HU", "El Salvador"], ["HV", "Vatican City"], ["HW-HY", "France"], ["HZ", "Saudi Arabia"],
  ["H2", "Cyprus"], ["H3", "Panama"], ["H4", "Solomon Islands"], ["H6-H7", "Nicaragua"],
  ["H8-H9", "Panama"],
  ["I", "Italy"],
  ["JA-JS", "Japan"], ["JT-JV", "Mongolia"], ["JW-JX", "Norway"], ["JY", "Jordan"],
  ["JZ", "Indonesia"], ["J2", "Djibouti"], ["J3", "Grenada"], ["J4", "Greece"],
  ["J5", "Guinea-Bissau"], ["J6", "Saint Lucia"], ["J7", "Dominica"],
  ["J8", "Saint Vincent and the Grenadines"],
  ["K", "United States"],
  ["LA-LN", "Norway"], ["LO-LW", "Argentina"], ["LX", "Luxembourg"], ["LY", "Lithuania"],
  ["LZ", "Bulgaria"], ["L2-L9", "Argentina"],
  ["M", "United Kingdom"],
  ["N", "United States"],
  ["OA-OC", "Peru"], ["OD", "Lebanon"], ["OE", "Austria"], ["OF-OJ", "Finland"],
  ["OK-OL", "Czech Republic"], ["OM", "Slovakia"], ["ON-OT", "Belgium"], ["OU-OZ", "Denmark"],
  ["PA-PI", "Netherlands"], ["PJ", "Netherlands Antilles"], ["PK-PO", "Indonesia"],
  ["PP-PY", "Brazil"], ["PZ", "Suriname"], ["P2", "Papua New Guinea"], ["P3", "Cyprus"],
  ["P4", "Aruba"], ["P5-P9", "North Korea"],
  ["R", "Russia"],
  ["SA-SM", "Sweden"], ["SN-SR", "Poland"], ["SSA-SSM", "Egypt"], ["SSN-SSZ", "Sudan"],
  ["SU", "Egypt"], ["SV-SZ", "Greece"], ["S2-S3", "Bangladesh"], ["S5", "Slovenia"],
  ["S6", "Singapore"], ["S7", "Seychelles"], ["S8", "South Africa"],
  ["S9", "São Tomé and Príncipe"],
  ["TA-TC", "Turkey"], ["TD", "Guatemala"], ["TE", "Costa Rica"], ["TF", "Iceland"],
  ["TG", "Guatemala"], ["TH", "France"], ["TI", "Costa Rica"], ["TJ", "Cameroon"],
  ["TK", "France"], ["TL", "Central African Republic"], ["TM", "France"],
  ["TN", "Republic of the Congo"], ["TO-TQ", "France"], ["TR", "Gabon"], ["TS", "Tunisia"],
  ["TT", "Chad"], ["TU", "Ivory Coast"], ["TV-TX", "France"], ["TY", "Benin"],
  ["TZ", "Mali"], ["T2", "Tuvalu"], ["T3", "Kiribati"], ["T4", "Cuba"], ["T5", "Somalia"],
  ["T6", "Afghanistan"], ["T7", "San Marino"], ["T8", "Palau"],
  ["UA-UI", "Russia"], ["UJ-UM", "Uzbekistan"], ["UN-UQ", "Kazakhstan"], ["UR-UZ", "Ukraine"],
  ["VA-VG", "Canada"], ["VH-VN", "Australia"], ["VO", "Canada"], ["VP-VQ", "United Kingdom"],
  ["VR", "Hong Kong"], ["VS", "United Kingdom"], ["VT-VW", "India"], ["VX-VY", "Canada"],
  ["VZ", "Australia"], ["V2", "Antigua and Barbuda"], ["V3", "Belize"],
  ["V4", "Saint Kitts and Nevis"], ["V5", "Namibia"], ["V6", "Federated States of Micronesia"],
  ["V7", "Marshall Islands"], ["V8", "Brunei"],
  ["W", "United States"],
  ["XA-XI", "Mexico"], ["XJ-XO", "Canada"], ["XP", "Denmark"], ["XQ-XR", "Chile"],
  ["XS", "China"], ["XT", "Burkina Faso"], ["XU", "Cambodia"], ["XV", "Vietnam"],
  ["XW", "Laos"], ["XX", "Macao"], ["XY-XZ", "Myanmar"],
  ["YA", "Afghanistan"], ["YB-YH", "Indonesia"], ["YI", "Iraq"], ["YJ", "Vanuatu"],
  ["YK", "Syria"], ["YL", "Latvia"], ["YM", "Turkey"], ["YN", "Nicaragua"],
  ["YO-YR", "Romania"], ["YS", "El Salvador"], ["YT-YU", "Serbia"], ["YV-YY", "Venezuela"],
  ["Y2-Y9", "Germany"],
  ["ZA", "Albania"], ["ZB-ZJ", "United Kingdom"], ["ZK-ZM", "New Zealand"],
  ["ZN-ZO", "United Kingdom"], ["ZP", "Paraguay"], ["ZQ", "United Kingdom"],
  ["ZR-ZU", "South Africa"], ["ZV-ZZ", "Brazil"], ["Z2", "Zimbabwe"],
  ["Z3", "North Macedonia"], ["Z8", "South Sudan"],
  ["2", "United Kingdom"],
  ["3A", "Monaco"], ["3B", "Mauritius"], ["3C", "Equatorial Guinea"],
  ["3DA-3DM", "Eswatini"], ["3DN-3DZ", "Fiji"], ["3E-3F", "Panama"], ["3G", "Chile"],
  ["3H-3U", "China"], ["3V", "Tunisia"], ["3W", "Vietnam"], ["3X", "Guinea"],
  ["3Y", "Norway"], ["3Z", "Poland"],
  ["4A-4C", "Mexico"], ["4D-4I", "Philippines"], ["4J-4K", "Azerbaijan"], ["4L", "Georgia"],
  ["4M", "Venezuela"], ["4O", "Montenegro"], ["4P-4S", "Sri Lanka"], ["4T", "Peru"],
  ["4U", "United Nations"], ["4V", "Haiti"], ["4W", "Timor-Leste"], ["4X", "Israel"],
  ["4Y", "International Civil Aviation Organization"], ["4Z", "Israel"],
  ["5A", "Libya"], ["5B", "Cyprus"], ["5C-5G", "Morocco"], ["5H-5I", "Tanzania"],
  ["5J-5K", "Colombia"], ["5L-5M", "Liberia"], ["5N-5O", "Nigeria"], ["5P-5Q", "Denmark"],
  ["5R-5S", "Madagascar"], ["5T", "Mauritania"], ["5U", "Niger"], ["5V", "Togo"],
  ["5W", "Western Samoa"], ["5X", "Uganda"], ["5Y-5Z", "Kenya"],
  ["6A-6B", "Egypt"], ["6C", "Syria"], ["6D-6J", "Mexico"], ["6K-6N", "South Korea"],
  ["6O", "Somalia"], ["6P-6S", "Pakistan"], ["6T-6U", "Sudan"], ["6V-6W", "Senegal"],
  ["6X", "Madagascar"], ["6Y", "Jamaica"], ["6Z", "Liberia"],
  ["7A-7I", "Indonesia"], ["7J-7N", "Japan"], ["7O", "Yemen"], ["7P", "Lesotho"],
  ["7Q", "Malawi"], ["7R", "Algeria"], ["7S", "Sweden"], ["7T-7Y", "Algeria"],
  ["7Z", "Saudi Arabia"],
  ["8A-8I", "Indonesia"], ["8J-8N", "Japan"], ["8O", "Botswana"], ["8P", "Barbados"],
  ["8Q", "Maldives"], ["8R", "Guyana"], ["8S", "Sweden"], ["8T-8Y", "India"],
  ["8Z", "Saudi Arabia"],
  ["9A", "Croatia"], ["9B-9D", "Iran"], ["9E-9F", "Ethiopia"], ["9G", "Ghana"],
  ["9H", "Malta"], ["9I-9J", "Zambia"], ["9K", "Kuwait"], ["9L", "Sierra Leone"],
  ["9M", "Malaysia"], ["9N", "Nepal"], ["9O-9T", "Democratic Republic of the Congo"],
  ["9U", "Burundi"], ["9V", "Singapore"], ["9W", "Malaysia"], ["9X", "Rwanda"],
  ["9Y-9Z", "Trinidad and Tobago"],
];

/**
 * A [series, name] row -> {commonPrefix, lo, hi}: a callsign C matches when
 * C.startsWith(commonPrefix) and C[commonPrefix.length] is between lo and hi
 * inclusive. Both shapes a row can take reduce to the same three values -- an
 * exact prefix ("A2") is just a range whose lo and hi are the same character,
 * and a multi-character range ("SSA-SSM") differs from a single-character one
 * ("AA-AL") only in how long the fixed part in front of it is.
 */
function parseSeries(series) {
  const dash = series.indexOf("-");
  if (dash === -1) {
    return { commonPrefix: series.slice(0, -1), lo: series.at(-1), hi: series.at(-1) };
  }
  const left = series.slice(0, dash);
  const right = series.slice(dash + 1);
  return { commonPrefix: left.slice(0, -1), lo: left.at(-1), hi: right.at(-1) };
}

// Parsed once at module load, and sorted longest-commonPrefix-first so a
// multi-character series (SSA-SSM) is always tried before any shorter series
// sharing its lead-in (S*) could shadow it. The real ITU table is a
// partition -- no callsign is meant to fall in two series at once -- so this
// ordering is a defensive belt on top of that rather than something the
// answer depends on, the same spirit as mmsi.js's own "most specific first".
const PARSED_SERIES = CALLSIGN_SERIES
  .map(([series, name]) => ({ ...parseSeries(series), name }))
  .sort((a, b) => b.commonPrefix.length - a.commonPrefix.length);

/**
 * The country (or, for the handful of series ITU gave to an organisation
 * rather than a state, the organisation) a callsign's prefix was allocated
 * to, or null if no series in the table covers it.
 *
 * Punctuation a caller's free-text query might still be carrying (a trailing
 * "*", stray spaces) is stripped before matching, so this can be called
 * directly on whatever the vessel filter box currently holds, not just on a
 * clean stored callsign field.
 */
export function countryForCallsign(callsign) {
  if (typeof callsign !== "string" && typeof callsign !== "number") return null;
  const cs = String(callsign).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cs) return null;
  for (const { commonPrefix, lo, hi, name } of PARSED_SERIES) {
    if (!cs.startsWith(commonPrefix)) continue;
    const c = cs[commonPrefix.length];
    if (c === undefined) continue;
    if (c >= lo && c <= hi) return name;
  }
  return null;
}
