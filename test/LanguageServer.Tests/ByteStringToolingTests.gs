// <copyright file="ByteStringToolingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.IO
import Xunit

class ByteStringToolingTests {
    @Fact
    func DiskDocumentsRejectRepairedBytesAndRefreshEncodingProvenance() {
        let path = Path.GetTempFileName()
        try {
            let bytes = []uint8{0x62, 0x22, 0xFF, 0x22}
            File.WriteAllBytes(path, bytes)
            let project = ProjectState(path + ".gsproj")
            let invalid = project.AddFileFromDisk(path)!!
            Assert.Contains(
                invalid.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0628"
            )
            Assert.Same(invalid, project.AddFileFromDisk(path))
            File.WriteAllText(path, "b\"\uFFFD\"")
            let repaired = project.AddFileFromDisk(path)!!
            Assert.NotSame(invalid, repaired)
            Assert.Empty(repaired.Diagnostics)
            Assert.Same(repaired, project.AddFileFromDisk(path))
            let buffer = project.UpdateFile(path, repaired.Text.ToString())
            Assert.NotSame(repaired, buffer)
            Assert.Empty(buffer.Diagnostics)
        } finally {
            File.Delete(path)
        }
    }

    @Fact
    func NativeTypeCompletionAndLiteralHoverAreByteOriented() {
        const source = "func use(value ) { }\n"
        let items = CompletionComputer.ComputeCompletions(LanguageServerTestHelpers.Content(source), Position(0, 15))
        let item = Assert.Single(items, (item CompletionItem) -> item.Label == "bytestring")
        Assert.Equal("bytestring", item.InsertText)
        const literal = "let bytes = b\"\\xFF$$literal\"\n"
        let hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(literal),
            LanguageServerTestHelpers.PositionOf(literal, "b\"")
        )
        Assert.NotNull(hover)
        Assert.Contains("(bytestring)", hover!!.Contents.ToString())
        Assert.Contains("\\xFF", hover!!.Contents.ToString())
    }
}
