package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import Xunit

class Utf8StringToolingTests {
    @Fact
    func LiteralHoverNamesTheReadonlyByteSpanRatherThanTextOrOwnedBytes() {
        const source = `let value = u8"\xFF$name"`
        let hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "u8\"")
        )
        Assert.NotNull(hover)
        Assert.Contains("(readonly span[byte])", hover!!.Contents.ToString())
        Assert.Contains("\\xFF", hover!!.Contents.ToString())
    }
}
