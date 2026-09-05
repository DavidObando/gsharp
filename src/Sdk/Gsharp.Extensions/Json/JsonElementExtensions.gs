package Gsharp.Extensions.Json

import System
import System.Text.Json

/// Returns the named JSON string property when it is present and valid.
///
/// The receiver must be an object and `name` must identify a string value.
/// A non-object receiver, missing property, JSON `null`, or different value
/// kind returns `nil`.
///
/// ```gs
/// let name = root.GetStringOrNil("name")
/// ```
///
/// See also [GetGuidOrNil](cref:Gsharp.Extensions.Json.GetGuidOrNil),
/// [GetDateTimeOffsetOrNil](cref:Gsharp.Extensions.Json.GetDateTimeOffsetOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the decoded string value, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetStringOrNil(name string) string? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.String {
        return nil
    }
    return value.GetString()
}

/// Returns the named JSON string property parsed as a `Guid`.
///
/// The receiver must be an object and `name` must identify a string accepted
/// by `JsonElement.TryGetGuid`. Missing, non-string, and malformed values
/// return `nil`.
///
/// ```gs
/// let id = root.GetGuidOrNil("id")
/// ```
///
/// See also [GetStringOrNil](cref:Gsharp.Extensions.Json.GetStringOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the parsed `Guid`, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetGuidOrNil(name string) Guid? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.String {
        return nil
    }
    if !value.TryGetGuid(out var guid) {
        return nil
    }
    return guid
}

/// Returns the named JSON string property parsed as a `DateTimeOffset`.
///
/// The receiver must be an object and `name` must identify a timestamp string
/// accepted by `JsonElement.TryGetDateTimeOffset`. Missing, non-string, and
/// malformed values return `nil`.
///
/// ```gs
/// let createdAt = root.GetDateTimeOffsetOrNil("createdAt")
/// ```
///
/// See also [GetStringOrNil](cref:Gsharp.Extensions.Json.GetStringOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the parsed timestamp with its offset, or `nil` when unavailable or invalid.
func (element JsonElement) GetDateTimeOffsetOrNil(name string) DateTimeOffset? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.String {
        return nil
    }
    if !value.TryGetDateTimeOffset(out var timestamp) {
        return nil
    }
    return timestamp
}

/// Returns the named JSON string property decoded from Base64.
///
/// The receiver must be an object and `name` must identify a completely valid
/// Base64 string. Missing, non-string, and malformed values return `nil`.
///
/// ```gs
/// let payload = root.GetBytesFromBase64OrNil("payload")
/// ```
///
/// See also [GetStringOrNil](cref:Gsharp.Extensions.Json.GetStringOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the decoded byte slice, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetBytesFromBase64OrNil(name string)[]?uint8 {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.String {
        return nil
    }
    if !value.TryGetBytesFromBase64(out var bytes) {
        return nil
    }
    return bytes
}

/// Returns the named JSON number property as an `int32`.
///
/// The value must be an integer within the signed 32-bit range. Missing,
/// non-number, fractional, and out-of-range values return `nil`.
///
/// ```gs
/// let count = root.GetInt32OrNil("count")
/// ```
///
/// See also [GetInt64OrNil](cref:Gsharp.Extensions.Json.GetInt64OrNil),
/// [GetFloat64OrNil](cref:Gsharp.Extensions.Json.GetFloat64OrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the `int32` value, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetInt32OrNil(name string) int32? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Number {
        return nil
    }
    if !value.TryGetInt32(out var number) {
        return nil
    }
    return number
}

/// Returns the named JSON number property as an `int64`.
///
/// The value must be an integer within the signed 64-bit range. Missing,
/// non-number, fractional, and out-of-range values return `nil`.
///
/// ```gs
/// let total = root.GetInt64OrNil("total")
/// ```
///
/// See also [GetInt32OrNil](cref:Gsharp.Extensions.Json.GetInt32OrNil),
/// [GetDecimalOrNil](cref:Gsharp.Extensions.Json.GetDecimalOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the `int64` value, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetInt64OrNil(name string) int64? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Number {
        return nil
    }
    if !value.TryGetInt64(out var number) {
        return nil
    }
    return number
}

/// Returns the named JSON number property as a finite `float64`.
///
/// Missing and non-number values return `nil`. Values that fail conversion or
/// produce `NaN` or positive or negative infinity are also rejected.
///
/// ```gs
/// let ratio = root.GetFloat64OrNil("ratio")
/// ```
///
/// See also [GetDecimalOrNil](cref:Gsharp.Extensions.Json.GetDecimalOrNil),
/// [GetInt64OrNil](cref:Gsharp.Extensions.Json.GetInt64OrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the finite `float64` value, or `nil` when unavailable or invalid.
func (element JsonElement) GetFloat64OrNil(name string) float64? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Number {
        return nil
    }
    if !value.TryGetDouble(out var number) {
        return nil
    }
    if !float64.IsFinite(number) {
        return nil
    }
    return number
}

/// Returns the named JSON number property as a `decimal`.
///
/// Use this helper when base-10 precision matters. Missing, non-number, and
/// values outside the `decimal` range return `nil`.
///
/// ```gs
/// let price = root.GetDecimalOrNil("price")
/// ```
///
/// See also [GetFloat64OrNil](cref:Gsharp.Extensions.Json.GetFloat64OrNil),
/// [GetInt64OrNil](cref:Gsharp.Extensions.Json.GetInt64OrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the `decimal` value, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetDecimalOrNil(name string) decimal? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Number {
        return nil
    }
    if !value.TryGetDecimal(out var number) {
        return nil
    }
    return number
}

/// Returns the named JSON Boolean property.
///
/// Both JSON `true` and JSON `false` are valid results. A non-object receiver,
/// missing property, JSON `null`, or different value kind returns `nil`.
///
/// ```gs
/// let enabled = root.GetBoolOrNil("enabled")
/// ```
///
/// See also [GetStringOrNil](cref:Gsharp.Extensions.Json.GetStringOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the Boolean value, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetBoolOrNil(name string) bool? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False {
        return nil
    }
    return value.GetBoolean()
}

/// Returns the named JSON array property as a `JsonElement`.
///
/// A non-object receiver, missing property, JSON `null`, or different value
/// kind returns `nil`. The returned element remains backed by the receiver's
/// parent `JsonDocument` and must not outlive it.
///
/// ```gs
/// let items = root.GetArrayOrNil("items")
/// ```
///
/// See also [GetObjectOrNil](cref:Gsharp.Extensions.Json.GetObjectOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the array element, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetArrayOrNil(name string) JsonElement? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Array {
        return nil
    }
    return value
}

/// Returns the named nested JSON object property as a `JsonElement`.
///
/// A non-object receiver, missing property, JSON `null`, or different value
/// kind returns `nil`. The returned element remains backed by the receiver's
/// parent `JsonDocument` and must not outlive it.
///
/// ```gs
/// let config = root.GetObjectOrNil("config")
/// ```
///
/// See also [GetArrayOrNil](cref:Gsharp.Extensions.Json.GetArrayOrNil).
///
/// @param name the case-sensitive property name to read.
/// @returns the nested object, or `nil` when the property is unavailable or invalid.
func (element JsonElement) GetObjectOrNil(name string) JsonElement? {
    if element.ValueKind != JsonValueKind.Object {
        return nil
    }
    if !element.TryGetProperty(name, out var value) {
        return nil
    }
    if value.ValueKind != JsonValueKind.Object {
        return nil
    }
    return value
}
