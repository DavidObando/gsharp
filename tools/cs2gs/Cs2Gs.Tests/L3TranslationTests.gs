// <copyright file="L3TranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Targeted translation tests for the L3-Library constructs (issue #914,
/// ADR-0115 §B): lambdas, switch expressions, LINQ method/query syntax, async
/// methods with `await`, predefined-type static-call receivers, implicit
/// `new()`, extension-method lifting, and fieldless-record mapping. Each
/// genuine G# compiler gap (indexer, null-coalescing, bare-identifier index
/// member access, generic-interface constraint) is asserted to surface as a
/// clean (cref:TranslationSeverity.Unsupported) diagnostic rather than
/// crashing or being silently dropped. Each test uses a uniquely named user
/// type so the snippets never collide within a single compilation.
open class L3TranslationTests {
    /// ADR-0115 §B.20: a C# simple lambda `n => n % 2 == 0` becomes the
    /// canonical G# arrow lambda with a parenthesized, typed parameter
    /// (`samples/ArrowLambda.gs`).
    @Fact
    func SimpleLambda_TranslatesToArrowLambda() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class LambdaHost
    {
        public static IEnumerable<int> Evens(IEnumerable<int> xs) => xs.Where(n => n % 2 == 0);
    }
}`)
        Assert.Contains("(n int32) -> n % 2 == 0", printed)
        Assert.DoesNotContain("nil", printed)
    }

    /// ADR-0115 §B.20: LINQ method syntax stays as the instance/extension call
    /// chain (`samples/LinqExtensions.gs`).
    @Fact
    func LinqMethodChain_TranslatesToCallChain() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class ChainHost
    {
        public static int SumSquaresOfEvens(IEnumerable<int> numbers) =>
            numbers.Where(n => n % 2 == 0).Select(n => n * n).Sum();
    }
}`)
        Assert.Contains(".Where((n int32) -> n % 2 == 0)", printed)
        Assert.Contains(".Select((n int32) -> n * n)", printed)
        Assert.Contains(".Sum()", printed)
    }

    /// ADR-0115 §B.21: C# LINQ query syntax has no canonical G# form, so it is
    /// lowered to the equivalent method-call chain Roslyn desugars it into
    /// (`from n in xs orderby n select n` → `xs.OrderBy(...)`).
    @Fact
    func QuerySyntax_LowersToMethodChain() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryHost
    {
        public static IEnumerable<int> Ordered(IEnumerable<int> numbers) =>
            from n in numbers orderby n select n;
    }
}`)
        Assert.Contains(".OrderBy((n int32) -> n)", printed)
        Assert.DoesNotContain("from", printed)
    }

    /// Issue #1738: a query continuation (`... into y ...`) is C#'s own
    /// sugar for `from y in (...) ...` (C# spec §12.20.3); the translator
    /// must lower both halves rather than silently dropping the continuation's
    /// clauses (`where y > 0 select y` was previously lost entirely).
    @Fact
    func QueryContinuation_LowersBothHalvesOfQuery() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryContinuationHost
    {
        public static IEnumerable<int> DoubledPositives(IEnumerable<int> numbers) =>
            from n in numbers select n * 2 into y where y > 0 select y;
    }
}`)
        Assert.Contains(".Select((n int32) -> n * 2)", printed)
        Assert.Contains(".Where((y int32) -> y > 0)", printed)
        Assert.DoesNotContain("from", printed)
    }

    /// Issue #1738: a query over an array must type the range variable as the
    /// array's element type (`string`), not the former placeholder
    /// (`object`) an array (a non-(cref:INamedTypeSymbol) source)
    /// used to fall back to.
    @Fact
    func QueryOverArray_TypesRangeVariableAsElementType() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Linq;
    public static class QueryArrayHost
    {
        public static int[] Lengths(string[] words) =>
            (from w in words select w.Length).ToArray();
    }
}`)
        Assert.Contains(".Select((w string) -> w.Length)", printed)
    }

    /// Issue #1738: a query over a dictionary must type the range variable as
    /// `KeyValuePair<TKey, TValue>` (the element type
    /// `IEnumerable<KeyValuePair<K,V>>` yields), not the
    /// dictionary's key type (the former "first generic type argument" guess).
    @Fact
    func QueryOverDictionary_TypesRangeVariableAsKeyValuePair() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryDictionaryHost
    {
        public static IEnumerable<string> Keys(Dictionary<string, int> map) =>
            from kv in map select kv.Key;
    }
}`)
        Assert.Contains("KeyValuePair", printed)
        Assert.Contains("kv.Key", printed)
    }

    /// Issue #1738 regression: a query over a plain `IEnumerable<T>`
    /// source (the common case, already correctly typed before this fix) must
    /// keep working after generalizing range-variable typing to
    /// `GetEnumerableElementType`.
    @Fact
    func QueryOverIEnumerable_StillTypesRangeVariableCorrectly() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryEnumerableHost
    {
        public static IEnumerable<int> Evens(IEnumerable<int> numbers) =>
            from n in numbers where n % 2 == 0 select n * n;
    }
}`)
        Assert.Contains(".Where((n int32) -> n % 2 == 0)", printed)
        Assert.Contains(".Select((n int32) -> n * n)", printed)
    }

    @Fact
    func QueryOverPatternProvider_UsesItsSingleTypeArgument() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;
    public sealed class Query<T>
    {
        public Query<TResult> Select<TResult>(Func<T, TResult> selector) =>
            new Query<TResult>();
    }
    public static class QueryPatternHost
    {
        public static Query<int> Increment(Query<int> numbers) =>
            from n in numbers select n + 1;
    }
}`)
        Assert.Contains(".Select((n int32) -> n + 1)", printed)
    }

    /// Issue #1738 originally required a `group ... by ...` feeding an
    /// `into` continuation to surface a visible (cref:TranslationSeverity.Unsupported) diagnostic rather
    /// than being
    /// silently miscompiled or dropped, since no lowering existed yet. Issue
    /// #1902 generalizes the query-clause lowering to cover exactly this
    /// case: `group ... by ...` lowers to `.GroupBy(...)` and the
    /// `into` continuation re-scopes the chain to the group variable
    /// (here a passthrough `select g`), so this must now translate
    /// cleanly with no diagnostics.
    @Fact
    func GroupByContinuation_LowersToGroupByWithSelectContinuation() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;
    public static class QueryGroupHost
    {
        public static IEnumerable<IGrouping<int, int>> ByParity(IEnumerable<int> numbers) =>
            from n in numbers group n by n % 2 into g select g;
    }
}`)
        Assert.Contains("numbers.GroupBy((n int32) -> n % 2)", printed)
    }

    /// ADR-0115 §B.22: a C# switch expression maps to the G# `switch`
    /// expression colon form, with type, relational, and constant patterns
    /// (`samples/SwitchExpression.gs`).
    @Fact
    func SwitchExpression_TranslatesToSwitchExpr() {
        let printed = TranslateUnit(`
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
            < 10.0 => "small",
            _ => "large",
        };
    }
}`)
        Assert.Contains("switch shape {", printed)
        Assert.Contains("case c is CircleX:", printed)
        Assert.Contains("c.Radius", printed)
        Assert.Contains("default:", printed)
        Assert.Contains("case < 10.0:", printed)
    }

    /// ADR-0115 §B.23: a C# `async Task<int>` method declares the
    /// UNWRAPPED result type in G# (`int32`, not `Task[int32]`); the
    /// `async` modifier synthesizes the task envelope, and `await` is
    /// preserved (`samples/AsyncTask.gs`).
    @Fact
    func AsyncMethod_UnwrapsReturnTypeAndKeepsAwait() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Threading.Tasks;
    public static class AsyncHost
    {
        public static async Task<int> DoubleAsync(int n) => await Task.FromResult(n * 2);
    }
}`)
        Assert.Contains("async func DoubleAsync(n int32) int32 -> await Task.FromResult(n * 2)", printed)
        Assert.Contains("await Task.FromResult(n * 2)", printed)
        Assert.DoesNotContain("Task[int32] {", printed)
    }

    /// ADR-0115 §B.24: a predefined type used as a static-call receiver
    /// (`string.Concat(...)`) keeps the canonical G# type name.
    @Fact
    func PredefinedTypeReceiver_EmitsCanonicalTypeName() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    public static class ConcatHost
    {
        public static string Join(IEnumerable<string> parts) => string.Concat(parts);
    }
}`)
        Assert.Contains("string.Concat(parts)", printed)
        Assert.DoesNotContain("nil", printed)
    }

    /// ADR-0115 §B.25: a C# target-typed `new()` emits the explicit
    /// constructed type (`List[int32]()`).
    @Fact
    func ImplicitObjectCreation_EmitsExplicitType() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    public sealed class NewHost
    {
        private readonly List<int> items = new();
        public int Count => this.items.Count;
    }
}`)
        Assert.Contains("List[int32]()", printed)
    }

    /// Issue #988 / ADR-0115 §G #988: a C# generic constrained with
    /// `where T : new()` that constructs its parameter via `new T()`
    /// translates to the canonical G# `[T init()]` constraint and the
    /// call-like construction `T()` (which now compiles against gsc).
    /// (The G# constraint keyword was renamed from `new()` to `init()`
    /// by issue #997; the C# source still spells it `new()`.)
    @Fact
    func NewConstraintConstruction_EmitsInitConstraintAndCallLikeConstruction() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Factory<T> where T : new()
    {
        public T Make() { return new T(); }
    }
}`)
        Assert.Contains("init()", printed)
        Assert.Contains("T()", printed)
    }

    /// ADR-0115 §B.5, updated by issue #4234: a C# extension method on a
    /// `static class` is lifted to a top-level receiver-clause
    /// `func` (a receiver-clause func binds only at top level), but the
    /// static class is no longer dropped — it survives, empty, tagged with
    /// an `@ExtensionOwner(typeof(T))` back-reference on the lifted
    /// func, so gsc can host the self-hosted MethodDef on the class's own
    /// TypeDef instead of the package's `<Program>`. This keeps a
    /// migrated runtime's metadata shape (owner-type identity for reflection
    /// and analyzer checks) matching the native C# assembly's.
    @Fact
    func ExtensionMethod_LiftsToTopLevelAndKeepsStaticClassForOwnerIdentity() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class StringExtras
    {
        public static int WordLen(this string value) => value.Length;
    }
}`)
        Assert.Contains("class StringExtras {\n}", printed)
        Assert.Contains("@ExtensionOwner(typeof(StringExtras))", printed)
        Assert.Contains("func (value string) WordLen() int32 -> value.Length", printed)
        Assert.DoesNotContain("shared {", printed)
    }

    /// ADR-0115 §B.4: a fieldless C# record with no positional parameters
    /// maps to a zero-field `abstract data class`. The C# abstractness is
    /// preserved and suppresses `open`; the generated
    /// `IEquatable<Self>` interface is preserved for ABI parity.
    @Fact
    func FieldlessRecord_MapsToAbstractDataClass() {
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract record ShapeBase;
    public sealed record Dot(double X) : ShapeBase;
}`)
        Assert.Contains("abstract data class ShapeBase", printed)
        Assert.DoesNotContain("open data class ShapeBase", printed)
        Assert.Contains("IEquatable[ShapeBase]", printed)
        Assert.Contains("IEquatable[Dot]", printed)
        Assert.Contains("data class Dot(X float64) : ShapeBase", printed)
    }

    /// ADR-0118 / issue #944 (resolves the ADR-0115 §B.11 gap): a C# indexer
    /// now maps to the canonical G# indexer member (`prop this[i int32] T`),
    /// so it no longer surfaces as an unsupported diagnostic.
    @Fact
    func Indexer_TranslatesToCanonicalIndexerMember() {
        let translated = TranslateUnit(`
