// <copyright file="Issue2516ArrayCovarianceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
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
/// Regression coverage for issue #2516: cs2gs emitted a C# array-covariance
/// conversion (<c>Derived[] -&gt; IEnumerable&lt;Base&gt;</c>, and the like) as a bare
/// G# slice argument/return/assignment/etc., which G#'s intentionally
/// invariant slice conversion (<c>Conversion.cs</c>) then rejected with
/// GS0155. <c>CoerceArrayCovarianceConversion</c> (shared across every
/// value-flow sink) now materializes the conversion as the canonical G# safe
/// cast <c>(expr as T)</c>.
/// </summary>
public sealed class Issue2516ArrayCovarianceTranslationTests
{
    private const string SourceModel = """
        using System;
        using System.Collections.Generic;

        namespace Demo;

        public interface IPerson { }
        public sealed class Author : IPerson { }
        """;

    [Fact]
    public void Argument_ArrayToEachCovariantInterface_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void Accept(IEnumerable<IPerson> values) { }
                public static void AcceptReadOnlyList(IReadOnlyList<IPerson> values) { }
                public static void AcceptReadOnlyCollection(IReadOnlyCollection<IPerson> values) { }
                public static void AcceptList(IList<IPerson> values) { }
                public static void AcceptCollection(ICollection<IPerson> values) { }
                public static void AcceptArray(IPerson[] values) { }

