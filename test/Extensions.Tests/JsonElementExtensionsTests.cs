using System.Text.Json;
using Gsharp.Extensions.Json;
using Xunit;

namespace GSharp.Extensions.Tests;

public class JsonElementExtensionsTests
{
    [Fact]
    public void GetStringOrNil_StringProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse("{\"name\":\"alpha\"}");

        Assert.Equal(
            "alpha",
            document.RootElement.GetStringOrNil("name"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"name\":42}")]
    public void GetStringOrNil_InvalidShape_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetStringOrNil("name"));
    }

    [Fact]
    public void GetGuidOrNil_GuidProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse(
            "{\"id\":\"d85b1407-351d-4694-9392-03acc5870eb1\"}");

        Assert.Equal(
            Guid.Parse("d85b1407-351d-4694-9392-03acc5870eb1"),
            document.RootElement.GetGuidOrNil("id"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"id\":42}")]
    [InlineData("{\"id\":\"not-a-guid\"}")]
    public void GetGuidOrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetGuidOrNil("id"));
    }

    [Fact]
    public void GetDateTimeOffsetOrNil_TimestampProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse(
            "{\"createdAt\":\"2026-08-23T12:34:56-04:00\"}");

        Assert.Equal(
            new DateTimeOffset(
                2026, 8, 23, 12, 34, 56,
                TimeSpan.FromHours(-4)),
            document.RootElement.GetDateTimeOffsetOrNil("createdAt"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"createdAt\":42}")]
    [InlineData("{\"createdAt\":\"not-a-timestamp\"}")]
    public void GetDateTimeOffsetOrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetDateTimeOffsetOrNil("createdAt"));
    }

    [Fact]
    public void GetBytesFromBase64OrNil_Base64Property_ReturnsValue()
    {
        using var document = JsonDocument.Parse("{\"payload\":\"AQID\"}");

        Assert.Equal(
            new byte[] { 1, 2, 3 },
            document.RootElement.GetBytesFromBase64OrNil("payload"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"payload\":42}")]
    [InlineData("{\"payload\":\"not-base64***\"}")]
    public void GetBytesFromBase64OrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetBytesFromBase64OrNil("payload"));
    }

    [Fact]
    public void GetInt32OrNil_IntegerProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse("{\"count\":42}");

        Assert.Equal(
            42,
            document.RootElement.GetInt32OrNil("count"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"count\":\"42\"}")]
    [InlineData("{\"count\":1.5}")]
    public void GetInt32OrNil_InvalidShape_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetInt32OrNil("count"));
    }

    [Fact]
    public void GetInt64OrNil_LargeIntegerProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse(
            "{\"count\":5000000000}");

        Assert.Equal(
            5_000_000_000L,
            document.RootElement.GetInt64OrNil("count"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"count\":\"5000000000\"}")]
    [InlineData("{\"count\":9223372036854775808}")]
    public void GetInt64OrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetInt64OrNil("count"));
    }

    [Fact]
    public void GetFloat64OrNil_FractionalProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse(
            "{\"ratio\":12.5}");

        Assert.Equal(
            12.5,
            document.RootElement.GetFloat64OrNil("ratio"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"ratio\":\"12.5\"}")]
    [InlineData("{\"ratio\":1e400}")]
    public void GetFloat64OrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetFloat64OrNil("ratio"));
    }

    [Fact]
    public void GetDecimalOrNil_DecimalProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse("{\"price\":12.50}");

        Assert.Equal(
            12.50m,
            document.RootElement.GetDecimalOrNil("price"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"price\":\"12.50\"}")]
    [InlineData("{\"price\":1e400}")]
    public void GetDecimalOrNil_InvalidInput_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetDecimalOrNil("price"));
    }

    [Theory]
    [InlineData("{\"enabled\":true}", true)]
    [InlineData("{\"enabled\":false}", false)]
    public void GetBoolOrNil_BooleanProperty_ReturnsValue(string json, bool expected)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Equal(
            expected,
            document.RootElement.GetBoolOrNil("enabled"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"enabled\":1}")]
    public void GetBoolOrNil_InvalidShape_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetBoolOrNil("enabled"));
    }

    [Fact]
    public void GetArrayOrNil_ArrayProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse("{\"items\":[1,2]}");

        var array = document.RootElement.GetArrayOrNil("items");

        Assert.True(array.HasValue);
        Assert.Equal(2, array.Value.GetArrayLength());
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"items\":{}}")]
    public void GetArrayOrNil_InvalidShape_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetArrayOrNil("items"));
    }

    [Fact]
    public void GetObjectOrNil_ObjectProperty_ReturnsValue()
    {
        using var document = JsonDocument.Parse(
            "{\"config\":{\"name\":\"alpha\"}}");

        var value = document.RootElement.GetObjectOrNil("config");

        Assert.True(value.HasValue);
        Assert.Equal(
            "alpha",
            value.Value.GetProperty("name").GetString());
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"config\":[]}")]
    public void GetObjectOrNil_InvalidShape_ReturnsNull(string json)
    {
        using var document = JsonDocument.Parse(json);

        Assert.Null(document.RootElement.GetObjectOrNil("config"));
    }
}
