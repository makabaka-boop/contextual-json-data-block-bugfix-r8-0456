import { fail } from "./errors.js";

const MAX_JSON_DEPTH = 16;
const OBJECT_PROTOTYPE = Object.prototype;
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

function failJson(message) {
  fail(message, { code: "INVALID_JSON_DATA" });
}

// Validates the value graph before serializing so that unsupported values are
// rejected with their original shape intact, rather than silently rewritten by
// JSON.stringify (NaN -> null, undefined dropped, getters invoked, ...).
function validateJson(value, depth, seen, path) {
  if (value === null) return;
  const type = typeof value;
  switch (type) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value))
        failJson(
          `JSON data at ${path.join(".") || "<root>"} is not a finite number`,
        );
      return;
    case "bigint":
      failJson("JSON data cannot contain bigint values");
      return;
    case "undefined":
      failJson("JSON data cannot contain undefined values");
      return;
    case "function":
      failJson("JSON data cannot contain functions");
      return;
    case "symbol":
      failJson("JSON data cannot contain symbol values");
      return;
    default:
      break;
  }

  if (seen.includes(value))
    failJson("JSON data contains a circular reference");

  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH)
      failJson(`JSON data is nested deeper than ${MAX_JSON_DEPTH} levels`);
    seen.push(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !("value" in descriptor))
        failJson(`JSON array has a hole or accessor at index ${index}`);
      validateJson(descriptor.value, depth + 1, seen, [...path, index]);
    }
    for (const key of Object.keys(value)) {
      if (/^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
        continue;
      failJson(`JSON arrays cannot carry extra property ${key}`);
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)
        failJson("JSON arrays cannot carry symbol properties");
    }
    seen.pop();
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null)
    failJson(
      "JSON objects must be plain objects (no class instances, dates, maps, ...)",
    );

  if (depth >= MAX_JSON_DEPTH)
    failJson(`JSON data is nested deeper than ${MAX_JSON_DEPTH} levels`);
  seen.push(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)
      failJson("JSON objects cannot contain symbol-keyed properties");
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && ("get" in descriptor || "set" in descriptor))
      failJson(`JSON property ${key} is an accessor, not a data property`);
    validateJson(descriptor?.value, depth + 1, seen, [...path, key]);
  }
  seen.pop();
}

// Serializes validated data while keeping every value's JSON type intact.
// "<" is emitted as a unicode escape so a literal "</script" inside a string
// cannot terminate the surrounding data block; U+2028/U+2029 are escaped for
// the same structural-safety reason. JSON.parse restores the original values.
export function serializeJsonData(value) {
  validateJson(value, 0, [], []);
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    failJson(`JSON data cannot be serialized: ${error.message}`);
  }
  if (json === undefined)
    failJson("JSON data must be one complete serializable value");
  return json
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
