// <copyright file="Adr0213ImportedOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import SourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import System
import System.Linq
import Xunit

/// ADR-0213 L1 (#5459): the CLR resolver can select an imported overload with omitted optional parameters, so a loop
/// whose call can bind it through a conversion operator removes a by-reference fact, as on main.
open class Adr0213ImportedOverloadTests {
    private const LibrarySource string = `namespace OptLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void Use(object o) { }
    public void Use(Payload p, int extra = 0) { }
}`

    private const ParamsLibrarySource string = `namespace ParamsLib;
public struct Token { public int Raw; }
public struct Payload {
    public int Raw;
    public static implicit operator Payload(Token t) => new Payload { Raw = t.Raw };
}
public class S {
    public void Use(params Payload[] values) { }
}`

    @Fact
    func ImportedParamsOverloadInExpandedForm_RemovesAByReferenceFact() {
        let source = `package T
import System
import ParamsLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(tok)
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(ParamsLibrarySource, assemblyName: "ParamsLib")
        let errors = GsCompilation(fixture.RuntimeReferences(), GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }

    @Fact
    func ImportedOptionalOverloadWithAConversion_RemovesAByReferenceFact() {
        let source = `package T
import System
import OptLib
func Run(ref text string?, s S, tok Token) int32 {
    if text == nil { return 0 }
    var n = 0
    while text.Length > 0 && n < 3 {
        n++
        s.Use(tok)
    }
    return n
}
func Main() { }`
        using let fixture = CSharpFixture(LibrarySource, assemblyName: "OptLib")
        let errors = GsCompilation(fixture.RuntimeReferences(), GsSyntaxTree.Parse(SourceText.From(source)))
            .BoundProgram
            .Diagnostics
            .Where((diagnostic GsDiagnostic) -> diagnostic.IsError)
            .Select((d GsDiagnostic) -> "${d.Id}@${d.Location.StartLine + 1}:${d.Location.StartCharacter + 1}")
            .ToArray()
        Assert.Equal("GS0158@7:16", string.Join(" ", errors))
    }
}
