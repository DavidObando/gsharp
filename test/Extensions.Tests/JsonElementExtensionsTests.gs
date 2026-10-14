package GSharp.Extensions.Tests

import System.Text.Json
import Gsharp.Extensions.Json
import Xunit
import System

open class JsonElementExtensionsTests {
    @Fact
    func GetStringOrNil_StringProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"name\":\"alpha\"}")
        Assert.Equal("alpha", document.RootElement.GetStringOrNil("name"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"name\":42}")
    func GetStringOrNil_InvalidShape_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetStringOrNil("name"))
    }

    @Fact
    func GetGuidOrNil_GuidProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"id\":\"d85b1407-351d-4694-9392-03acc5870eb1\"}")
        Assert.Equal(Guid.Parse("d85b1407-351d-4694-9392-03acc5870eb1"), document.RootElement.GetGuidOrNil("id"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"id\":42}")
    @InlineData("{\"id\":\"not-a-guid\"}")
    func GetGuidOrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetGuidOrNil("id"))
    }

    @Fact
    func GetDateTimeOffsetOrNil_TimestampProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"createdAt\":\"2026-08-23T12:34:56-04:00\"}")
        Assert.Equal(
            DateTimeOffset(2026, 8, 23, 12, 34, 56, TimeSpan.FromHours(-4)),
            document.RootElement.GetDateTimeOffsetOrNil("createdAt")
        )
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"createdAt\":42}")
    @InlineData("{\"createdAt\":\"not-a-timestamp\"}")
    func GetDateTimeOffsetOrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetDateTimeOffsetOrNil("createdAt"))
    }

    @Fact
    func GetBytesFromBase64OrNil_Base64Property_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"payload\":\"AQID\"}")
        Assert.Equal([]uint8{1, 2, 3}, document.RootElement.GetBytesFromBase64OrNil("payload"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"payload\":42}")
    @InlineData("{\"payload\":\"not-base64***\"}")
    func GetBytesFromBase64OrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetBytesFromBase64OrNil("payload"))
    }

    @Fact
    func GetInt32OrNil_IntegerProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"count\":42}")
        Assert.Equal(42, document.RootElement.GetInt32OrNil("count"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"count\":\"42\"}")
    @InlineData("{\"count\":1.5}")
    func GetInt32OrNil_InvalidShape_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetInt32OrNil("count"))
    }

    @Fact
    func GetInt64OrNil_LargeIntegerProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"count\":5000000000}")
        Assert.Equal(5_000_000_000L, document.RootElement.GetInt64OrNil("count"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"count\":\"5000000000\"}")
    @InlineData("{\"count\":9223372036854775808}")
    func GetInt64OrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetInt64OrNil("count"))
    }

    @Fact
    func GetFloat64OrNil_FractionalProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"ratio\":12.5}")
        Assert.Equal(12.5, document.RootElement.GetFloat64OrNil("ratio"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"ratio\":\"12.5\"}")
    @InlineData("{\"ratio\":1e400}")
    func GetFloat64OrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetFloat64OrNil("ratio"))
    }

    @Fact
    func GetDecimalOrNil_DecimalProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"price\":12.50}")
        Assert.Equal(12.50m, document.RootElement.GetDecimalOrNil("price"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"price\":\"12.50\"}")
    @InlineData("{\"price\":1e400}")
    func GetDecimalOrNil_InvalidInput_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetDecimalOrNil("price"))
    }

    @Theory
    @InlineData("{\"enabled\":true}", true)
    @InlineData("{\"enabled\":false}", false)
    func GetBoolOrNil_BooleanProperty_ReturnsValue(json string, expected bool) {
        using let document = JsonDocument.Parse(json)
        Assert.Equal(expected, document.RootElement.GetBoolOrNil("enabled"))
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"enabled\":1}")
    func GetBoolOrNil_InvalidShape_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetBoolOrNil("enabled"))
    }

    @Fact
    func GetArrayOrNil_ArrayProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"items\":[1,2]}")
        let array = document.RootElement.GetArrayOrNil("items")
        Assert.True((array != nil))
        Assert.Equal(2, array!!.GetArrayLength())
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"items\":{}}")
    func GetArrayOrNil_InvalidShape_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetArrayOrNil("items"))
    }

    @Fact
    func GetObjectOrNil_ObjectProperty_ReturnsValue() {
        using let document = JsonDocument.Parse("{\"config\":{\"name\":\"alpha\"}}")
        let value = document.RootElement.GetObjectOrNil("config")
        Assert.True((value != nil))
        Assert.Equal("alpha", value!!.GetProperty("name").GetString())
    }

    @Theory
    @InlineData("[]")
    @InlineData("{}")
    @InlineData("{\"config\":[]}")
    func GetObjectOrNil_InvalidShape_ReturnsNull(json string) {
        using let document = JsonDocument.Parse(json)
        Assert.Null(document.RootElement.GetObjectOrNil("config"))
    }
}
