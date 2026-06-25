// <copyright file="L3TranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Targeted translation tests for the L3-Library constructs (issue #914,
/// ADR-0115 §B): lambdas, switch expressions, LINQ method/query syntax, async
/// methods with <c>await</c>, predefined-type static-call receivers, implicit
/// <c>new()</c>, extension-method lifting, and fieldless-record mapping. Each
/// genuine G# compiler gap (indexer, null-coalescing, bare-identifier index
/// member access, generic-interface constraint) is asserted to surface as a
/// clean <see cref="TranslationSeverity.Unsupported"/> diagnostic rather than
/// crashing or being silently dropped. Each test uses a uniquely named user
/// type so the snippets never collide within a single compilation.
/// </summary>
public class L3TranslationTests
{
    /// <summary>
    /// ADR-0115 §B.20: a C# simple lambda <c>n =&gt; n % 2 == 0</c> becomes the
    /// canonical G# arrow lambda with a parenthesized, typed parameter
    /// (<c>samples/ArrowLambda.gs</c>).
    /// </summary>
    [Fact]
    public void SimpleLambda_TranslatesToArrowLambda()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class LambdaHost
    {
        public static IEnumerable<int> Evens(IEnumerable<int> xs) => xs.Where(n => n % 2 == 0);
    }
}");

        Assert.Contains("(n int32) -> n % 2 == 0", printed);
        Assert.DoesNotContain("nil", printed);
    }

    /// <summary>
    /// ADR-0115 §B.20: LINQ method syntax stays as the instance/extension call
    /// chain (<c>samples/LinqExtensions.gs</c>).
    /// </summary>
    [Fact]
    public void LinqMethodChain_TranslatesToCallChain()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class ChainHost
    {
        public static int SumSquaresOfEvens(IEnumerable<int> numbers) =>
            numbers.Where(n => n % 2 == 0).Select(n => n * n).Sum();
    }
}");

        Assert.Contains(".Where((n int32) -> n % 2 == 0)", printed);
        Assert.Contains(".Select((n int32) -> n * n)", printed);
        Assert.Contains(".Sum()", printed);
    }

    /// <summary>
    /// ADR-0115 §B.21: C# LINQ query syntax has no canonical G# form, so it is
    /// lowered to the equivalent method-call chain Roslyn desugars it into
    /// (<c>from n in xs orderby n select n</c> → <c>xs.OrderBy(...)</c>).
    /// </summary>
    [Fact]
    public void QuerySyntax_LowersToMethodChain()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryHost
    {
        public static IEnumerable<int> Ordered(IEnumerable<int> numbers) =>
            from n in numbers orderby n select n;
    }
}");

        Assert.Contains(".OrderBy((n int32) -> n)", printed);
        Assert.DoesNotContain("from", printed);
    }

    /// <summary>
    /// ADR-0115 §B.22: a C# switch expression maps to the G# <c>switch</c>
    /// expression colon form, with type, relational, and constant patterns
    /// (<c>samples/SwitchExpression.gs</c>).
    /// </summary>
    [Fact]
    public void SwitchExpression_TranslatesToSwitchExpr()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract record ShapeX;
    public sealed record CircleX(double Radius) : ShapeX;
    public static class SwitchHost
    {
        public static double Area(ShapeX shape) => shape switch
        {
            CircleX c => 3.14 * c.Radius * c.Radius,
            _ => 0.0,
        };
        public static string Size(double area) => area switch
        {
            < 10.0 => ""small"",
            _ => ""large"",
        };
    }
}");

        Assert.Contains("switch shape {", printed);
        Assert.Contains("case c is CircleX:", printed);
        Assert.Contains("c.Radius", printed);
        Assert.Contains("default:", printed);
        Assert.Contains("case < 10.0:", printed);
    }

    /// <summary>
    /// ADR-0115 §B.23: a C# <c>async Task&lt;int&gt;</c> method declares the
    /// UNWRAPPED result type in G# (<c>int32</c>, not <c>Task[int32]</c>); the
    /// <c>async</c> modifier synthesizes the task envelope, and <c>await</c> is
    /// preserved (<c>samples/AsyncTask.gs</c>).
    /// </summary>
    [Fact]
    public void AsyncMethod_UnwrapsReturnTypeAndKeepsAwait()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Threading.Tasks;
    public static class AsyncHost
    {
        public static async Task<int> DoubleAsync(int n) => await Task.FromResult(n * 2);
    }
}");

        Assert.Contains("async func DoubleAsync(n int32) int32 {", printed);
        Assert.Contains("await Task.FromResult(n * 2)", printed);
        Assert.DoesNotContain("Task[int32] {", printed);
    }

    /// <summary>
    /// ADR-0115 §B.24: a predefined type used as a static-call receiver
    /// (<c>string.Concat(...)</c>) emits the BCL type name (<c>String</c>) so the
    /// receiver resolves.
    /// </summary>
    [Fact]
    public void PredefinedTypeReceiver_EmitsBclTypeName()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    public static class ConcatHost
    {
        public static string Join(IEnumerable<string> parts) => string.Concat(parts);
    }
}");

        Assert.Contains("String.Concat(parts)", printed);
        Assert.DoesNotContain("nil", printed);
    }

    /// <summary>
    /// ADR-0115 §B.25: a C# target-typed <c>new()</c> emits the explicit
    /// constructed type (<c>List[int32]()</c>).
    /// </summary>
    [Fact]
    public void ImplicitObjectCreation_EmitsExplicitType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    public sealed class NewHost
    {
        private readonly List<int> items = new();
        public int Count => this.items.Count;
    }
}");

        Assert.Contains("List[int32]()", printed);
    }

    /// <summary>
    /// Issue #988 / ADR-0115 §G #988: a C# generic constrained with
    /// <c>where T : new()</c> that constructs its parameter via <c>new T()</c>
    /// translates to the canonical G# <c>[T init()]</c> constraint and the
    /// call-like construction <c>T()</c> (which now compiles against gsc).
    /// (The G# constraint keyword was renamed from <c>new()</c> to <c>init()</c>
    /// by issue #997; the C# source still spells it <c>new()</c>.)
    /// </summary>
    [Fact]
    public void NewConstraintConstruction_EmitsInitConstraintAndCallLikeConstruction()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Factory<T> where T : new()
    {
        public T Make() { return new T(); }
    }
}");

        Assert.Contains("init()", printed);
        Assert.Contains("T()", printed);
    }

    /// <summary>
    /// ADR-0115 §B.5: a C# extension method on a <c>static class</c> is lifted to
    /// a top-level receiver-clause <c>func</c>, and a static class whose every
    /// member is lifted is dropped entirely (a receiver-clause func binds only at
    /// top level).
    /// </summary>
    [Fact]
    public void ExtensionMethod_LiftsToTopLevelAndDropsStaticClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class StringExtras
    {
        public static int WordLen(this string value) => value.Length;
    }
}");

        Assert.Contains("func (value string) WordLen() int32 {", printed);
        Assert.DoesNotContain("class StringExtras", printed);
        Assert.DoesNotContain("shared {", printed);
    }

    /// <summary>
    /// ADR-0115 §B.4: a fieldless C# record (typically an <c>abstract record</c>
    /// hierarchy base) maps to a plain <c>class</c> — a G# <c>data</c> type
    /// requires at least one field (GS0104) — and is marked <c>open</c> when
    /// subclassed; the C# <c>abstract</c> modifier and the synthesized
    /// <c>IEquatable&lt;Self&gt;</c> interface are dropped (a class cannot name
    /// itself in its own base list).
    /// </summary>
    [Fact]
    public void FieldlessRecord_MapsToOpenClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract record ShapeBase;
    public sealed record Dot(double X) : ShapeBase;
}");

        Assert.Contains("open class ShapeBase {", printed);
        Assert.DoesNotContain("abstract", printed);
        Assert.DoesNotContain("IEquatable", printed);
        Assert.Contains("data class Dot(X float64) : ShapeBase", printed);
    }

    /// <summary>
    /// ADR-0118 / issue #944 (resolves the ADR-0115 §B.11 gap): a C# indexer
    /// now maps to the canonical G# indexer member (<c>prop this[i int32] T</c>),
    /// so it no longer surfaces as an unsupported diagnostic.
    /// </summary>
    [Fact]
    public void Indexer_TranslatesToCanonicalIndexerMember()
    {
        string translated = TranslateUnit(@"
namespace Demo
{
    public sealed class IndexHost
    {
        private readonly int[] data = new int[4];
        public int this[int i] => this.data[i];
    }
}");

        Assert.Contains("prop this[i int32] int32", translated);
    }

    [Fact]
    public void Indexer_DoesNotSurfaceAsUnsupported()
    {
        TranslationContext context = TranslateForDiagnostics(@"
namespace Demo
{
    public sealed class IndexHost
    {
        private readonly int[] data = new int[4];
        public int this[int i] => this.data[i];
    }
}");

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.IsUnsupported && d.ConstructKind == "IndexerDeclaration");
    }

    /// <summary>
    /// Issue #941: the C# null-coalescing operator <c>??</c> now maps directly
    /// to G#'s <c>??</c> operator (the former <c>?:</c> gap is resolved).
    /// </summary>
    [Fact]
    public void NullCoalescing_TranslatesToQuestionQuestion()
    {
        string translated = TranslateUnit(@"
namespace Demo
{
    public static class CoalesceHost
    {
        public static string OrElse(string value, string fallback) => value ?? fallback;
    }
}");

        Assert.Contains("value ?? fallback", translated);
    }

    /// <summary>
    /// Issue #942 (was an ADR-0115 §B gap): member access on a bare-identifier
    /// element access (<c>values[i].M</c>) used to hit a G# parser ambiguity;
    /// that gap is now fixed, so the translator emits it through the normal
    /// member-access path rather than a placeholder.
    /// </summary>
    [Fact]
    public void BareIndexMemberAccess_TranslatesThroughNormalPath()
    {
        (string printed, TranslationContext context) = Translate(@"
namespace Demo
{
    using System.Collections.Generic;
    public static class IndexMemberHost
    {
        public static int FirstLen(IReadOnlyList<string> values)
        {
            int i = 0;
            return values[i].Length;
        }
    }
}");

        Assert.Contains("values[i].Length", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.IsUnsupported && d.ConstructKind == "SimpleMemberAccessExpression");
    }

    /// <summary>
    /// Issue #943 (was an ADR-0115 §B.7 gap): a constructed generic-interface
    /// constraint (<c>where T : IComparable&lt;T&gt;</c>) now has a canonical G#
    /// form — <c>[T IComparable[T]]</c> — so the translator emits it into the
    /// legacy constraint slot rather than dropping it.
    /// </summary>
    [Fact]
    public void GenericInterfaceConstraint_EmitsBracketedConstraint()
    {
        (string printed, TranslationContext context) = Translate(@"
namespace Demo
{
    using System;
    using System.Collections.Generic;
    public static class ConstraintHost
    {
        public static T Largest<T>(IReadOnlyList<T> values)
            where T : IComparable<T>
        {
            return values[0];
        }
    }
}");

        Assert.Contains("[T IComparable[T]]", printed);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.IsUnsupported && d.ConstructKind == "TypeParameterConstraintClause");
    }

    private static string TranslateUnit(string source)
    {
        (string printed, _) = Translate(source);
        return printed;
    }

    private static TranslationContext TranslateForDiagnostics(string source)
    {
        (_, TranslationContext context) = Translate(source);
        return context;
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
