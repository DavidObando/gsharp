// <copyright file="Issue2373ExpressionTreeComparisonOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

/// Issue #2373: `ExpressionTreeLowerer.BuildClrBinaryOperatorExpression`
/// looked up a single 3-arg `(Expression, Expression, MethodInfo)`
/// (cref:System.Linq.Expressions.Expression) factory overload for every
/// CLR-resolved binary operator (Stream C — a binary operator whose LEFT or
/// RIGHT operand's CLR type owns a public static `op_*` method, reached
/// only once G#'s built-in operator table has no arm for the operand types).
/// That 3-arg overload exists for arithmetic/bitwise/shift/logical factories,
/// but the six relational/equality factories (`Equal`/`NotEqual`/
/// `LessThan`/`LessThanOrEqual`/`GreaterThan`/
/// `GreaterThanOrEqual`) only expose a 4-arg `(Expression, Expression,
/// bool liftToNull, MethodInfo)` overload, so reflection returned
/// `null` and compilation crashed with GS9998
/// ((cref:System.InvalidOperationException): "Required method
/// '...Expression.Equal' is not available.").
///
/// Stream C is reached whenever the operand types are NOT covered by G#'s
/// built-in operator table (only G#'s own primitives, `string`, and
/// `bool` are registered there) — (cref:System.TimeSpan) is the
/// canonical example (also called out by `ClrOperatorResolution`'s own
/// doc comments), and any user-operator-bearing struct/class imported from a
/// SEPARATE assembly reaches Stream C too, because Stream D (the
/// same-compilation `func (a T) operator ==(b T) bool` receiver form)
/// only matches G#'s own `StructSymbol`s, not imported types — an
/// imported type's `op_Equality` etc. is only found via Stream C's raw
/// reflection lookup. This is exactly the shape Oahu.Diagnostics hit: an
/// EF-Core-imported entity's comparison against a value read outside G#'s
/// built-in table.
open class Issue2373ExpressionTreeComparisonOverloadTests {
    @Theory
    @InlineData("==")
    @InlineData("!=")
    @InlineData("<")
    @InlineData("<=")
    @InlineData(">")
    @InlineData(">=")
    func ClrStructComparison_AllSixOperators_LowersWithoutCrash(op string) {
        let source = (`import System
import System.Linq.Expressions

func Predicate(other TimeSpan) Expression[Func[TimeSpan, bool]] {
    return (t TimeSpan) -> t ` + "$op" + ` other
}`)
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Theory
    @InlineData("==")
    @InlineData("!=")
    @InlineData("<")
    @InlineData("<=")
    @InlineData(">")
    @InlineData(">=")
    func ClrStructComparison_NullableLeftOperand_LowersWithoutCrash(op string) {
        // Nullable/lifted operand coverage: `TimeSpan?` on the left compared
        // against a non-nullable `TimeSpan` — C#/Roslyn always passes
        // `liftToNull: false` here (the comparison RESULT is plain `bool`,
        // never `bool?`), which this fix hard-codes.
        let source = (`import System
import System.Linq.Expressions

func Predicate(t TimeSpan?, other TimeSpan) Expression[Func[bool]] {
    return () -> t ` + "$op" + ` other
}`)
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Theory
    @InlineData("==")
    @InlineData("!=")
    @InlineData("<")
    @InlineData("<=")
    @InlineData(">")
    @InlineData(">=")
    func ClrStructComparison_BothOperandsNullable_LowersWithoutCrash(op string) {
        let source = (`import System
import System.Linq.Expressions

func Predicate(t TimeSpan?, other TimeSpan?) Expression[Func[bool]] {
    return () -> t ` + "$op" + ` other
}`)
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ClrArithmeticAndUnaryFactories_SiblingAudit_StillLowerCorrectly() {
        // Sibling audit control: arithmetic (3-arg factory) and unary (2-arg
        // factory) CLR-operator lowering must be unaffected by the
        // comparison-only fix.
        let source = `import System
import System.Linq.Expressions

func Sum(other TimeSpan) Expression[Func[TimeSpan, TimeSpan]] {
    return (t TimeSpan) -> t + other
}

func Difference(other TimeSpan) Expression[Func[TimeSpan, TimeSpan]] {
    return (t TimeSpan) -> t - other
}`
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func SourceDeclaredStructOperator_StreamD_UnaffectedControl() {
        // Control: a SAME-COMPILATION struct's user `operator ==` binds via
        // Stream D (BoundUserInstanceCallExpression), never reaching the
        // CLR-operator lowering path this issue fixes. Must keep working.
        let source = `import System
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
}`
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func GenericExpressionTreeDelegate_ClrComparisonOperand_LowersWithoutCrash() {
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
        let source = `import System
import System.Linq.Expressions

class Box[T] {
    func Filter(predicate Expression[Func[T, bool]]) Expression[Func[T, bool]] {
        return predicate
    }
}

func Run(box Box[TimeSpan], other TimeSpan) Expression[Func[TimeSpan, bool]] {
    return box.Filter((t TimeSpan) -> t == other)
}`
        let result = Compile(source)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ImportedUserDefinedStructOperator_ReachesClrFallback_LowersWithoutCrash() {
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
        let libraryPath = EmitCSharpLibrary("ImportedUserDefinedStructOperator_ReachesClrFallback_LowersWithoutCrash", `namespace Lib
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
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Demo
import Lib
import System
import System.Linq.Expressions

func Predicate(asin Asin) Expression[Func[Book, bool]] {
    return (b Book) -> b.Asin == asin
}`))){IsLibrary = true}
        using let consumerStream = MemoryStream()
        let consumerResult = consumer.Emit(
            consumerStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2373Binder.Consumer"
        )
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
    }

    @Fact
    func UndefinedOperator_NegativeControl_StillReportsGs0129() {
        // Negative control: two imported CLR types with no built-in table
        // arm AND no `op_*` method in common must still fail with GS0129,
        // not silently succeed or crash differently, after the fix.
        let source = `import System
import System.Linq.Expressions

func Predicate(g Guid, t TimeSpan) Expression[Func[bool]] {
    return () -> g == t
}`
        let result = Compile(source)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func AmbiguousOperator_NegativeControl_StillReportsAmbiguity() {
        // Negative/ambiguity control: two imported struct types that mutually
        // implicitly convert to one another, each declaring an `operator ==`
        // over its own type, produce a genuine tie for Stream C's combined
        // candidate set — comparing an A against a B needs exactly one
        // implicit conversion either way, so neither op_Equality(A,A) nor
        // op_Equality(B,B) is a strictly better match. Must surface the
        // ambiguous-overload diagnostic (never GS9998, never a silent pick).
        let libraryPath = EmitCSharpLibrary("AmbiguousOperator_NegativeControl_StillReportsAmbiguity", `namespace Lib
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
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Demo
import Lib
import System.Linq.Expressions

func Predicate(a A, b B) Expression[Func[bool]] {
    return () -> a == b
}`))){IsLibrary = true}
        using let consumerStream = MemoryStream()
        let consumerResult = consumer.Emit(
            consumerStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2373Binder.Ambiguous"
        )
        Assert.False(consumerResult.Success)
        Assert.Contains(consumerResult.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0160")
    }

    shared {
        private func Compile(source string)(
            Success bool,
            Diagnostics IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic]
        ) {
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2373Binder")
            return (result.Success, result.Diagnostics.AsEnumerable())
        }

        private func EmitCSharpLibrary(caseName string, csharpSource string) string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2373", caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2373.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib2373_" + caseName,
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