namespace Demo
{
    public sealed class IndexHost
    {
        private readonly int[] data = new int[4];
        public int this[int i] => this.data[i];
    }
}`)
        Assert.Contains("prop this[i int32] int32", translated)
    }

    @Fact
    func Indexer_DoesNotSurfaceAsUnsupported() {
        let context = TranslateForDiagnostics(`
namespace Demo
{
    public sealed class IndexHost
    {
        private readonly int[] data = new int[4];
        public int this[int i] => this.data[i];
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.IsUnsupported && d.ConstructKind == "IndexerDeclaration"
        )
    }

    /// Issue #941: the C# null-coalescing operator `??` now maps directly
    /// to G#'s `??` operator (the former `?:` gap is resolved).
    @Fact
    func NullCoalescing_TranslatesToQuestionQuestion() {
        let translated = TranslateUnit(`
namespace Demo
{
    public static class CoalesceHost
    {
        public static string OrElse(string value, string fallback) => value ?? fallback;
    }
}`)
        Assert.Contains("value ?? fallback", translated)
    }

    /// Issue #942 (was an ADR-0115 §B gap): member access on a bare-identifier
    /// element access (`values[i].M`) used to hit a G# parser ambiguity;
    /// that gap is now fixed, so the translator emits it through the normal
    /// member-access path rather than a placeholder.
    @Fact
    func BareIndexMemberAccess_TranslatesThroughNormalPath() {
        let (printed, context) = Translate(`
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
}`)
        Assert.Contains("values[i].Length", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.IsUnsupported && d.ConstructKind == "SimpleMemberAccessExpression"
        )
    }

    /// Issue #943 (was an ADR-0115 §B.7 gap): a constructed generic-interface
    /// constraint (`where T : IComparable<T>`) now has a canonical G#
    /// form — `[T IComparable[T]]` — so the translator emits it into the
    /// legacy constraint slot rather than dropping it.
    @Fact
    func GenericInterfaceConstraint_EmitsBracketedConstraint() {
        let (printed, context) = Translate(`
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
}`)
        Assert.Contains("[T IComparable[T]]", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.IsUnsupported && d.ConstructKind == "TypeParameterConstraintClause"
        )
    }

    /// Issue #1336: C# `where T : unmanaged` maps to the G# `unmanaged`
    /// flag constraint (which gsc supports for `sizeof(T)` / `*T`). It
    /// subsumes `struct`, so the translator emits `unmanaged` only — gsc
    /// reports a conflict if both `unmanaged` and `struct` are spelled.
    @Fact
    func UnmanagedConstraint_EmitsUnmanagedFlagNotStruct() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;
    public static class ConstraintHost
    {
        public static int Size<T>() where T : unmanaged, IComparable<T>
        {
            return 0;
        }
    }
}`)
        Assert.Contains("unmanaged", printed)
        Assert.DoesNotContain("struct]", printed)
        Assert.DoesNotContain("unmanaged struct", printed)
        Assert.DoesNotContain("struct unmanaged", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = Translate(source)
            return printed
        }

        private func TranslateForDiagnostics(source string) TranslationContext {
            let (_, context) = Translate(source)
            return context
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