                public static void TestEnumerable(Author[] values) => Accept(values);
                public static void TestReadOnlyList(Author[] values) => AcceptReadOnlyList(values);
                public static void TestReadOnlyCollection(Author[] values) => AcceptReadOnlyCollection(values);
                public static void TestList(Author[] values) => AcceptList(values);
                public static void TestCollection(Author[] values) => AcceptCollection(values);
                public static void TestArray(Author[] values) => AcceptArray(values);
            }
            """);

        Assert.Contains("Repro.Accept((values as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptReadOnlyList((values as IReadOnlyList[IPerson]))", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptReadOnlyCollection((values as IReadOnlyCollection[IPerson]))", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptList((values as IList[IPerson]))", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptCollection((values as ICollection[IPerson]))", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptArray((values as []IPerson))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Argument_NullableEnvelopeTarget_EmitsAsCast()
    {
        // The exact issue #2516 stable minimal repro shape: a nullable-envelope
        // target (`IEnumerable<IPerson>?`). Roslyn's plain `GetTypeInfo(...).
        // ConvertedType` reports the argument's converted type as NOT annotated
        // here (a Roslyn API nuance — `IArgumentOperation.Parameter.Type` carries
        // the declared `?`, but `TypeInfo.ConvertedType` at the argument
        // expression does not), so the emitted cast targets the non-nullable
        // interface form. That still type-checks: a non-nullable G# reference
        // type always widens implicitly to its own nullable envelope (verified
        // directly against gsc), so `(values as IEnumerable[IPerson])` binds
        // cleanly to the `IEnumerable[IPerson]?` parameter without any further
        // cast — see Issue2516ArrayCovarianceAsCastEmitTests (Compiler.Tests)
        // for the runtime proof of that widening step.
        string printed = Translate("""
            using System.Collections.Generic;

            namespace Demo;

            public interface IPerson { }
            public sealed class Author : IPerson { }

            public static class Repro
            {
                public static void Accept(IEnumerable<IPerson>? values) { }
                public static void Test(Author[] values) => Accept(values);
            }
            """,
            NullableContextOptions.Enable);

        Assert.Contains("func Accept(values IEnumerable[IPerson]?)", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Accept((values as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Argument_ExactElementMatch_StaysBare_Issue2140Regression()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void AcceptExact(IEnumerable<Author> values) { }
                public static void TestExact(Author[] values) => AcceptExact(values);
            }
            """);

        Assert.Contains("Repro.AcceptExact(values)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("values as", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Argument_ElementIndependentTargets_StayBare()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void AcceptObject(object value) { }
                public static void AcceptArrayBase(Array value) { }
                public static void AcceptEnumerableNonGeneric(System.Collections.IEnumerable value) { }

                public static void TestObject(Author[] values) => AcceptObject(values);
                public static void TestArrayBase(Author[] values) => AcceptArrayBase(values);
                public static void TestEnumerableNonGeneric(Author[] values) => AcceptEnumerableNonGeneric(values);
            }
            """);

        Assert.Contains("Repro.AcceptObject(values)", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptArrayBase(values)", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.AcceptEnumerableNonGeneric(values)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("values as", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void Argument_ValueTypeArrayExactMatch_StaysBare_InvarianceRegression()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            namespace Demo;

            public static class Repro
            {
                public static void AcceptInts(IEnumerable<int> values) { }
                public static void TestInts(int[] values) => AcceptInts(values);
            }
            """);

        Assert.Contains("Repro.AcceptInts(values)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("values as", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReturnStatement_ArrowBodiedAndBlockBodied_EmitAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> ReturnArrow(Author[] values) => values;

                public static IEnumerable<IPerson> ReturnBlock(Author[] values)
                {
                    return values;
                }
            }
            """);

        Assert.Contains("values as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "values as IEnumerable[IPerson]"));
    }

    [Fact]
    public void Assignment_And_LocalDeclaration_EmitAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> AssignExample(Author[] values)
                {
                    IEnumerable<IPerson> target;
                    target = values;
                    return target;
                }

                public static IEnumerable<IPerson> LocalExample(Author[] values)
                {
                    IEnumerable<IPerson> local = values;
                    return local;
                }
            }
            """);

        Assert.Contains("target = (values as IEnumerable[IPerson])", printed, StringComparison.Ordinal);
        Assert.Contains("values as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "values as IEnumerable[IPerson]"));
    }

    [Fact]
    public void ConditionalTernary_CommonArrayType_WrapsOuterConversionOnce()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> ConditionalCommon(bool flag, Author[] a, Author[] b) =>
                    flag ? a : b;
            }
            """);

        // Both arms share the natural type `[]Author`; C# converts the WHOLE
        // conditional once, so exactly one `as` wrap should appear (never a
        // double-wrapped `(a as T) as T` from the per-arm AND outer sinks
        // both firing).
        Assert.Equal(1, CountOccurrences(printed, "as IEnumerable[IPerson]"));
        Assert.Contains("if flag { a } else { b }", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ConditionalTernary_TargetTyped_DifferingArmTypes_WrapsOnlyArrayArm()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> ConditionalTargetTyped(bool flag, Author[] a, List<IPerson> b) =>
                    flag ? a : b;
            }
            """);

        // `a` (an array) needs the covariance wrap; `b` (a List<IPerson>) is
        // an ordinary CLR upcast G# already accepts bare — it must stay bare.
        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "as IEnumerable[IPerson]"));
    }

    [Fact]
    public void SwitchExpression_CommonArmType_WrapsOuterConversionOnce()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> SwitchArm(int mode, Author[] a, Author[] b) => mode switch
                {
                    0 => a,
                    _ => b,
                };
            }
            """);

        // Both arms share the natural type `[]Author`; C# converts the switch
        // expression's common result ONCE, so exactly one `as` wrap should
        // appear around the whole switch (never a double-wrapped per-arm AND
        // outer conversion).
        Assert.Equal(1, CountOccurrences(printed, "as IEnumerable[IPerson]"));
        Assert.Contains("case 0: a", printed, StringComparison.Ordinal);
        Assert.Contains("default: b", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchExpression_TargetTyped_DifferingArmTypes_WrapsOnlyArrayArm()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> SwitchArmTargetTyped(int mode, Author[] a, List<IPerson> b) => mode switch
                {
                    0 => a,
                    _ => b,
                };
            }
            """);

        // `a` (an array) needs the covariance wrap; `b` (a List<IPerson>) is
        // an ordinary CLR upcast G# already accepts bare — it must stay bare.
        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "as IEnumerable[IPerson]"));
    }

    [Fact]
    public void CollectionInitializer_BareKeyedAndIndexedElements_EmitAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static List<IEnumerable<IPerson>> BareElement(Author[] a) =>
                    new List<IEnumerable<IPerson>> { a };

                public static Dictionary<string, IEnumerable<IPerson>> KeyedElement(Author[] a) =>
                    new Dictionary<string, IEnumerable<IPerson>> { { "k", a } };

                public static Dictionary<string, IEnumerable<IPerson>> IndexedElement(Author[] a) =>
                    new Dictionary<string, IEnumerable<IPerson>> { ["k"] = a };
            }
            """);

        Assert.Equal(3, CountOccurrences(printed, "a as IEnumerable[IPerson]"));
    }

    [Fact]
    public void ObjectInitializer_MemberAssignment_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public sealed class Holder
            {
                public IEnumerable<IPerson> People { get; set; }
            }

            public static class Repro
            {
                public static Holder ObjectInit(Author[] a) => new Holder { People = a };
            }
            """);

        Assert.Contains("People: (a as IEnumerable[IPerson])", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CollectionExpression_ElementArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static List<IEnumerable<IPerson>> CollectionExprElement(Author[] a) => [a];
            }
            """);

        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayInitializer_ElementArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson>[] ArrayOfInterfaces(Author[] a, Author[] b) =>
                    new IEnumerable<IPerson>[] { a, b };
            }
            """);

        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
        Assert.Contains("b as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ImplicitArrayCreation_ElementArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson>[] ImplicitArrayOfInterfaces(Author[] a, IEnumerable<IPerson> b) =>
                    new[] { a, (IEnumerable<IPerson>)b };
            }
            """);

        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void WithExpression_MemberArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public sealed record PersonHolder(IEnumerable<IPerson> People);

            public static class Repro
            {
                public static PersonHolder WithExpr(PersonHolder original, Author[] a) =>
                    original with { People = a };
            }
            """);

        Assert.Contains("People = (a as IEnumerable[IPerson])", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void LambdaExpressionBody_ArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static Func<Author[], IEnumerable<IPerson>> LambdaFactory() => a => a;
            }
            """);

        Assert.Contains("a as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void FieldInitializer_ArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class FieldHolder
            {
                private static readonly Author[] source = new Author[] { new Author() };
                public static readonly IEnumerable<IPerson> field = source;
            }
            """);

        Assert.Contains("source as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleElement_ArrayCovariance_EmitsAsCast()
    {
        // Note: a tuple literal returned directly as an arrow-bodied function's
        // value (`(T1, T2) M(...) => (a, b);`) hits a pre-existing, unrelated
        // G# parser gap when the function's own return type is ALSO a tuple
        // type (confirmed independent of this fix — reproduces with plain
        // `int32` tuple elements and no `as` cast at all). Assigning the tuple
        // literal to a local first sidesteps that gap while still exercising
        // the same TupleExpressionSyntax element-translation sink.
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void TupleExample(Author[] a)
                {
                    (IEnumerable<IPerson> People, int Count) result = (a, a.Length);
                }
            }
            """);

        Assert.Contains("(a as IEnumerable[IPerson])", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void YieldReturn_ArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IEnumerable<IPerson>> YieldExample(Author[] a)
                {
                    yield return a;
                }
            }
            """);

        Assert.Contains("yield (a as IEnumerable[IPerson])", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DelegateInvocation_ArgumentArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void DelegateInvoke(Action<IEnumerable<IPerson>> action, Author[] a)
                {
                    action(a);
                }
            }
            """);

        Assert.Contains("action((a as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericClassConstrainedElementType_ArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static IEnumerable<IPerson> GenericElement<TPerson>(TPerson[] values)
                    where TPerson : class, IPerson
                    => values;
            }
            """);

        Assert.Contains("values as IEnumerable[IPerson]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedGenericTarget_ArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                public static void AcceptNested(IEnumerable<IReadOnlyList<IPerson>> values) { }
                public static void TestNested(IReadOnlyList<Author>[] values) => AcceptNested(values);
            }
            """);

        Assert.Contains(
            "Repro.AcceptNested((values as IEnumerable[IReadOnlyList[IPerson]]))",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayToArrayCovariance_EmitsAsCast()
    {
        string printed = Translate(SourceModel + """

            public class PersonBase { }
            public sealed class DerivedPerson : PersonBase { }

            public static class Repro
            {
                public static void AcceptArray(PersonBase[] values) { }
                public static void TestArray(DerivedPerson[] values) => AcceptArray(values);
            }
            """);

        Assert.Contains("Repro.AcceptArray((values as []PersonBase))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceElement_ImplementingMetadataInterface_ArrayCovariance_EmitsAsCast()
    {
        MetadataReference metadataLib = CompileMetadataLibrary();
        string printed = Translate("""
            using System.Collections.Generic;
            using Issue2516.Metadata;

            namespace Demo;

            public sealed class AuthorSource : IPerson { }

            public static class Repro
            {
                public static void Accept(IEnumerable<IPerson> values) { }
                public static void Test(AuthorSource[] values) => Accept(values);
            }
            """,
            NullableContextOptions.Disable,
            metadataLib);

        Assert.Contains("Repro.Accept((values as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MetadataElement_MetadataInterface_ArrayCovariance_EmitsAsCast()
    {
        MetadataReference metadataLib = CompileMetadataLibrary();
        string printed = Translate("""
            using System.Collections.Generic;
            using Issue2516.Metadata;

            namespace Demo;

            public static class Repro
            {
                public static void Accept(IEnumerable<IPerson> values) { }
                public static void Test(Author[] values) => Accept(values);
            }
            """,
            NullableContextOptions.Disable,
            metadataLib);

        Assert.Contains("Repro.Accept((values as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void EvaluationOnce_SideEffectingArrayExpression_TranslatedExactlyOnce()
    {
        string printed = Translate(SourceModel + """

            public static class Repro
            {
                private static int calls = 0;
                private static Author[] GetValues() { calls++; return new Author[0]; }

                public static void Accept(IEnumerable<IPerson> values) { }
                public static void Test() => Accept(GetValues());
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, "Repro.GetValues()"));
        Assert.Contains("Repro.Accept((Repro.GetValues() as IEnumerable[IPerson]))", printed, StringComparison.Ordinal);
    }

    private static MetadataReference CompileMetadataLibrary()
    {
        const string source = """
            namespace Issue2516.Metadata
            {
                public interface IPerson { }
                public sealed class Author : IPerson { }
            }
            """;

        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var compilation = CSharpCompilation.Create(
            "Issue2516.MetadataLib",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }

    private static string Translate(
        string source,
        NullableContextOptions nullableContext = NullableContextOptions.Disable,
        params MetadataReference[] additionalReferences)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Issue2516.Consumer",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences ?? Array.Empty<MetadataReference>()),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullableContext)
                .WithAllowUnsafe(true));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(translated);
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
