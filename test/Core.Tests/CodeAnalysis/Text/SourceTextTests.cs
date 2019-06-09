namespace GSharp.Core.Tests.CodeAnalysis.Text
{
    using GSharp.Core.CodeAnalysis.Text;
    using Xunit;

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
    }
}
