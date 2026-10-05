// Validation and serialization for structured data embedded in
// `<script type="application/json">` blocks.
//
// JSON.stringify alone is unsafe here: it silently turns NaN/Infinity into
// null, invokes getters and toJSON, drops symbol keys and non-enumerable
// properties, and elides array holes. The caller needs an error that keeps
// evidence of the offending value instead. Serialized text also escapes "<",
// ">", U+2028 and U+2029 so the JSON document can never terminate the
// surrounding script element or break a script data parser state.

export const MAX_JSON_DEPTH = 16;

export class JsonDataError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "JsonDataError";
    this.reason = detail.reason ?? "INVALID_JSON_DATA";
    this.jsonPath = detail.path ?? "$";
    this.valueType = detail.valueType;
  }
}

function describePath(path) {
  if (path.length === 0) return "$";
  let out = "$";
  for (const key of path) {
    if (typeof key === "number") {
      out += `[${key}]`;
    } else if (/^[A-Za-z_$][\w$]*$/.test(key)) {
      out += `.${key}`;
    } else {
      out += `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

function failData(message, { reason, path, value }) {
  throw new JsonDataError(message, {
    reason,
    path: describePath(path),
    valueType: value === null ? "null" : typeof value,
  });
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkOwnProperties(value, path, { arrayLike }) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const indexKeys = arrayLike
    ? new Set(Array.from({ length: value.length }, (_, i) => String(i)))
    : null;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = descriptors[key];
    if (typeof key === "symbol") {
      failData(
        `JSON data at ${describePath(path)} has a symbol-keyed property; symbols are not representable in JSON`,
        { reason: "SYMBOL_PROPERTY", path: [...path, key.toString()], value },
      );
    }
    if (key === "toJSON") {
      failData(
        `JSON data at ${describePath(path)} defines a toJSON property; JSON.stringify would invoke it and rewrite the value`,
        { reason: "TOJSON_METHOD", path: [...path, key], value },
      );
    }
    if (descriptor.get || descriptor.set) {
      failData(
        `JSON data at ${describePath([...path, key])} is defined by a getter/setter; accessors are not allowed`,
        { reason: "ACCESSOR_PROPERTY", path: [...path, key], value },
      );
    }
    if (arrayLike) {
      if (key === "length") continue;
      if (!indexKeys.has(key)) {
        failData(
          `JSON data at ${describePath(path)} carries non-index property ${JSON.stringify(key)} on an array; it would not survive a JSON round trip`,
          { reason: "ARRAY_EXTRA_PROPERTY", path: [...path, key], value },
        );
      }
    } else if (!descriptor.enumerable) {
      failData(
        `JSON data at ${describePath([...path, key])} is a non-enumerable property; it would be silently dropped`,
        { reason: "NON_ENUMERABLE_PROPERTY", path: [...path, key], value },
      );
    }
  }
}

function validateJsonValue(value, path, seen, depth) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      failData(
        `JSON data at ${describePath(path)} is ${String(value)}, which is not a finite JSON number`,
        { reason: "NON_FINITE_NUMBER", path, value },
      );
    }
    return;
  }
  if (type !== "object") {
    failData(
      `JSON data at ${describePath(path)} has unsupported type ${type}`,
      { reason: "UNSUPPORTED_TYPE", path, value },
    );
  }

  if (seen.has(value)) {
    failData(`JSON data at ${describePath(path)} is part of a circular reference`, {
      reason: "CIRCULAR_REFERENCE",
      path,
      value,
    });
  }
  // Only containers increase nesting; allow container depths 0..MAX-1, i.e.
  // at most MAX_JSON_DEPTH nested objects/arrays including the root.
  if (depth >= MAX_JSON_DEPTH) {
    failData(
      `JSON data at ${describePath(path)} exceeds the ${MAX_JSON_DEPTH}-level nesting limit`,
      { reason: "DEPTH_EXCEEDED", path, value },
    );
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      checkOwnProperties(value, path, { arrayLike: true });
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          failData(
            `JSON data at ${describePath([...path, index])} is an array hole; sparse arrays are not allowed`,
            { reason: "ARRAY_HOLE", path: [...path, index], value },
          );
        }
        validateJsonValue(value[index], [...path, index], seen, depth + 1);
      }
    } else {
      if (!isPlainObject(value)) {
        const constructorName = value.constructor?.name ?? "Object";
        failData(
          `JSON data at ${describePath(path)} is a ${constructorName}, not a plain JSON object`,
          { reason: "NON_PLAIN_OBJECT", path, value },
        );
      }
      checkOwnProperties(value, path, { arrayLike: false });
      for (const key of Object.keys(value)) {
        validateJsonValue(value[key], [...path, key], seen, depth + 1);
      }
    }
  } finally {
    seen.delete(value);
  }
}

export function serializeJsonData(value) {
  validateJsonValue(value, [], new Set(), 0);
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new JsonDataError("value cannot be serialized to JSON", {
      reason: "UNSERIALIZABLE",
    });
  }
  if (typeof text !== "string") {
    failData("JSON serialization produced no output", {
      reason: "UNSERIALIZABLE",
      path: [],
      value,
    });
  }
  // Escape every "<" so "</script" (and script escaping sequences) cannot
  // appear literally, and line separators that are illegal in classic
  // scripts. JSON.parse decodes these escapes back to the original chars.
  return text.replace(/[<>\u2028\u2029]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });
}
