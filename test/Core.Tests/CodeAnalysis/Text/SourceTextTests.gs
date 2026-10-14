package GSharp.Core.Tests.CodeAnalysis.Text

import GSharp.Core.CodeAnalysis.Text
import Xunit

open class SourceTextTests {
    @Theory
    @InlineData(".", int32(1))
    @InlineData(".\r\n", int32(2))
    @InlineData(".\r\n\r\n", int32(3))
    func SourceText_IncludesLastLine(text string, expectedLineCount int32) {
        let sourceText = SourceText.From(text)
        Assert.Equal(expectedLineCount, sourceText.Lines.Length)
    }

    @Fact
    func SourceText_ToString_WithOutOfRangeBounds_DoesNotThrow() {
        let sourceText = SourceText.From("hello")
        Assert.Equal(string.Empty, sourceText.ToString(2, -33))
        Assert.Equal("llo", sourceText.ToString(2, 100))
        Assert.Equal(string.Empty, sourceText.ToString(100, 5))
        Assert.Equal(string.Empty, sourceText.ToString(-5, 0))
    }
}
