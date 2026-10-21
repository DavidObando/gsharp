package GSharp.Core.Tests.CodeAnalysis.Text

import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Text
import Xunit

open class SourceTextTests {
    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    @InlineData(int32(4))
    func LoadPreservesOneBomSelectedSourceSnapshot(kind int32) {
        let encoding Encoding = switch kind {
            case 0: UTF8Encoding(true)
            case 1: UnicodeEncoding(false, true)
            case 2: UnicodeEncoding(true, true)
            case 3: UTF32Encoding(false, true)
            default: UTF32Encoding(true, true)
        }
        const text = "let value = b\"\u00E9\"\n"
        let bytes = encoding.GetPreamble().Concat(encoding.GetBytes(text)).ToArray()
        let path = Path.Combine(Environment.CurrentDirectory, "source-snapshot-" + Guid.NewGuid().ToString("N") + ".gs")
        File.WriteAllBytes(path, bytes)
        try {
            let source = SourceText.Load(path)
            File.WriteAllText(path, "replacement")
            Assert.Equal(text, source.ToString())
            Assert.Equal(path, source.FileName)
            Assert.Equal(bytes, source.RawBytes)
        } finally {
            File.Delete(path)
        }
    }

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
