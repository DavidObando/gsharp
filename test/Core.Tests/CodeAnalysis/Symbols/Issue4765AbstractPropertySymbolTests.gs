// <copyright file="Issue4765AbstractPropertySymbolTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

class Issue4765AbstractPropertySymbolTests {
    @Fact
    func InvalidExplicitContractIsLocatedAtItsPropertyName() {
        const source = "package PropertySymbols\nclass Owner { public abstract prop Value int32 { get; set; } }"
        let compilation = Compilation(SyntaxTree.Parse(source))
        let diagnostic = Assert.Single(
            EmittedOracle.CompileDiagnostics(compilation),
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0620"
        )
        Assert.Equal("Value", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    @Theory
    @InlineData("get;", false)
    @InlineData("get; set;", false)
    @InlineData("get; init;", true)
    func ExplicitContractAndGenericLookupCarryAbstractAccessorSymbolsWithoutStorage(accessors string, init bool) {
        let compilation = Compilation(SyntaxTree.Parse((`package PropertySymbols
abstract class Base[T] { public abstract prop Value T { ` + "$accessors" + ` } }
abstract class Retained : Base[int32] { }`)))
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        let definition = Assert.Single(compilation.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Base")
        let constructed = StructSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.True(TypeMemberModel.TryGetProperty(constructed, "Value", out var property))
        Assert.Same(TypeSymbol.Int32, property.Type)
        Assert.True(property.IsAbstract)
        Assert.True(property.IsVirtual)
        Assert.False(property.IsAutoProperty)
        Assert.Null(property.BackingField)
        Assert.NotNull(property.GetterSymbol)
        Assert.True(property.GetterSymbol!!.IsAbstract)
        Assert.Same(Assert.Single(definition.Properties), property.GetterSymbol!!.AssociatedSymbol)
        Assert.Null(property.GetterBodySyntax)
        Assert.Equal(init, property.IsInitOnly)
        if property.HasSetter {
            Assert.NotNull(property.SetterSymbol)
            Assert.True(property.SetterSymbol!!.IsAbstract)
            Assert.Equal(init, property.SetterSymbol!!.IsInitOnlySetter)
            Assert.Null(property.SetterBodySyntax)
        } else {
            Assert.Null(property.SetterSymbol)
        }
    }
}
