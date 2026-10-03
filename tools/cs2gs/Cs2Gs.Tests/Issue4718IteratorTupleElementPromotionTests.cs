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
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4718IteratorTupleElementPromotionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NonTupleGenericMapping_DoesNotComputeTupleGraph(bool explicitType)
    {
        LoadedCSharpProject loaded = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Types.cs", """
                using System.Collections.Generic;
                public class Types {
                    public List<string> Plain;
                    public List<(string Text, int Code)> Tuple;
                }
                """),
        });
        SemanticModel model = loaded.Compilation.GetSemanticModel(Assert.Single(loaded.Compilation.SyntaxTrees));
        var context = new TranslationContext(loaded.Compilation, model, "Types.cs");
        INamedTypeSymbol owner = Assert.IsAssignableFrom<INamedTypeSymbol>(
            loaded.Compilation.GetTypeByMetadataName("Types"));
        Type analyzer = Assert.IsAssignableFrom<Type>(
            typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer"));
        FieldInfo field = Assert.IsAssignableFrom<FieldInfo>(
            analyzer.GetField("Cache", BindingFlags.Static | BindingFlags.NonPublic));
        object cache = Assert.IsAssignableFrom<object>(field.GetValue(null));
        MethodInfo tryGet = Assert.IsAssignableFrom<MethodInfo>(cache.GetType().GetMethod("TryGetValue"));
        Assert.Equal(false, tryGet.Invoke(cache, new object[] { loaded.Compilation, null }));

        var mapper = new CSharpTypeMapper();
        ITypeSymbol plain = Assert.IsAssignableFrom<IFieldSymbol>(Assert.Single(owner.GetMembers("Plain"))).Type;
        GTypeReference mapped = explicitType
            ? mapper.MapExplicitType(plain, context, Location.None)
            : mapper.Map(plain, context, Location.None);
        Assert.Single(Assert.IsType<NamedTypeReference>(mapped).TypeArguments);
        Assert.Equal(false, tryGet.Invoke(cache, new object[] { loaded.Compilation, null }));

        ITypeSymbol tuple = Assert.IsAssignableFrom<IFieldSymbol>(Assert.Single(owner.GetMembers("Tuple"))).Type;
        _ = explicitType
            ? mapper.MapExplicitType(tuple, context, Location.None)
            : mapper.Map(tuple, context, Location.None);
        Assert.Equal(true, tryGet.Invoke(cache, new object[] { loaded.Compilation, null }));
    }

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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RefAliasEscape_InvalidatesTupleYieldGuard(bool beforeGuard)
    {
        string alias = "ref string alias = ref text;";
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    {{(beforeGuard ? alias : string.Empty)}}
                    if (text != null) {
                        {{(beforeGuard ? string.Empty : alias)}}
                        alias = null;
                        yield return (text, 1);
                    }
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed);
        // #4726 tracks the independent ref-alias storage/smart-cast bind failure.
    }

    [Theory]
    [InlineData("alias = null;")]
    [InlineData("Reset(ref alias);")]
    public void NullableRefAliasBeforeGuard_InvalidatesTupleYieldProof(string mutation)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    ref string? alias = ref text;
                    if (text != null) {
                        {{mutation}}
                        yield return (text, 1);
                    }
                }
                private static void Reset(ref string? value) { value = null; }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("(text)", false)]
    [InlineData("text!", false)]
    [InlineData("(text!)", false)]
    [InlineData("(text)", true)]
    [InlineData("text!", true)]
    [InlineData("(text!)", true)]
    public void WrappedRefStorage_UsesCentralWriteProof(string target, bool readOnly)
    {
        string modifier = readOnly ? "readonly " : string.Empty;
        string mutation = readOnly ? "_ = alias;" : "alias = null;";
        LoadedCSharpProject loaded = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Wrapped.cs", $$"""
                using System.Collections.Generic;
                public static class Obj {
                    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                        string text = choose ? null : "x";
                        ref {{modifier}}string? alias = ref {{target}};
                        if (text != null) {
                            {{mutation}}
                            yield return (text, 1);
                        }
                    }
                }
                """),
        });
        Assert.True(loaded.BoundWithoutErrors, string.Join(Environment.NewLine, loaded.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(loaded.Documents);
        var context = new TranslationContext(loaded.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        TranslationDiagnostic unsupported = Assert.Single(
            context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("RefExpression", unsupported.ToString());

        string textType = readOnly ? "string" : "string?";
        Assert.Contains($"func Rows(choose bool) sequence[(Text {textType}, Code int32)]", printed);
        // Wrapped ref lowering already fails loudly; its diagnostic is unchanged.
    }

    [Fact]
    public void ReadOnlyRefAliasBeforeGuard_PreservesTupleYieldProof()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    ref readonly string? alias = ref text;
                    if (text != null) {
                        _ = alias;
                        yield return (text, 1);
                    }
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("Borrow(ref text)")]
    [InlineData("Forward(ref text)")]
    public void RefReturningCallBeforeGuard_InvalidatesTupleYieldProof(string borrow)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    ref string? alias = ref {{borrow}};
                    if (text != null) {
                        alias = null;
                        yield return (text, 1);
                    }
                }
                private static ref string? Borrow(ref string? value) { return ref value; }
                private static ref string? Forward(ref string? value) { return ref Borrow(ref value); }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void BackwardGoto_DoesNotReuseTupleYieldGuard()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    int count = 0;
                    if (text != null) {
                        Again:
                        yield return (text, count);
                        text = null;
                        if (++count < 2) { goto Again; }
                    }
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("IEnumerable", false, false)]
    [InlineData("IEnumerable", false, true)]
    [InlineData("IEnumerable", true, false)]
    [InlineData("IEnumerable", true, true)]
    [InlineData("IEnumerator", false, false)]
    [InlineData("IEnumerator", false, true)]
    [InlineData("IEnumerator", true, false)]
    [InlineData("IEnumerator", true, true)]
    public void IteratorGetters_CollectOwnTupleYields(string envelope, bool indexer, bool guarded)
    {
        string member = indexer ? "this[bool choose]" : "Rows";
        string choose = indexer ? "choose" : "Choose";
        string initializer = $"{choose} ? null : \"x\"";
        string yield = guarded
            ? "if (text != null) { yield return (text, 1); }"
            : $"yield return {choose} ? (text, 1) : (\"x\", 2);";
        string printed = Translate($$"""
            using System.Collections.Generic;
            public sealed class Obj {
                public bool Choose;
                public {{envelope}}<(string Text, int Code)> {{member}} {
                    get {
                        string text = {{initializer}};
                        {{yield}}
                    }
                }
            }
            """);

        string textType = guarded ? "string" : "string?";
        Assert.Contains($"{envelope}[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public void IteratorGetterContracts_SynchronizeNullableTupleSlots(bool interfaceContract, bool indexer)
    {
        string member = indexer ? "this[bool choose]" : "Rows";
        string contract = interfaceContract
            ? $"public interface IRows {{ IEnumerable<(string Text, int Code)> {member} {{ get; }} }}"
            : $"public abstract class RowsBase {{ public abstract IEnumerable<(string Text, int Code)> {member} {{ get; }} }}";
        string owner = interfaceContract ? "IRows" : "RowsBase";
        string modifier = interfaceContract ? string.Empty : "override ";
        string printed = Translate($$"""
            using System.Collections.Generic;
            {{contract}}
            public sealed class MissingRows : {{owner}} {
                public {{modifier}}IEnumerable<(string Text, int Code)> {{member}} {
                    get { string text = null; yield return (text, 1); }
                }
            }
            public sealed class PresentRows : {{owner}} {
                public {{modifier}}IEnumerable<(string Text, int Code)> {{member}} {
                    get { yield return ("x", 1); }
                }
            }
            """);

        Assert.Equal(3, printed.Split("IEnumerable[(Text string?, Code int32)]").Length - 1);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LocalIteratorGoto_InvalidatesOnlyItsOwnGuard(bool ownJump)
    {
        string iteratorJump = ownJump ? "if (++count < 2) { goto Again; }" : string.Empty;
        string unrelatedJump = ownJump ? string.Empty : "goto Done; Done: return 0;";
        string printed = Translate($$"""
            using System.Collections.Generic;
            Obj.Rows(false);
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    IEnumerable<(string Text, int Code)> Inner() {
                        string text = choose ? null : "x";
                        int count = 0;
                        if (text != null) {
                            Again:
                            yield return (text, count);
                            text = null;
                            {{iteratorJump}}
                        }
                    }
                    int Sibling() { {{unrelatedJump}} return 1; }
                    return Inner();
                }
            }
            """, outputKind: OutputKind.ConsoleApplication);

        string textType = ownJump ? "string?" : "string";
        Assert.Contains($"func Rows(choose bool) IEnumerable[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void IteratorGetterForwarding_ReusesDeclarationPathsAndYieldOwnership()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public sealed class Obj {
                public IEnumerable<((string Text, string Keep) Names, int Code)> Missing {
                    get {
                        string text = null;
                        yield return ((text, "keep"), 1);
                    }
                }
                public IEnumerable<((string Text, string Keep) Names, int Code)> Arrow => Missing;
                public IEnumerable<((string Text, string Keep) Names, int Code)> Block {
                    get { return Missing; }
                }
                public IEnumerable<(string Text, int Code)> Present {
                    get {
                        IEnumerable<(string Text, int Code)> Inner() {
                            string text = null;
                            yield return (text, 1);
                        }
                        yield return ("x", 1);
                    }
                }
            }
            """);

        Assert.Equal(3, printed.Split("IEnumerable[(Names (Text string?, Keep string), Code int32)]").Length - 1);
        Assert.Contains("Present IEnumerable[(Text string, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CapturedIteratorStorage_AccountsForEnclosingWritesAcrossResumption(bool mutates)
    {
        string mutation = mutates ? "text = null;" : string.Empty;
        string result = mutates ? "rows.Current.Text == null ? 1 : -2" : "rows.Current.Text.Length";
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static int Run(bool choose) {
                    string text = choose ? null : "x";
                    IEnumerable<(string Text, int Code)> Rows() {
                        if (text != null) {
                            yield return (text, 1);
                            yield return (text, 2);
                        }
                    }
                    var rows = Rows().GetEnumerator();
                    if (!rows.MoveNext()) { return -1; }
                    {{mutation}}
                    if (!rows.MoveNext()) { return -3; }
                    return {{result}};
                }
            }
            """);

        string textType = mutates ? "string?" : "string";
        Assert.Contains($"IEnumerable[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
        EmittedOracleResult execution = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run(false)");
        Assert.False(
            execution.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, execution.Diagnostics) + Environment.NewLine + printed);
        Assert.Null(execution.UnhandledException);
        Assert.Equal(1, execution.Value);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ConstructedIteratorContracts_SynchronizeTypeArgumentsAndUses(bool interfaceContract, bool guarded)
    {
        string declaration = interfaceContract
            ? "public interface IRows<T> { IEnumerable<T> Rows(); }"
            : "public abstract class IRows<T> { public abstract IEnumerable<T> Rows(); }";
        string modifier = interfaceContract ? string.Empty : "override ";
        string yield = guarded
            ? "if (text != null) { yield return (text, 1); }"
            : "yield return (text, 1);";
        string printed = Translate($$"""
            using System.Collections.Generic;
            {{declaration}}
            public sealed class MissingRows : IRows<(string Text, int Code)> {
                public {{modifier}}IEnumerable<(string Text, int Code)> Rows() {
                    string text = null;
                    {{yield}}
                }
            }
            public sealed class PresentRows : IRows<(string Text, int Code)> {
                public {{modifier}}IEnumerable<(string Text, int Code)> Rows() {
                    yield return ("x", 1);
                }
            }
            public sealed class OtherRows : IRows<(string Text, long Code)> {
                public {{modifier}}IEnumerable<(string Text, long Code)> Rows() {
                    yield return ("x", 1L);
                }
            }
            public static class Consumer {
                public static IRows<(string Text, int Code)> Carry(IRows<(string Text, int Code)> value) {
                    IRows<(string Text, int Code)> rows = Identity<IRows<(string Text, int Code)>>(
                        (IRows<(string Text, int Code)>)value);
                    return rows;
                }
                public static IRows<(string Label, int Number)> Alias(IRows<(string Label, int Number)> value) {
                    return value;
                }
                private static T Identity<T>(T value) { return value; }
            }
            """);

        string textType = guarded ? "string" : "string?";
        Assert.Equal(6, printed.Split($"IRows[(Text {textType}, Code int32)]").Length - 1);
        Assert.Equal(2, printed.Split($"IRows[(Label {textType}, Number int32)]").Length - 1);
        Assert.Contains("IRows[(Text string, Code int64)]", printed);
        Assert.Contains("sequence[(Text string, Code int64)]", printed);
        Assert.Equal(2, printed.Split($"sequence[(Text {textType}, Code int32)]").Length - 1);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ConstructedInheritedContracts_ProjectReorderedNestedTupleArguments(bool interfaceContract)
    {
        string declaration = interfaceContract
            ? "public interface IAlias<X, Y> : IRows<Y, X> { }"
            : "public abstract class IAlias<X, Y> : IRows<Y, X> { public abstract IEnumerable<(X Value, int Code)> Rows(); }";
        string modifier = interfaceContract ? string.Empty : "override ";
        string printed = Translate($$"""
            using System.Collections.Generic;
            public interface IRows<A, T> { IEnumerable<(T Value, int Code)> Rows(); }
            {{declaration}}
            public sealed class MissingRows : IAlias<(string Text, int Id), int> {
                public {{modifier}}IEnumerable<((string Text, int Id) Value, int Code)> Rows() {
                    string text = null;
                    yield return ((text, 1), 2);
                }
            }
            public static class Consumer {
                public static IEnumerable<((string Text, int Id) Value, int Code)> Copy(
                    IAlias<(string Text, int Id), int> source) {
                    var values = source.Rows();
                    return values;
                }
            }
            """);

        Assert.Equal(2, printed.Split("IAlias[(Text string?, Id int32), int32]").Length - 1);
        Assert.Contains("IEnumerable[(Value (Text string?, Id int32), Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ConstructedContractReferences_UseSiblingTupleEvidence(bool nullableConsumer, bool siblingContract)
    {
        var producer = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Producer.cs", """
                using System.Collections.Generic;
                public interface IRows<T> { IEnumerable<T> Rows(); }
                public sealed class MissingRows : IRows<(string Text, int Code)> {
                    public IEnumerable<(string Text, int Code)> Rows() {
                        string text = null;
                        yield return (text, 1);
                    }
                }
                """),
        }).Compilation.WithAssemblyName("ConstructedProducer");
        using var image = new MemoryStream();
        var emitted = producer.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        string ownContract = siblingContract ? string.Empty : "public interface IRows<T> { }";
        LoadedCSharpProject loaded = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Consumer.cs", $$"""
                    {{ownContract}}
                    public static class Consumer {
                        public static IRows<(string Label, int Number)> Carry(IRows<(string Label, int Number)> value) {
                            return value;
                        }
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(image.ToArray())).ToArray());
        var consumer = loaded.Compilation.WithAssemblyName("ConstructedConsumer").WithOptions(
            loaded.Compilation.Options.WithNullableContextOptions(
                nullableConsumer ? NullableContextOptions.Enable : NullableContextOptions.Disable));
        var printed = new List<string>();
        foreach (CSharpCompilation compilation in new[] { producer, consumer })
        {
            Assert.DoesNotContain(compilation.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
            SyntaxTree tree = Assert.Single(compilation.SyntaxTrees);
            SemanticModel model = compilation.GetSemanticModel(tree);
            var document = new LoadedDocument(tree.FilePath, tree, model);
            var context = new TranslationContext(
                compilation, model, tree.FilePath, new[] { producer, consumer });
            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            printed.Add(GSharpPrinter.Print(unit));
        }

        string textType = siblingContract ? "string?" : "string";
        Assert.True(
            printed[1].Split($"IRows[(Label {textType}, Number int32)]").Length - 1 == 2,
            string.Join(Environment.NewLine, printed));
        TranslationTestValidation.AssertBinds(siblingContract
            ? string.Join(Environment.NewLine, printed)
            : printed[1]);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void PositionalRecordTupleContracts_UsePrimaryParameterEvidence(bool envelope, bool nullable)
    {
        string valueType = envelope
            ? "IEnumerable<(string Text, int Code)>"
            : "(string Text, int Code)";
        string initializer = nullable ? "null" : "\"x\"";
        string argument = envelope ? "Rows()" : "(text, 1)";
        string printed = Translate($$"""
            using System.Collections.Generic;
            public interface IRow { {{valueType}} Value { get; } }
            public record Row({{valueType}} Value) : IRow;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows() {
                    string text = {{initializer}};
                    yield return true ? (text, 1) : ("x", 2);
                }
                public static IRow Create() {
                    string text = {{initializer}};
                    return new Row({{argument}});
                }
            }
            """);

        string[] declarations = printed.Split(Environment.NewLine)
            .Where(line => line.Contains("Value", StringComparison.Ordinal)
                && line.Contains("(Text ", StringComparison.Ordinal))
            .ToArray();
        Assert.Equal(2, declarations.Length);
        string textType = nullable ? "string?" : "string";
        Assert.All(declarations, declaration => Assert.Contains($"(Text {textType}, Code int32)", declaration));
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("void Reset() { text = null; }", "Reset();", true)]
    [InlineData("System.Action reset = () => text = null;", "reset();", true)]
    [InlineData("void Clear() { text = null; } void Reset() { Clear(); }", "Reset();", true)]
    [InlineData("void Clear() { text = null; } System.Action reset = Clear;", "reset();", true)]
    [InlineData("void Observe() { choose = false; }", "Observe();", false)]
    [InlineData("System.Action observe = () => choose = false;", "observe();", false)]
    public void CapturedWrites_DoNotEstablishStableTupleYieldGuards(
        string declaration,
        string invocation,
        bool nullable)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    {{declaration}}
                    if (text != null) {
                        {{invocation}}
                        yield return (text, 1);
                    }
                }
            }
            """);

        string textType = nullable ? "string?" : "string";
        Assert.Contains($"func Rows(choose bool) sequence[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("in ")]
    [InlineData("")]
    public void ReadOnlyInArgument_PreservesTupleYieldGuard(string argumentModifier)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    if (text != null) {
                        Observe({{argumentModifier}}text);
                        yield return (text, 1);
                    }
                }
                private static void Observe(in string value) { }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("void Reset() { text = null; }", "Reset();", true)]
    [InlineData("System.Action reset = () => text = null;", "reset();", true)]
    [InlineData("void Observe() { }", "Observe();", false)]
    public void TopLevelCapturedStorage_UsesTheWholeDeclaringScope(
        string declaration,
        string invocation,
        bool nullable)
    {
        string printed = Translate(
            $$"""
            using System.Collections.Generic;
            string text = args.Length == 0 ? null : "x";
            {{declaration}}
            IEnumerable<(string Text, int Code)> Rows() {
                if (text != null) {
                    {{invocation}}
                    yield return (text, 1);
                }
            }
            foreach (var row in Rows()) { }
            """,
            outputKind: OutputKind.ConsoleApplication);

        string textType = nullable ? "string?" : "string";
        Assert.Contains($"let Rows = func () IEnumerable[(Text {textType}, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
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

    private static string Translate(
        string source,
        IReadOnlyList<MetadataReference> references = null,
        OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            references,
            outputKind: outputKind);
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
