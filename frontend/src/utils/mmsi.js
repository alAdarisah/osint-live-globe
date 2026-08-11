// The MMSI's own structure, decoded far enough to name a flag state and no
// further. An MMSI is not one field shape: ITU-R M.585 defines six of them,
// and only one -- an ordinary ship station -- puts the Maritime
// Identification Digits (MID) in the first three digits. Coast stations,
// group ship calls, SAR aircraft, aids to navigation (AtoN) and craft
// associated with a parent ship all carry a MID too, but at a different
// offset and (for two of the six) inside a form that is shorter once it has
// been through a JSON number: a leading zero in "023456789" (a group ship
// call) or "003456789" (a coast station) does not survive being stored as a
// plain integer, which is exactly what aisstream and this project's own
// backend.sources.ais hand a ship's mmsi as. So an 8-digit or 7-digit MMSI
// here is not malformed -- it is a 9-digit identifier that already lost its
// leading zero(s) before this function ever sees it.
//
// The first digit(s) tell the six apart, because ITU never hands out a MID
// starting with 0, 1, 8 or 9 -- every real MID's first digit is 2-7 (the
// region digit: 2=Europe, 3=Americas, 4=Asia, 5=Oceania, 6=Africa,
// 7=South America). That is what makes the parsing below safe rather than a
// guess: a string starting "98" is never an ordinary ship's MID misread, it
// is unambiguously the "craft associated with a parent ship" form -- 98MIDxxxx,
// a *two*-digit prefix, the same shape as AtoN's 99MIDxxxx. A bare leading "8"
// with no second "9"/"8" ahead of it is a different, unrelated allocation
// (a handheld VHF transceiver with DSC and GNSS) whose own field layout this
// module does not implement, so it is left to fall through to "not
// identified" rather than be misread as the craft-associated form.
//
// Getting a form wrong would mean reading the wrong three digits as a MID
// and printing a flag for a country that never claimed this MMSI -- worse
// than printing nothing, which is why every branch below that cannot
// identify the form returns null instead of guessing.

