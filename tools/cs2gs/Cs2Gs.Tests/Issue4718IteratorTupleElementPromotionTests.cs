// <copyright file="Issue4718IteratorTupleElementPromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4718IteratorTupleElementPromotionTests
{
    [Theory]
    [InlineData("IEnumerable", "", "sequence")]
    [InlineData("IEnumerator", "", "IEnumerator")]
    [InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")]
    [InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")]
    public void ConditionalTupleYield_PromotesOnlyNullBearingElement(
        string envelope,
        string modifier,
        string mappedEnvelope)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static {{modifier}}{{envelope}}<(string Text, int Code)> TupleRows(bool choose) {
                    string text = null;
                    yield return choose ? (text, 1) : ("x", 2);
                }
            }
            """);

        Assert.Contains($"func TupleRows(choose bool) {mappedEnvelope}[(Text string?, Code int32)]", printed);
        Assert.Contains("let text string? = nil", printed);
        Assert.DoesNotContain("text!!", printed);
    }

    [Theory]
    [InlineData("IEnumerable", "", true, false)]
    [InlineData("IEnumerator", "", true, false)]
    [InlineData("IAsyncEnumerable", "async ", true, false)]
    [InlineData("IAsyncEnumerator", "async ", true, false)]
    [InlineData("IEnumerable", "", false, false)]
    [InlineData("IEnumerator", "", false, false)]
    [InlineData("IAsyncEnumerable", "async ", false, false)]
    [InlineData("IAsyncEnumerator", "async ", false, false)]
    [InlineData("IEnumerable", "", true, true)]
    [InlineData("IEnumerator", "", true, true)]
    [InlineData("IAsyncEnumerable", "async ", true, true)]
    [InlineData("IAsyncEnumerator", "async ", true, true)]
    [InlineData("IEnumerable", "", false, true)]
    [InlineData("IEnumerator", "", false, true)]
    [InlineData("IAsyncEnumerable", "async ", false, true)]
    [InlineData("IAsyncEnumerator", "async ", false, true)]
    public void IteratorTupleContracts_SynchronizeInterfacesOverridesAndSiblingImplementations(
        string envelope,
        string modifier,
        bool interfaceContract,
        bool guarded)
    {
        string yielded = """
            yield return choose ? ((choose ? text : "x", "keep"), 1) : (("x", "keep"), 2);
            """;
        string row = envelope.EndsWith("Enumerator", StringComparison.Ordinal) ? "rows.Current" : "row";
        string read = guarded
            ? $"result += {row}.Names.Text.Length;"
            : $"if ({row}.Names.Text == null) {{ result++; }}";
        string scan = envelope switch
        {
            "IEnumerable" => $"foreach (var row in source.Rows(choose)) {{ {read} }}",
            "IEnumerator" => $"var rows = source.Rows(choose); while (rows.MoveNext()) {{ {read} }}",
            "IAsyncEnumerable" => $"await foreach (var row in source.Rows(choose)) {{ {read} }}",
            _ => $"var rows = source.Rows(choose); while (await rows.MoveNextAsync()) {{ {read} }}",
        };
        string returnType = modifier.Length == 0 ? "int" : "System.Threading.Tasks.Task<int>";
        string contract = interfaceContract
            ? $$"""
                public interface IRows {
                    {{envelope}}<((string Text, string Keep) Names, int Code)> Rows(bool choose);
                }
                """
            : $$"""
                public abstract class RowsBase {
                    public abstract {{envelope}}<((string Text, string Keep) Names, int Code)> Rows(bool choose);
                }
                """;
        string contractType = interfaceContract ? "IRows" : "RowsBase";
        string implementationModifier = interfaceContract ? modifier : "override " + modifier;
        string printed = Translate($$"""
            using System.Collections.Generic;
            {{contract}}
            public sealed class MissingRows : {{contractType}} {
                public {{implementationModifier}}{{envelope}}<((string Text, string Keep) Names, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    {{(guarded ? "if (text != null) { " + yielded + " }" : yielded)}}
                }
            }
            public sealed class PresentRows : {{contractType}} {
                public {{implementationModifier}}{{envelope}}<((string Text, string Keep) Names, int Code)> Rows(bool choose) {
                    yield return (("present", "keep"), 3);
                }
            }
            public static class Consumer {
                public static {{modifier}}{{returnType}} Read({{contractType}} source, bool choose) {
                    int result = 0;
                    {{scan}}
                    return result;
                }
            }
            """);

        TranslationTestValidation.AssertBinds(printed);
        string[] signatures = printed.Split(Environment.NewLine)
            .Where(line => line.Contains("func Rows(", StringComparison.Ordinal))
            .ToArray();
        Assert.Equal(3, signatures.Length);
        string textType = guarded ? "string" : "string?";
        Assert.All(
            signatures,
            signature => Assert.Contains($"(Names (Text {textType}, Keep string), Code int32)", signature));
        Assert.DoesNotContain("Keep string?", printed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedTupleReturnContracts_OnlyEquivalentShapesSharePositionalTaint(bool reordered)
    {
        LoadedCSharpProject library = CSharpProjectLoader.LoadInMemory(new[] { ("Library.cs", """
            #nullable enable
            namespace Contract4718;
            public class Carrier<X, Y> { }
            public class Reordered<X, Y> : Carrier<Y, X> { }
            public abstract class RowsBase {
                public abstract Carrier<(string? Text, int Code), (string Keep, int Code)> Rows();
            }
            """) }, assemblyName: "Contract4718");
        using var image = new MemoryStream();
        var emitted = library.Compilation.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        byte[] bytes = image.ToArray();
        string returnType = reordered
            ? "Reordered<(string Keep, int Code), (string Text, int Code)>"
            : "Carrier<(string Text, int Code), (string Keep, int Code)>";
        string printed = Translate(
            $$"""
            using Contract4718;
            public sealed class Producer : RowsBase {
                public override {{returnType}} Rows() {
                    return new {{returnType}}();
                }
            }
            """,
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(bytes)).ToArray());

        string expected = reordered
            ? "Reordered[(Keep string, Code int32), (Text string, Code int32)]"
            : "Carrier[(Text string?, Code int32), (Keep string, Code int32)]";
        Assert.Contains("override func Rows() " + expected, printed);
        Assembly.Load(bytes);
        using var resolver = ReferenceResolver.WithRuntimeReferences(Array.Empty<string>());
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    [Theory]
    [InlineData("IEnumerable", "", true)]
    [InlineData("IEnumerable", "", false)]
    [InlineData("IAsyncEnumerable", "async ", true)]
    [InlineData("IAsyncEnumerable", "async ", false)]
    public void GenericIteratorContracts_UseTypeParameterOrdinals(
        string envelope,
        string modifier,
        bool interfaceContract)
    {
        string contract = interfaceContract
            ? $"public interface IRows {{ {envelope}<(string Text, T Value)> Rows<T>(T value, bool choose); }}"
            : $"public abstract class RowsBase {{ public abstract {envelope}<(string Text, T Value)> Rows<T>(T value, bool choose); }}";
        string owner = interfaceContract ? "IRows" : "RowsBase";
        string implementationModifier = interfaceContract ? modifier : "override " + modifier;
        string printed = Translate($$"""
            using System.Collections.Generic;
            {{contract}}
            public sealed class MissingRows : {{owner}} {
                public {{implementationModifier}}{{envelope}}<(string Text, U Value)> Rows<U>(U value, bool choose) {
                    string text = null;
                    yield return choose ? (text, value) : ("x", value);
                }
            }
            public sealed class PresentRows : {{owner}} {
                public {{implementationModifier}}{{envelope}}<(string Text, V Value)> Rows<V>(V value, bool choose) {
                    yield return ("x", value);
                }
            }
            """);

        Assert.Contains("(Text string?, Value T)", printed);
        Assert.Contains("(Text string?, Value U)", printed);
        Assert.Contains("(Text string?, Value V)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("if (text != null) { text = null; yield return (text, 1); }", true)]
    [InlineData("if (text == null) { throw new System.Exception(); } text = null; yield return (text, 1);", true)]
    [InlineData("if (text != null) { Reset(ref text); yield return (text, 1); }", true)]
    [InlineData("if (text != null) { (text, choose) = (null, true); yield return (text, 1); }", true)]
    [InlineData("if (text != null) { for (int i = 0; i < 2; i++) { yield return (text, i); text = null; } }", true)]
    [InlineData("if (text != null) { text = choose ? null : \"fresh\"; if (text != null) { yield return (text, 1); } }", false)]
    [InlineData("if (text != null) { choose = false; yield return (text, 1); }", false)]
    public void TupleYieldGuards_RequireAnUnchangedValue(string body, bool nullable)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    {{body}}
                }
                private static void Reset(ref string value) { value = null; }
            }
            """);

        string textType = nullable ? "string?" : "string";
        Assert.Contains($"func Rows(choose bool) sequence[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void RefAliasEscape_InvalidatesTupleYieldGuard()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    if (text != null) {
                        ref string alias = ref text;
                        alias = null;
                        yield return (text, 1);
                    }
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed);
        // #4726 tracks the independent ref-alias storage/smart-cast bind failure.
    }

    [Fact]
    public void NestedSwitchTupleYield_UsesTheSameElementPathsAsForwardedCollection()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<((string Text, string Keep) Names, int Code)> NestedRows(bool choose) {
                    string text = null;
                    yield return choose switch {
                        true => ((text, "keep"), 1),
                        false => (("x", "keep"), 2)
                    };
                }

                public static IEnumerable<((string Text, string Keep) Names, int Code)> Forward(bool choose) {
                    return NestedRows(choose);
                }
            }
            """);

        Assert.Contains(
            "func NestedRows(choose bool) sequence[(Names (Text string?, Keep string), Code int32)]",
            printed);
        Assert.Contains(
            "func Forward(choose bool) IEnumerable[(Names (Text string?, Keep string), Code int32)]",
            printed);
        Assert.DoesNotContain("Keep string?", printed);
        Assert.DoesNotContain("text!!", printed);
    }

    [Fact]
    public void NestedIteratorAndYieldBreak_DoNotTaintOuterIterator()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    IEnumerable<(string Text, int Code)> Missing() {
                        string text = null;
                        yield return choose ? (text, 1) : ("x", 2);
                    }
                    if (choose) { yield break; }
                    yield return ("keep", 2);
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.Contains("let Missing = func () IEnumerable[(Text string?, Code int32)]", printed);
    }

    [Theory]
    [InlineData("(text, 1)", "string")]
    [InlineData("choose ? (text, 1) : (\"x\", 2)", "string")]
    [InlineData("choose switch { true => (text, 1), false => (\"x\", 2) }", "string")]
    [InlineData("(choose ? text : \"x\", 1)", "string")]
    [InlineData("(choose switch { true => text, false => \"x\" }, 1)", "string?")]
    public void GuardedTupleYield_DoesNotPromoteItsProvenNonNullLeaf(string yielded, string declaredType)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    {{declaredType}} text = choose ? null : "x";
                    if (text != null) {
                        yield return {{yielded}};
                    }
                }

                public static int Lengths(bool choose) {
                    int total = 0;
                    foreach (var row in Rows(choose)) {
                        total += row.Text.Length;
                    }
                    return total;
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void GuardedNestedConditionalTupleYield_StillPromotesTheUnguardedSibling()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<((string Text, string Missing) Names, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    string missing = null;
                    if (text != null) {
                        yield return choose ? ((text, missing), 1) : (("x", "keep"), 2);
                    }
                }
            }
            """);

        Assert.Contains(
            "func Rows(choose bool) sequence[(Names (Text string, Missing string?), Code int32)]",
            printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ConditionalTupleYield_PreservesNullAndNonNullRuntimeValues()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> TupleRows(bool choose) {
                    string text = null;
                    yield return choose ? (text, 1) : ("x", 2);
                }

                public static int Run() {
                    int result = 0;
                    foreach (var row in TupleRows(true)) {
                        if (row.Text != null || row.Code != 1) { return -1; }
                        result += 1;
                    }
                    foreach (var row in TupleRows(false)) {
                        if (row.Text != "x" || row.Code != 2) { return -2; }
                        result += 2;
                    }
                    return result;
                }
            }
            """);

        Assert.Contains("func TupleRows(choose bool) sequence[(Text string?, Code int32)]", printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(
            result.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    private static string Translate(string source, IReadOnlyList<MetadataReference> references = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) }, references);
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
