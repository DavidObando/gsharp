// <copyright file="Issue6177ImportedConstructorTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6177 (item 1): the call of an imported constructor answers the constructor that overload
/// resolution chose, as the call of a source `init` does.
open class Issue6177ImportedConstructorTests {
    @Theory
    @InlineData("StringBuilder(16)", "StringBuilder", "System.Text.StringBuilder", "Int32")
    @InlineData("StringBuilder(\"a\")", "StringBuilder", "System.Text.StringBuilder", "String")
    @InlineData("StringBuilder()", "StringBuilder", "System.Text.StringBuilder", "")
    @InlineData("System.Text.StringBuilder(\"a\")", "StringBuilder", "System.Text.StringBuilder", "String") // qualified
    @InlineData("List[int32](4)", "List", "System.Collections.Generic.List[int32]", "Int32") // generic
    func CallOfAnImportedConstructor_AnswersTheChosenConstructor(
        expression string,
        name string,
        type string,
        parameterTypes string
    ) {
        let source = "package P\n\nimport System.Text\nimport System.Collections.Generic\n\nfunc F() {\n    let v = " +
            expression +
            "\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6177.gs"))
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GetDiagnostics())
        let model = compilation.GetSemanticModel(tree)
        let call = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == name)
        let constructor = Assert.IsType[ImportedConstructorSymbol](model.GetSymbolInfo(call).Symbol)
        Assert.Equal(SymbolKind.ImportedConstructor, constructor.Kind)
        Assert.Equal(".ctor", constructor.Name)
        Assert.Equal(type, constructor.Type.ToString())
        Assert.Equal(type, constructor.ContainingType?.ToString())
        Assert.Equal(
            parameterTypes,
            string.Join(
                ",",
                constructor
                    .Constructor
                    .GetParameters()
                    .Select((p System.Reflection.ParameterInfo) -> p.ParameterType.Name)
            )
        )
        // A qualified construction answers on the whole accessor too.
        if call.Parent is AccessorExpressionSyntax accessor {
            let outer = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().First()
            Assert.Equal(
                constructor.Constructor,
                Assert.IsType[ImportedConstructorSymbol](model.GetSymbolInfo(outer).Symbol).Constructor
            )
        }
    }
}