// ITU Table of Maritime Identification Digits (Radio Regulations Appendix
// 43): the country or territory administration responsible for a ship
// station whose MMSI starts with this MID. Sourced from the ITU's own
// published MID/country pairs (cross-checked against a structured mirror at
// github.com/michaeljfazio/MIDs, itself built from the ITU table) rather than
// retyped from memory -- a wrong entry here is a wrong flag on a real ship,
// which is the one failure this module exists to avoid.
//
// Not every MID ITU has ever issued is listed. A code missing from this
// table reads as "unallocated" (flagForMmsi returns null), which is the
// honest answer for a MID this table doesn't yet cover -- not a reason to
// invent a country for it.
const MID_COUNTRY = {
  201: "Albania", 202: "Andorra", 203: "Austria", 204: "Azores (Portugal)",
  205: "Belgium", 206: "Belarus", 207: "Bulgaria", 208: "Vatican City State",
  209: "Cyprus", 210: "Cyprus", 211: "Germany", 212: "Cyprus", 213: "Georgia",
  214: "Moldova", 215: "Malta", 216: "Armenia", 218: "Germany", 219: "Denmark",
  220: "Denmark", 224: "Spain", 225: "Spain", 226: "France", 227: "France",
  228: "France", 229: "Malta", 230: "Finland", 231: "Faroe Islands",
  232: "United Kingdom", 233: "United Kingdom", 234: "United Kingdom",
  235: "United Kingdom", 236: "Gibraltar", 237: "Greece", 238: "Croatia",
  239: "Greece", 240: "Greece", 241: "Greece", 242: "Morocco", 243: "Hungary",
  244: "Netherlands", 245: "Netherlands", 246: "Netherlands", 247: "Italy",
  248: "Malta", 249: "Malta", 250: "Ireland", 251: "Iceland",
  252: "Liechtenstein", 253: "Luxembourg", 254: "Monaco", 255: "Madeira (Portugal)",
  256: "Malta", 257: "Norway", 258: "Norway", 259: "Norway", 261: "Poland",
  262: "Montenegro", 263: "Portugal", 264: "Romania", 265: "Sweden",
  266: "Sweden", 267: "Slovakia", 268: "San Marino", 269: "Switzerland",
  270: "Czech Republic", 271: "Turkey", 272: "Ukraine", 273: "Russia",
  274: "North Macedonia", 275: "Latvia", 276: "Estonia", 277: "Lithuania",
  278: "Slovenia", 279: "Serbia",

  301: "Anguilla", 303: "Alaska (USA)", 304: "Antigua and Barbuda",
  305: "Antigua and Barbuda", 306: "Curaçao / Sint Maarten (Netherlands)",
  307: "Aruba", 308: "Bahamas", 309: "Bahamas", 310: "Bermuda",
  311: "Bahamas", 312: "Belize", 314: "Barbados", 316: "Canada",
  319: "Cayman Islands", 321: "Costa Rica", 323: "Cuba", 325: "Dominica",
  327: "Dominican Republic", 329: "Guadeloupe (France)", 330: "Grenada",
  331: "Greenland (Denmark)", 332: "Guatemala", 334: "Honduras",
  336: "Haiti", 338: "United States of America", 339: "Jamaica",
  341: "Saint Kitts and Nevis", 343: "Saint Lucia", 345: "Mexico",
  347: "Martinique (France)", 348: "Montserrat", 350: "Nicaragua",
  351: "Panama", 352: "Panama", 353: "Panama", 354: "Panama", 355: "Panama",
  356: "Panama", 357: "Panama", 358: "Puerto Rico (USA)", 359: "El Salvador",
  361: "Saint Pierre and Miquelon (France)", 362: "Trinidad and Tobago",
  364: "Turks and Caicos Islands", 366: "United States of America",
  367: "United States of America", 368: "United States of America",
  369: "United States of America", 370: "Panama", 371: "Panama",
  372: "Panama", 373: "Panama", 374: "Panama", 375: "Saint Vincent and the Grenadines",
  376: "Saint Vincent and the Grenadines", 377: "Saint Vincent and the Grenadines",
  378: "British Virgin Islands", 379: "United States Virgin Islands",

  401: "Afghanistan", 403: "Saudi Arabia", 405: "Bangladesh", 408: "Bahrain",
  410: "Bhutan", 412: "China", 413: "China", 414: "China", 416: "Taiwan",
  417: "Sri Lanka", 419: "India", 422: "Iran", 423: "Azerbaijan",
  425: "Iraq", 428: "Israel", 431: "Japan", 432: "Japan", 434: "Turkmenistan",
  436: "Kazakhstan", 437: "Uzbekistan", 438: "Jordan", 440: "South Korea",
  441: "South Korea", 443: "State of Palestine", 445: "North Korea",
  447: "Kuwait", 450: "Lebanon", 451: "Kyrgyzstan", 453: "Macao",
  455: "Maldives", 457: "Mongolia", 459: "Nepal", 461: "Oman",
  463: "Pakistan", 466: "Qatar", 468: "Syria", 470: "United Arab Emirates",
  471: "United Arab Emirates", 472: "Tajikistan", 473: "Yemen", 475: "Yemen",
  477: "Hong Kong", 478: "Bosnia and Herzegovina",

  501: "Adélie Land (France)", 503: "Australia", 506: "Myanmar",
  508: "Brunei", 510: "Micronesia", 511: "Palau", 512: "New Zealand",
  514: "Cambodia", 515: "Cambodia", 516: "Christmas Island (Australia)",
  518: "Cook Islands", 520: "Fiji", 523: "Cocos (Keeling) Islands (Australia)",
  525: "Indonesia", 529: "Kiribati", 531: "Laos", 533: "Malaysia",
  536: "Northern Mariana Islands", 538: "Marshall Islands",
  540: "New Caledonia (France)", 542: "Niue", 544: "Nauru",
  546: "French Polynesia (France)", 548: "Philippines", 550: "Timor-Leste",
  553: "Papua New Guinea", 555: "Pitcairn Islands", 557: "Solomon Islands",
  559: "American Samoa", 561: "Samoa", 563: "Singapore", 564: "Singapore",
  565: "Singapore", 566: "Singapore", 567: "Thailand", 570: "Tonga",
  572: "Tuvalu", 574: "Vietnam", 576: "Vanuatu", 577: "Vanuatu",
  578: "Wallis and Futuna Islands (France)",

  601: "South Africa", 603: "Angola", 605: "Algeria",
  607: "Saint Paul and Amsterdam Islands (France)", 608: "Ascension Island (UK)",
  609: "Burundi", 610: "Benin", 611: "Botswana", 612: "Central African Republic",
  613: "Cameroon", 615: "Congo (Republic of the)", 616: "Comoros",
  617: "Cabo Verde", 618: "Crozet Archipelago (France)", 619: "Ivory Coast",
  620: "Comoros", 621: "Djibouti", 622: "Egypt", 624: "Ethiopia",
  625: "Eritrea", 626: "Gabon", 627: "Ghana", 629: "Gambia",
  630: "Guinea-Bissau", 631: "Equatorial Guinea", 632: "Guinea",
  633: "Burkina Faso", 634: "Kenya", 635: "Kerguelen Islands (France)",
  636: "Liberia", 637: "Liberia", 638: "South Sudan", 642: "Libya",
  644: "Lesotho", 645: "Mauritius", 647: "Madagascar", 649: "Mali",
  650: "Mozambique", 654: "Mauritania", 655: "Malawi", 656: "Niger",
  657: "Nigeria", 659: "Namibia", 660: "Réunion (France)", 661: "Rwanda",
  662: "Sudan", 663: "Senegal", 664: "Seychelles", 665: "Saint Helena (UK)",
  666: "Somalia", 667: "Sierra Leone", 668: "São Tomé and Príncipe",
  669: "Eswatini", 670: "Chad", 671: "Togo", 672: "Tunisia",
  674: "Tanzania", 675: "Uganda", 676: "Democratic Republic of the Congo",
  677: "Tanzania", 678: "Zambia", 679: "Zimbabwe",

  701: "Argentina", 710: "Brazil", 720: "Bolivia", 725: "Chile",
  730: "Colombia", 735: "Ecuador", 740: "Falkland Islands (UK)",
  745: "French Guiana (France)", 750: "Guyana", 755: "Paraguay",
  760: "Peru", 765: "Suriname", 770: "Uruguay", 775: "Venezuela",
};

