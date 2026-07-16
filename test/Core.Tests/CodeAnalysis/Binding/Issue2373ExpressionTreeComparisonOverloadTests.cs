// <copyright file="Issue2373ExpressionTreeComparisonOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2373: <c>ExpressionTreeLowerer.BuildClrBinaryOperatorExpression</c>
/// looked up a single 3-arg <c>(Expression, Expression, MethodInfo)</c>
/// <see cref="System.Linq.Expressions.Expression"/> factory overload for every
/// CLR-resolved binary operator (Stream C — a binary operator whose LEFT or
/// RIGHT operand's CLR type owns a public static <c>op_*</c> method, reached
/// only once G#'s built-in operator table has no arm for the operand types).
/// That 3-arg overload exists for arithmetic/bitwise/shift/logical factories,
/// but the six relational/equality factories (<c>Equal</c>/<c>NotEqual</c>/
/// <c>LessThan</c>/<c>LessThanOrEqual</c>/<c>GreaterThan</c>/
/// <c>GreaterThanOrEqual</c>) only expose a 4-arg <c>(Expression, Expression,
/// bool liftToNull, MethodInfo)</c> overload, so reflection returned
/// <see langword="null"/> and compilation crashed with GS9998
/// (<see cref="System.InvalidOperationException"/>: "Required method
/// '...Expression.Equal' is not available.").
///
/// Stream C is reached whenever the operand types are NOT covered by G#'s
/// built-in operator table (only G#'s own primitives, <c>string</c>, and
/// <c>bool</c> are registered there) — <see cref="System.TimeSpan"/> is the
/// canonical example (also called out by <c>ClrOperatorResolution</c>'s own
/// doc comments), and any user-operator-bearing struct/class imported from a
/// SEPARATE assembly reaches Stream C too, because Stream D (the
/// same-compilation <c>func (a T) operator ==(b T) bool</c> receiver form)
/// only matches G#'s own <c>StructSymbol</c>s, not imported types — an
/// imported type's <c>op_Equality</c> etc. is only found via Stream C's raw
/// reflection lookup. This is exactly the shape Oahu.Diagnostics hit: an
/// EF-Core-imported entity's comparison against a value read outside G#'s
/// built-in table.
/// </summary>
public class Issue2373ExpressionTreeComparisonOverloadTests
{
    [Theory]
    [InlineData("==")]
    [InlineData("!=")]
    [InlineData("<")]
    [InlineData("<=")]
    [InlineData(">")]
    [InlineData(">=")]
    public void ClrStructComparison_AllSixOperators_LowersWithoutCrash(string op)
    {
        var source = $$"""
            import System
            import System.Linq.Expressions

            func Predicate(other TimeSpan) Expression[Func[TimeSpan, bool]] {
                return (t TimeSpan) -> t {{op}} other
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Theory]
    [InlineData("==")]
    [InlineData("!=")]
    [InlineData("<")]
    [InlineData("<=")]
    [InlineData(">")]
    [InlineData(">=")]
    public void ClrStructComparison_NullableLeftOperand_LowersWithoutCrash(string op)
    {
        // Nullable/lifted operand coverage: `TimeSpan?` on the left compared
        // against a non-nullable `TimeSpan` — C#/Roslyn always passes
        // `liftToNull: false` here (the comparison RESULT is plain `bool`,
        // never `bool?`), which this fix hard-codes.
        var source = $$"""
            import System
            import System.Linq.Expressions

            func Predicate(t TimeSpan?, other TimeSpan) Expression[Func[bool]] {
                return () -> t {{op}} other
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Theory]
    [InlineData("==")]
    [InlineData("!=")]
    [InlineData("<")]
    [InlineData("<=")]
    [InlineData(">")]
    [InlineData(">=")]
    public void ClrStructComparison_BothOperandsNullable_LowersWithoutCrash(string op)
    {
        var source = $$"""
            import System
            import System.Linq.Expressions

            func Predicate(t TimeSpan?, other TimeSpan?) Expression[Func[bool]] {
                return () -> t {{op}} other
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ClrArithmeticAndUnaryFactories_SiblingAudit_StillLowerCorrectly()
    {
        // Sibling audit control: arithmetic (3-arg factory) and unary (2-arg
        // factory) CLR-operator lowering must be unaffected by the
        // comparison-only fix.
        var source = """
            import System
            import System.Linq.Expressions

            func Sum(other TimeSpan) Expression[Func[TimeSpan, TimeSpan]] {
                return (t TimeSpan) -> t + other
            }

            func Difference(other TimeSpan) Expression[Func[TimeSpan, TimeSpan]] {
                return (t TimeSpan) -> t - other
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void SourceDeclaredStructOperator_StreamD_UnaffectedControl()
    {
        // Control: a SAME-COMPILATION struct's user `operator ==` binds via
        // Stream D (BoundUserInstanceCallExpression), never reaching the
        // CLR-operator lowering path this issue fixes. Must keep working.
        var source = """
            import System
            import System.Linq.Expressions

            struct Vector2 {
                var X int32
                var Y int32
            }

            func (a Vector2) operator ==(b Vector2) bool {
                return a.X == b.X && a.Y == b.Y
            }

            func Predicate(other Vector2) Expression[Func[Vector2, bool]] {
                return (v Vector2) -> v == other
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void GenericExpressionTreeDelegate_ClrComparisonOperand_LowersWithoutCrash()
    {
        // Generic expression-tree delegate coverage: the lambda itself is
        // written against a concrete Stream-C-triggering CLR type (TimeSpan,
        // never an unconstrained type parameter — G# has no operator
        // constraint syntax, so `t == other` inside an open `T` body is
        // correctly rejected), but the delegate TYPE flowing through it is
        // generic (`Expression[Func[T, bool]]`) and gets closed over `T =
        // TimeSpan` via ordinary generic-method type inference at the call
        // site — exactly the shape of a generic imported repository/query
        // method (like EF Core's `MigrationBuilder.CreateTable<TColumns>`)
        // forwarding a caller-supplied predicate.
        var source = """
            import System
            import System.Linq.Expressions

            class Box[T] {
                func Filter(predicate Expression[Func[T, bool]]) Expression[Func[T, bool]] {
                    return predicate
                }
            }

            func Run(box Box[TimeSpan], other TimeSpan) Expression[Func[TimeSpan, bool]] {
                return box.Filter((t TimeSpan) -> t == other)
            }
            """;

        var result = Compile(source);
        Assert.True(result.Success, string.Join(System.Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ImportedUserDefinedStructOperator_ReachesClrFallback_LowersWithoutCrash()
    {
        // Issue #2373's actual shape: a value-type "Asin"-like wrapper
        // (a common EF-Core "strongly typed ID" pattern) declaring its own
        // `operator ==`/`!=`/`<`/`<=`/`>`/`>=`, imported from a SEPARATE,
        // REAL C#-compiled assembly (mirroring Oahu.Diagnostics: a genuine
        // externally-compiled CLR type, not a G#-authored one — G#'s own
        // `func (a T) operator` receiver-form methods are not currently
        // emitted with the CLR-conventional `public static ... op_Equality`
        // shape, so they cannot participate in Stream C at all; that is a
        // separate, pre-existing G#-emission gap unrelated to this issue's
        // Expression-factory overload-selection defect, called out in the
        // PR description as deferred follow-up work). Stream D's
        // same-compilation `StructSymbol` check cannot see an imported type
        // either way, so comparison MUST resolve via Stream C's raw CLR
        // `op_*` reflection, exactly like Oahu.Diagnostics' imported
        // `Book.Asin` comparison.
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedUserDefinedStructOperator_ReachesClrFallback_LowersWithoutCrash),
            """
            namespace Lib
            {
                public readonly struct Asin
                {
                    public string Value { get; }
                    public Asin(string value) => Value = value;
                    public static bool operator ==(Asin a, Asin b) => a.Value == b.Value;
                    public static bool operator !=(Asin a, Asin b) => a.Value != b.Value;
                    public static bool operator <(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) < 0;
                    public static bool operator <=(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) <= 0;
                    public static bool operator >(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) > 0;
                    public static bool operator >=(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) >= 0;
                    public override bool Equals(object obj) => obj is Asin o && o.Value == Value;
                    public override int GetHashCode() => Value?.GetHashCode() ?? 0;
                }

                public class Book
                {
                    public Asin Asin { get; set; }
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib
                import System
                import System.Linq.Expressions

                func Predicate(asin Asin) Expression[Func[Book, bool]] {
                    return (b Book) -> b.Asin == asin
                }
                """)))
        {
            IsLibrary = true,
        };

        using var consumerStream = new MemoryStream();
        var consumerResult = consumer.Emit(consumerStream, pdbStream: null, refStream: null, assemblyName: "Issue2373Binder.Consumer");
        Assert.True(consumerResult.Success, string.Join(System.Environment.NewLine, consumerResult.Diagnostics));
    }

    [Fact]
    public void UndefinedOperator_NegativeControl_StillReportsGs0129()
    {
        // Negative control: two imported CLR types with no built-in table
        // arm AND no `op_*` method in common must still fail with GS0129,
        // not silently succeed or crash differently, after the fix.
        var source = """
            import System
            import System.Linq.Expressions

            func Predicate(g Guid, t TimeSpan) Expression[Func[bool]] {
                return () -> g == t
            }
            """;

        var result = Compile(source);
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void AmbiguousOperator_NegativeControl_StillReportsAmbiguity()
    {
        // Negative/ambiguity control: two imported struct types that mutually
        // implicitly convert to one another, each declaring an `operator ==`
        // over its own type, produce a genuine tie for Stream C's combined
        // candidate set — comparing an A against a B needs exactly one
        // implicit conversion either way, so neither op_Equality(A,A) nor
        // op_Equality(B,B) is a strictly better match. Must surface the
        // ambiguous-overload diagnostic (never GS9998, never a silent pick).
        var libraryPath = EmitCSharpLibrary(
            nameof(this.AmbiguousOperator_NegativeControl_StillReportsAmbiguity),
            """
            namespace Lib
            {
                public struct A
                {
                    public static bool operator ==(A a, A b) => true;
                    public static bool operator !=(A a, A b) => false;
                    public static implicit operator A(B b) => default;
                    public override bool Equals(object obj) => false;
                    public override int GetHashCode() => 0;
                }

                public struct B
                {
                    public static bool operator ==(B a, B b) => true;
                    public static bool operator !=(B a, B b) => false;
                    public static implicit operator B(A a) => default;
                    public override bool Equals(object obj) => false;
                    public override int GetHashCode() => 0;
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib
                import System.Linq.Expressions

                func Predicate(a A, b B) Expression[Func[bool]] {
                    return () -> a == b
                }
                """)))
        {
            IsLibrary = true,
        };

        using var consumerStream = new MemoryStream();
        var consumerResult = consumer.Emit(consumerStream, pdbStream: null, refStream: null, assemblyName: "Issue2373Binder.Ambiguous");
        Assert.False(consumerResult.Success);
        Assert.Contains(consumerResult.Diagnostics, d => d.Id == "GS0160");
    }

    private static (bool Success, System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics) Compile(string source)
    {
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2373Binder");
        return (result.Success, result.Diagnostics.AsEnumerable());
    }

    private static string EmitCSharpLibrary(string caseName, string csharpSource)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2373", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2373.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CSharpLib2373_" + caseName,
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(System.Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
