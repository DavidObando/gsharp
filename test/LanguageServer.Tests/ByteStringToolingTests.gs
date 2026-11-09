// <copyright file="ByteStringToolingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.IO
import System.Text
import Xunit

class ByteStringToolingTests {
    @Theory
    @InlineData("b", "GS0628")
    @InlineData("u8", "GS0632")
    func DiskDocumentsRejectRepairedBytesAndRefreshEncodingProvenance(prefix string, expectedDiagnosticId string) {
        let path = Path.GetTempFileName()
        try {
            let prefixBytes = Encoding.ASCII.GetBytes(prefix + "\"")
            let bytes = [prefixBytes.Length + 2]uint8
            for var i = 0; i < prefixBytes.Length; i++ {
                bytes[i] = prefixBytes[i]
            }
            bytes[prefixBytes.Length] = 0xFF
            bytes[prefixBytes.Length + 1] = 0x22
            File.WriteAllBytes(path, bytes)
            let project = ProjectState(path + ".gsproj")
            let invalid = project.AddFileFromDisk(path)!!
            Assert.Contains(
                invalid.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == expectedDiagnosticId
            )
            Assert.Same(invalid, project.AddFileFromDisk(path))
            let invalidBuffer = project.UpdateFile(path, invalid.Text.ToString())
            Assert.NotSame(invalid, invalidBuffer)
            Assert.Empty(invalidBuffer.Diagnostics)
            let reloadedInvalid = project.AddFileFromDisk(path)!!
            Assert.NotSame(invalidBuffer, reloadedInvalid)
            Assert.Contains(
                reloadedInvalid.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == expectedDiagnosticId
            )
            File.WriteAllText(path, "$prefix\"\uFFFD\"")
            let repaired = project.AddFileFromDisk(path)!!
            Assert.NotSame(reloadedInvalid, repaired)
            Assert.Empty(repaired.Diagnostics)
            Assert.Same(repaired, project.AddFileFromDisk(path))
            let buffer = project.UpdateFile(path, repaired.Text.ToString())
            Assert.Same(repaired, buffer)
            Assert.Empty(buffer.Diagnostics)

            let malformedSource = "let value = $prefix\"\\q\"\n"
            let malformedFirst = project.UpdateFile(path, malformedSource)
            Assert.Contains(
                malformedFirst.Diagnostics,
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == expectedDiagnosticId
            )
            let malformedCompilation = project.GetCompilation()
            let malformedSecond = project.UpdateFile(path, malformedSource)
            Assert.Same(malformedFirst, malformedSecond)
            Assert.Same(malformedCompilation, project.GetCompilation())
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
        Assert.Equal("bytestring", item.FilterText)
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