/** True for the one digit range ITU actually hands MIDs out from. */
function looksLikeMid(threeDigits) {
  return /^[2-7]\d{2}$/.test(threeDigits);
}

/**
 * digits (a string of only 0-9) -> the 3-digit MID substring, or null if this
 * length/prefix combination isn't a form this function can place a MID in.
 *
 * Ordered most-specific prefix first ("111" before "1", "00" before "0", "99"
 * and "98" before a bare "8" or "9" get any chance to be misread as one of
 * them) so a SAR aircraft's "111" is never read as a group call's bare "1", a
 * coast station's "00" is never read as a group call's bare "0", and AtoN's
 * "99" / craft-associated's "98" are never read as the unrelated bare-"8"
 * handheld allocation this module doesn't implement.
 */
function midDigitsFor(digits) {
  const len = digits.length;
  if (len === 9) {
    if (digits.startsWith("111")) return digits.slice(3, 6); // SAR aircraft: 111MIDXXX
    if (digits.startsWith("00")) return digits.slice(2, 5);  // coast station: 00MIDXXXX
    if (digits.startsWith("0")) return digits.slice(1, 4);   // group ship call: 0MIDXXXXX
    if (digits.startsWith("99")) return digits.slice(2, 5);  // AtoN: 99MIDXXXX
    if (digits.startsWith("98")) return digits.slice(2, 5);  // craft assoc. with parent ship: 98MIDXXXX
    if (looksLikeMid(digits.slice(0, 3))) return digits.slice(0, 3); // ordinary ship station: MIDXXXXXX
    // Reserved or out-of-scope prefixes: bare "1" other than "111", bare "9"
    // other than "98"/"99", and bare "8" (a handheld VHF transceiver's own
    // allocation, whose field layout this module does not implement -- see
    // the header comment). Guessing a form here is exactly the failure mode
    // this function exists to avoid, so all of these return null.
    return null;
  }
  if (len === 8) {
    // A group ship call (0MIDXXXXX) that lost its leading zero to JSON's
    // number type. Only identifiable as one if what's left still starts with
    // a real MID digit -- otherwise this is just a short, malformed number.
    return looksLikeMid(digits.slice(0, 3)) ? digits.slice(0, 3) : null;
  }
  if (len === 7) {
    // A coast station (00MIDXXXX) that lost both leading zeros the same way.
    return looksLikeMid(digits.slice(0, 3)) ? digits.slice(0, 3) : null;
  }
  return null; // not a length AIS/ITU-R M.585 actually produces
}

/** mmsi (number or string) -> a string of digits, or null if it isn't one. */
function digitsOf(mmsi) {
  if (typeof mmsi === "number") {
    if (!Number.isFinite(mmsi) || !Number.isInteger(mmsi) || mmsi < 0) return null;
    return String(mmsi);
  }
  if (typeof mmsi === "string") {
    const trimmed = mmsi.trim();
    // Deliberately allows leading zeros here (unlike the number branch, which
    // structurally cannot have any): a caller that already has the true
    // zero-padded form of a coast station or group call gets it read
    // correctly, rather than only ever seeing the lossy integer form.
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

/**
 * The flag state an MMSI's MID points to, or null.
 *
 * Null covers three different situations and doesn't try to tell them apart
 * in the return value: the input isn't a number/digit-string at all, it's a
 * length ITU-R M.585 doesn't define, or it's a length/prefix ITU-R M.585
 * does define but the MID inside it isn't in MID_COUNTRY (unallocated, or
 * allocated after this table was last updated). All three are "don't know" --
 * and this map's rule is that "don't know" prints nothing, not a guess.
 */
export function flagForMmsi(mmsi) {
  const digits = digitsOf(mmsi);
  if (!digits) return null;
  const mid = midDigitsFor(digits);
  if (!mid) return null;
  const country = MID_COUNTRY[Number(mid)];
  return country ? { mid, country } : null;
}
