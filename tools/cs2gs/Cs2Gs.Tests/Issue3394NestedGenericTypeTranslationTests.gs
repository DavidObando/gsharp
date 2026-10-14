// <copyright file="Issue3394NestedGenericTypeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3394: nested metadata types retain type arguments carried by their
/// constructed containing type.
open class Issue3394NestedGenericTypeTranslationTests {
    @Fact
    func ImmutableArrayBuilder_PreservesContainingElementType() {
        const source = `using System.Collections.Immutable;

namespace Demo
{
    public class Item { }

    public static class C
    {
        public static int Count(ImmutableArray<Item>.Builder builder) =>
            builder.Count;
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("builder ImmutableArray[Item].Builder", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ImmutableArrayBuilder_RetainsContainingElementType() {
        const source = `
#nullable enable
using System.Collections.Immutable;
namespace Demo
{
    public class C
    {
        public int Count(ImmutableArray<int>.Builder? builder) => builder?.Count ?? 0;
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("ImmutableArray[int32].Builder?", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NullablePromotedNestedGenericLocal_RetainsContainingType() {
        const source = `#nullable enable
using System.Collections.Immutable;

namespace Demo
{
    public class C
    {
        public void M()
        {
            var builder = ImmutableArray.CreateBuilder<int>();
            builder = null;
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("builder ImmutableArray[int32].Builder?", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NamedTuplePropertyPattern_UsesPositionalMember() {
        const source = `#nullable enable

namespace Demo
{
    public static class C
    {
        public static bool HasValue((int Id, string? FunctionType)? target) =>
            target is { FunctionType: not null };
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("target!!.Item2 != nil", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("target!!.FunctionType", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PositionalRecordProperty_RedeclarationDoesNotDuplicateMember() {
        const source = `
namespace Demo
{
    public readonly record struct Key(string Name)
    {
        public string Name { get; } = Name ?? string.Empty;

        public static string Run() => new Key("hello").Name;
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        let type = Assert.Single(unit.Members.OfType[TypeDeclaration]())
        let property = Assert.Single(type.Members.OfType[PropertyDeclaration]())
        Assert.Equal("Name", property.Name)
        Assert.NotNull(property.ExpressionBody)
        Assert.Empty(property.Accessors)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + "\nKey.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("hello", result.Value)
    }

    @Fact
    func SourceNestedBaseType_InsideGenericContainer_RemainsDirectlyInScope() {
        const source = `
namespace Demo
{
    public class Outer<T>
    {
        private abstract class Format
        {
        }

        private class TextFormat : Format
        {
            public TextFormat() : base()
            {
            }
        }

        private Format Make() => new TextFormat();
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("class TextFormat : Format", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Outer[T].Format", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let tree = SyntaxTree.Parse(SourceText.From(rendered))
        let scope_ = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
    }

    @Fact
    func DeconstructedLocals_PassedByRef_AreMutable() {
        const source = `namespace Demo
{
    public static class C
    {
        private static (int?, int?) Pair() => (null, null);

        private static void Touch(ref int? value)
        {
        }

        public static void M()
        {
            var (left, right) = Pair();
            Touch(ref left);
            Touch(ref right);
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("var (left, right) = Pair()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let (left, right)", rendered, StringComparison.Ordinal)
        Assert.Contains("Touch(&left)", rendered, StringComparison.Ordinal)
        Assert.Contains("Touch(&right)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func DeconstructedLocals_PassedByRef_MutateAtRuntime() {
        const source = `namespace Demo
{
    public static class C
    {
        private static (int, int) Pair() => (0, 0);

        private static void Touch(ref int value)
        {
            value = value + 1;
        }

        public static int M()
        {
            var (left, right) = Pair();
            Touch(ref left);
            Touch(ref right);
            return left + right;
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("var (left, right) = Pair()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("let (left, right)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C.M()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(2, result.Value)
    }
}
