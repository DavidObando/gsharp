// <copyright file="Issue914ObliviousSinkTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #914: the oblivious-nullability taint
/// analysis (<see cref="ObliviousNullabilityAnalyzer"/>) already promotes
/// null-reachable reference SOURCES (returns, fields, locals, null-checked
/// params) to <c>T?</c>. These tests cover the complementary SINK positions
/// that must also be promoted so a promoted <c>T?</c> value flows without a
/// GS0154/GS0155/GS0156 "T? vs T" error:
/// <list type="number">
/// <item>tuple return-element types,</item>
/// <item>lambda / local-function return types,</item>
/// <item>property-getter return types that forward a promoted backing field,</item>
/// <item>designated-constructor parameters reached via a <c>: this(...)</c>
/// delegation carrying null,</item>
/// <item>delegate parameters invoked with a null argument.</item>
/// </list>
/// All promotions are gated to oblivious compilations, so a
/// nullable-<em>enabled</em> compilation stays byte-identical (unpromoted).
/// </summary>
public class Issue914ObliviousSinkTranslationTests
{
    [Fact]
    public void Oblivious_TupleReturn_PromotesElementTypesToNullable()
    {
        // `dir`/`file` are null-tainted locals; the `(string, string)` return
        // type must promote its element types so `return (dir, file)` (which
        // yields `(string?, string?)`) does not trip GS0155.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public (string, string) Get(bool b)
        {
            string dir = ""d"";
            string file = ""f"";
            if (b) { dir = null; file = null; }
            return (dir, file);
        }
    }
}");

        Assert.Contains("Get(b bool) (string?, string?)", printed);
    }

    [Fact]
    public void Oblivious_LocalFunctionReturn_PromotesToNullable()
    {
        // The local function `Parse` returns null on a path, so its return type
        // must render `string?` exactly like a method return.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public void Run(string s)
        {
            string Parse(string v)
            {
                if (v == null) { return null; }
                return v;
            }

            var x = Parse(s);
        }
    }
}");

        Assert.Contains("func (v string?) string?", printed);
    }

    [Fact]
    public void Oblivious_PropertyGetterForwardingPromotedField_PromotesPropertyType()
    {
        // `writer` is null-tainted (assigned null), so the backing field is
        // `StreamWriter?`; the expression-bodied getter `Writer => writer`
        // forwards it, so the property type must promote to `TextWriter?`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        private System.IO.StreamWriter writer;

        public System.IO.TextWriter Writer => this.writer;

        public void Clear() { this.writer = null; }
    }
}");

        Assert.Contains("Writer TextWriter?", printed);
    }

    [Fact]
    public void Oblivious_DesignatedConstructorReachedWithNull_PromotesParameters()
    {
        // The convenience ctor `C() : this(null, null)` delegates to the
        // designated ctor; the analyzer follows the constructor-initializer
        // arg->param edges, so `context`/`message` must render `string?`.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public C(string context, string message) { }

        public C() : this(null, null) { }
    }
}");

        Assert.Contains("init(context string?, message string?)", printed);
    }

    [Fact]
    public void Enabled_DesignatedConstructorReachedWithNull_StaysUnpromoted()
    {
        // The SAME shape under a nullable-ENABLED compilation: the analyzer
        // short-circuits, the annotations are non-null, so the designated ctor
        // parameters stay `string` (byte-identical, unpromoted).
        string printed = TranslateEnabled(@"
namespace Demo
{
    public class C
    {
        public C(string context, string message) { }

        public C() : this(null, null) { }
    }
}");

        Assert.Contains("init(context string, message string)", printed);
        Assert.DoesNotContain("string?", printed);
    }

    [Fact]
    public void Oblivious_DelegateParameterInvokedWithNull_PromotesArrowParameter()
    {
        // `cb` is invoked with a null argument, so its delegate parameter type
        // must promote to `object?` (an arrow parameter position).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public void Run(System.Action<object> cb)
        {
            cb(null);
        }
    }
}");

        Assert.Contains("(object?) -> void", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Select(r => r).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
