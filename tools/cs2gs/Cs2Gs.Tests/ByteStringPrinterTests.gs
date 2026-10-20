// <copyright file="ByteStringPrinterTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import Xunit

class ByteStringPrinterTests {
    @Fact
    func ByteLiteralsSnapshotInputsAndRoundTripEveryByte() {
        let bytes = [256]uint8
        for var i = 0; i < bytes.Length; i++ {
            bytes[i] = uint8(i)
        }
        let literal = LiteralExpression.Bytes(bytes)
        bytes[255] = 0
        let source = GSharpPrinter.RenderExpressionText(literal)
        let token = Assert.Single(SyntaxTree.ParseTokens(source, out var diagnostics))
        Assert.Empty(diagnostics)
        Assert.Equal(SyntaxKind.ByteStringToken, token.Kind)
        let recovered = cast[ImmutableArray[uint8]](token.Value!!)
        Assert.Equal(256, recovered.Length)
        for var i = 0; i < recovered.Length; i++ {
            Assert.Equal(uint8(i), recovered[i])
        }
        Assert.Equal("b\"a$$b\"", GSharpPrinter.RenderExpressionText(LiteralExpression.Bytes([]uint8{97, 36, 98})))
        Assert.Equal(
            "bytestring?",
            GSharpPrinter.RenderTypeReference(NamedTypeReference("bytestring"){IsNullable = true})
        )
        Assert.Equal("b\"\"", GSharpPrinter.RenderExpressionText(LiteralExpression.Bytes([]uint8{})))
    }
}
