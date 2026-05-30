using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Text;

public class SourceTextTests
{
    [Theory]
    [InlineData(".", 1)]
    [InlineData(".\r\n", 2)]
    [InlineData(".\r\n\r\n", 3)]
    public void SourceText_IncludesLastLine(string text, int expectedLineCount)
    {
        var sourceText = SourceText.From(text);
        Assert.Equal(expectedLineCount, sourceText.Lines.Length);
    }

    [Fact]
    public void SourceText_ToString_WithOutOfRangeBounds_DoesNotThrow()
    {
        var sourceText = SourceText.From("hello");

        Assert.Equal(string.Empty, sourceText.ToString(2, -33));
        Assert.Equal("llo", sourceText.ToString(2, 100));
        Assert.Equal(string.Empty, sourceText.ToString(100, 5));
        Assert.Equal(string.Empty, sourceText.ToString(-5, 0));
    }
}
