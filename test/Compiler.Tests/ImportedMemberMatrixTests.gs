// <copyright file="ImportedMemberMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

open class ImportedMemberMatrixTests {
    /// Issue #4086's own row. A caller type parameter erases to
    /// (cref:object) for reflection, so `Take<T>(T) where T :
    /// IDisposable` and `Take(object)` both looked like identity
    /// conversions and the non-generic one won the specificity tie-break.
    /// `csc` picks the constrained generic for both spellings; so does
    /// G# now. Measured against a compiled and run C# twin, not reasoned about.
    @Fact
    func Issue4086_TheInferredAndExplicitSpellingsBothPickTheConstrainedGeneric() {
        const drivers = `Console.WriteLine(throughClassBound[DisposableBase](DisposableBase()))
Console.WriteLine(throughInterface[DisposableBase](DisposableBase()))
Console.WriteLine(throughObject(DisposableBase()))`
        Assert.Equal(
            "generic-disposable${Environment.NewLine}" +
                "generic-disposable${Environment.NewLine}" +
                "object${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// The other half of #4086, and the reason the fix is not "prefer the
    /// generic candidate": an argument that is GENUINELY (cref:object),
    /// or a mixed vector where CLR inference fixes the method slot to
    /// (cref:object), must still select the non-generic overload.
    /// Covers direct, nested-generic, defaulted and expanded-params shapes.
    @Fact
    func Issue4086_AGenuineObjectArgumentStillPicksTheNonGenericOverload() {
        const drivers = `Console.WriteLine(throughMixedInference[DisposableBase](DisposableBase(), DisposableBase()))
Console.WriteLine(throughGenericOnlyMixedInference[DisposableBase](
    DisposableBase(),
    DisposableBase()))
Console.WriteLine(throughDefaultInference[DisposableBase](DisposableBase()))
Console.WriteLine(throughNestedMixedInference[DisposableBase](
    DisposableBase(),
    List[object]()))
Console.WriteLine(throughExpandedMixedInference[DisposableBase](
    DisposableBase(),
    DisposableBase()))`
        Assert.Equal(
            "object${Environment.NewLine}" +
                "Object${Environment.NewLine}" +
                "DisposableBase${Environment.NewLine}" +
                "object-nested${Environment.NewLine}" +
                "Object${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// Issue #4133's own row. A contravariant `Action<object>` /
    /// `IComparer<object>` argument RAISES the inferred type
    /// argument to `object`, exactly as a plain `T value` argument
    /// would LOWER it: `csc` prints `Object`,
    /// `generic-delegate:Object`, `Object`,
    /// `generic-interface:Object`; so does G# now. Measured against a
    /// compiled and run C# twin, not reasoned about.
    /// @remarks The symbolic type-argument fixer
    /// (`MemberLookup.FixSymbolicMethodTypeArguments`) collected both a
    /// lower bound (from `value`) and an upper bound (from the
    /// contravariant `sink` parameter) correctly, but picked the fixed
    /// type from whichever list was `lower` whenever it was non-empty
    /// and used `upper` only to validate that pick afterwards — never as
    /// a candidate that could win. `FindSymbolicInferenceCandidate` now
    /// builds its candidate set from BOTH lists together, so the upper bound
    /// can raise the fixed type the way it already could narrow one upper
    /// bound against another (order-independence, unaffected by this fix).
    /// The winner does not move in the `*Winner` rows — only the
    /// inferred type argument — which is why this was a different defect
    /// from #4086.
    @Fact
    func Issue4133_AContravariantDelegateOrInterfaceArgumentRaisesTheInferredArgument() {
        const drivers = `Console.WriteLine(throughDelegateUpperBoundType[DisposableBase](DisposableBase()))
Console.WriteLine(throughDelegateUpperBoundWinner[DisposableBase](DisposableBase()))
Console.WriteLine(throughInterfaceUpperBoundType[DisposableBase](DisposableBase()))
Console.WriteLine(throughInterfaceUpperBoundWinner[DisposableBase](DisposableBase()))`
        Assert.Equal(
            "Object${Environment.NewLine}" +
                "generic-delegate:Object${Environment.NewLine}" +
                "Object${Environment.NewLine}" +
                "generic-interface:Object${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// Issue #4133 follow-up. Once symbolic inference started consulting a
    /// lower AND an upper bound together (the fix above), a pair that is
    /// mutually implicitly convertible but not `TypeSignaturesEquivalent`
    /// — here, two same-shape named tuples differing only in whether one
    /// field is a nullable reference — became reachable for the first time.
    /// `csc`'s own fixing never treats a nullable-annotation-only
    /// difference as ambiguity (nullability is folded in after a candidate is
    /// picked, not used to eliminate one), so this must compile rather than
    /// report a spurious `GS0159`. Found via the `cs2gs-code-exploder`
    /// corpus (a real `ToDictionary` call over a same-shape,
    /// differently-nullable tuple lower/upper bound pair) and reduced to this
    /// single-file repro with no reference assembly, ruling out CLR-metadata
    /// import as the cause (that turned out to be a separate, filed defect,
    /// issue #4159).
    @Fact
    func Issue4133_MutuallyConvertibleBoundsThatDifferOnlyByNullabilityMergeRatherThanConflict() {
        const source = `package ImportedMemberMatrix.Issue4133Nullability
import System
import System.Collections.Generic
import System.Linq

let xs = List[(Id int32, Text string)]()
xs.Add((1, "a"))
xs.Add((2, "b"))
let ys = xs.Select((s (Id int32, Text string?)) -> s.Text).ToList()
Console.WriteLine(ys.Count)
Console.WriteLine(ys[0])
Console.WriteLine(ys[1])`
        Assert.Equal("2${Environment.NewLine}a${Environment.NewLine}b${Environment.NewLine}", CompileAndRun(source))
    }

    /// Issue #4133 follow-up, the REVERSE direction of the sibling test
    /// above (Copilot review finding on this PR). That test's receiver
    /// contributes the NON-nullable lower bound and the lambda's explicit
    /// parameter contributes the nullable upper bound; both candidates
    /// independently pass `SatisfiesSymbolicInferenceBounds` before
    /// ever reaching the merge branch, because `string -> string?`
    /// is implicit. Swap which side is nullable — a nullable LOWER bound
    /// (from the receiver) against a non-nullable UPPER bound (from the
    /// lambda) — and neither candidate independently satisfied both bound
    /// categories, since `string? -> string` requires the bang
    /// operator and is not implicit: `HasImplicitSymbolicConversion`'s
    /// elimination gate rejected BOTH candidates before the merge branch
    /// that resolves exactly this shape ever ran, silently reporting a
    /// symbolic-inference conflict. `HasImplicitSymbolicConversion` now
    /// treats a pure reference-nullable-annotation difference as mutually
    /// satisfying at the gate itself, not only inside the merge branch, so
    /// this direction reaches the same resolution as its sibling.
    @Fact
    func Issue4133_MutuallyConvertibleBoundsMergeInTheReverseNullableDirectionToo() {
        const source = `package ImportedMemberMatrix.Issue4133NullabilityReversed
import System
import System.Collections.Generic
import System.Linq

class Item {
    init(name string) {
        this.Name = name
    }
    prop Name string {
        get;
        init;
    }
}

let xs = List[(Id int32, Value Item?)]()
xs.Add((1, Item("a")))
xs.Add((2, Item("b")))
let ys = xs.Select((s (Id int32, Value Item)) -> s.Value).ToList()
Console.WriteLine(ys.Count)
Console.WriteLine(ys[0].Name)
Console.WriteLine(ys[1].Name)`
        Assert.Equal("2${Environment.NewLine}a${Environment.NewLine}b${Environment.NewLine}", CompileAndRun(source))
    }

    /// Issue #4160, found while measuring #4133's blast radius.
    /// `FunctionTypeSymbol.AppendStructuralKey`'s tuple case keyed on
    /// element TYPES only, omitting `TupleTypeSymbol.ElementNames` —
    /// unlike `TupleTypeSymbol.Get`'s own cache key (ADR-0172), which
    /// does include them. Two differently-named, same-shaped tuples used as
    /// explicit lambda-parameter types at separate call sites in one
    /// compilation therefore aliased in the shared cache: the
    /// SECOND-processed call's parameter type silently resolved to the
    /// FIRST's. Confirmed pre-existing (present identically on a control
    /// build of the pre-#4133 compiler) and unrelated to #4133's own change —
    /// just newly load-bearing once #4133 stopped silently ignoring upper
    /// bounds recovered from a corrupted/aliased lower bound. Covers both the
    /// flat case (the tuple itself is the lambda parameter) and a tuple
    /// NESTED inside another type argument, since `TupleTypeSymbol.Get`
    /// recurses through `FunctionTypeSymbol.AppendIdentityKey` for each
    /// element too.
    @Fact
    func Issue4160_DifferentlyNamedSameShapeTuplesDoNotAliasInTheStructuralCache() {
        const source = `package ImportedMemberMatrix.Issue4160TupleKey
import System
import System.Collections.Generic
import System.Linq

func capOf(s string) string {
    return s
}

func handleBatch(batch List[(Id int32, Content string)]) List[string] {
    return batch.Select((b (Id int32, Content string)) -> capOf(b.Content)).ToList()
}

func handleSummaries(summaries List[(Id int32, Text string)]) List[string] {
    return summaries.Select((s (Id int32, Text string)) -> capOf(s.Text)).ToList()
}

func handleNestedBatch(batch List[((Id int32, Content string), int32)]) List[string] {
    return batch.Select((b ((Id int32, Content string), int32)) -> capOf(b.Item1.Content)).ToList()
}

func handleNestedSummaries(summaries List[((Id int32, Text string), int32)]) List[string] {
    return summaries.Select((s ((Id int32, Text string), int32)) -> capOf(s.Item1.Text)).ToList()
}

let batch = List[(Id int32, Content string)]()
batch.Add((1, "hello"))
let batchResult = handleBatch(batch)
Console.WriteLine(batchResult[0])

let summaries = List[(Id int32, Text string)]()
summaries.Add((2, "world"))
let summariesResult = handleSummaries(summaries)
Console.WriteLine(summariesResult[0])

let nestedBatch = List[((Id int32, Content string), int32)]()
nestedBatch.Add(((3, "nested-hello"), 0))
let nestedBatchResult = handleNestedBatch(nestedBatch)
Console.WriteLine(nestedBatchResult[0])

let nestedSummaries = List[((Id int32, Text string), int32)]()
nestedSummaries.Add(((4, "nested-world"), 0))
let nestedSummariesResult = handleNestedSummaries(nestedSummaries)
Console.WriteLine(nestedSummariesResult[0])`
        Assert.Equal(
            "hello${Environment.NewLine}" +
                "world${Environment.NewLine}" +
                "nested-hello${Environment.NewLine}" +
                "nested-world${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Issue #4133 follow-up (hot-core translation guard finding #1,
    /// `tools/cs2gs/Cs2Gs.Pipeline/DeclaredProjectItem.gs`): a BARE
    /// METHOD GROUP argument's own declared parameter type is never a real
    /// input-inference bound — C# §12.6.3.7 makes only an OUTPUT inference
    /// from a method group's return type, never an input inference from its
    /// parameters. Before this fix, `Where[TSource]`'s receiver
    /// correctly lower-bounds `TSource` to `Item`, but the bare
    /// predicate's own nullable-annotated parameter (`Item?` — the kind
    /// of annotation cs2gs's oblivious-nullability heuristic adds to
    /// nullable-oblivious C#) was ALSO fed in as a genuine upper bound and
    /// "raised" `TSource` to `Item?`, which a LATER, explicitly
    /// non-nullable lambda parameter two calls downstream could not absorb —
    /// a false ambiguity surfacing as a real GS0159. Reduced from the real
    /// failure to this single-file repro; matches `csc`, which infers
    /// `TSource = Item` throughout. See
    /// `MemberLookup.SymbolicInferenceBoundKind.MethodGroupUpper`,
    /// which `MemberLookup.SymbolicInferenceBounds.Add` discards
    /// outright, for the mechanism.
    @Fact
    func Issue4133_BareMethodGroupParameterTypeDoesNotRaiseTheReceiversInferredArgument() {
        const source = `package ImportedMemberMatrix.Issue4133MethodGroupParam
import System
import System.Collections.Generic
import System.Linq

class Item {
    init(name string) {
        this.Name = name
    }
    prop Name string {
        get;
        init;
    }
}

func pred(x Item?) bool -> x != nil && x.Name.Length > 0

func run(items IReadOnlyList[Item]) List[string] {
    return items
        .Where(pred)
        .Select((item Item) -> item.Name)
        .ToList()
}

let xs = List[Item]()
xs.Add(Item("a"))
xs.Add(Item("b"))
let result = run(xs)
Console.WriteLine(result.Count)
Console.WriteLine(result[0])
Console.WriteLine(result[1])`
        Assert.Equal("2${Environment.NewLine}a${Environment.NewLine}b${Environment.NewLine}", CompileAndRun(source))
    }

    /// Issue #4133 follow-up (hot-core translation guard finding #2,
    /// `tools/cs2gs/Cs2Gs.Translator/EmittedNameAllocator.gs`'s
    /// `GetScopeNames`). The same bare-method-group mechanism as the
    /// sibling test above, but reduced from the REAL failure (an ILVerify
    /// `StackUnexpected` — the emitted MethodSpec closed
    /// `Select` over `ISymbol` while the delegate site referenced
    /// `Func<INamespaceOrTypeSymbol,string>`) rather than a
    /// GS0159: a single bare method group (`SourceName`, parameter
    /// `ISymbol?`) is used via `.Select(SourceName)` at TWO call
    /// sites whose receivers yield DIFFERENT element types —
    /// `INamespaceSymbol.GetMembers()` (a shadowing declaration
    /// returning `IEnumerable<INamespaceOrTypeSymbol>`, a
    /// subtype of `ISymbol`) in one branch, and the inherited
    /// `ImmutableArray<ISymbol>`-returning overload in the other.
    /// Before this fix, the first call site's receiver correctly
    /// lower-bounds `TSource` to `INamespaceOrTypeSymbol`, but the
    /// method group's own `ISymbol?` parameter fed in as a spurious
    /// upper bound raised it back to the wider `ISymbol` — gsc then
    /// emitted a `Select<ISymbol,...>` MethodSpec at a call site
    /// whose delegate creation (`Func<INamespaceOrTypeSymbol,string>`,
    /// pinned by the extension method's own `this` receiver type) still
    /// referenced the narrower type — an inconsistency ILVerify catches but
    /// gsc's own binder did not. References the real
    /// `Microsoft.CodeAnalysis.dll` already restored for this test
    /// project (via (cref:AppContext.BaseDirectory)) rather than a
    /// user-declared analog, since this exact mismatch is specific to a CLR
    /// interface hierarchy shape.
    @Fact
    func Issue4133_BareMethodGroupUsedAcrossDifferentReceiverElementTypesEmitsConsistentMethodSpecs() {
        const source = `package ImportedMemberMatrix.Issue4133MethodGroupCrossReceiver

import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq

class Allocator {
    shared {
        private func SourceName(symbol ISymbol?) string -> symbol!!.Name

        func GetScopeNames(symbol ISymbol) IReadOnlyCollection[string] {
            switch symbol {
                case namespaceSymbol is INamespaceSymbol {
                    return namespaceSymbol
                        .ContainingNamespace
                        ?.GetMembers()
                        .Select(SourceName)
                        .ToArray() ?? Array.Empty[string]()
                }
                default {
                    return cast[IReadOnlyCollection[string]](
                        symbol.ContainingNamespace?.GetMembers().Select(SourceName).ToArray() ?? Array.Empty[string]()
                    )
                }
            }
        }
    }
}

Console.WriteLine("ok")`
        let codeAnalysisReference = Path.Combine(AppContext.BaseDirectory, "Microsoft.CodeAnalysis.dll")
        Assert.True(
            File.Exists(codeAnalysisReference),
            "expected $codeAnalysisReference to already be restored alongside this test assembly"
        )
        let workDir = CreateWorkDir("imported_member_matrix_roslyn_")
        try {
            Assert.Equal("ok${Environment.NewLine}", CompileAndRun(source, []string{codeAnalysisReference}, workDir))
        } finally {
            TryDelete(workDir)
        }
    }

    /// Issue #4133 follow-up, negative witness (Copilot review finding on
    /// this PR — a prior version of this fix got this backwards). A method
    /// type parameter that ONLY a bare method group's own parameter type
    /// ever constrains — `Fallback.Wrap[T](predicate Func[T, bool])`
    /// called as `Fallback.Wrap(check)`, with no other argument to fix
    /// `T` from — must FAIL to infer, matching `csc`, which
    /// reports CS0411 ("The type arguments ... cannot be inferred from the
    /// usage") for the identical C# shape, measured directly (not assumed)
    /// against a compiled C# twin. An earlier draft of this fix added
    /// `SymbolicInferenceBounds.PromoteMethodGroupFallbacks`, promoting
    /// the demoted `MethodGroupUpper` bound back into `Upper` as a
    /// same-slot "fallback" whenever no other bound existed — reasoning
    /// that `Foo(SomeMethod)` with no other argument must be the one
    /// shape where a method group's parameter type genuinely is the only
    /// evidence. That reasoning was wrong: C# never treats it as evidence,
    /// full stop, and the promoted fallback made gsc silently ACCEPT this
    /// exact call — strictly MORE permissive than `csc`, the opposite
    /// direction of #4133's own defect. `T` is a same-compilation user
    /// class deliberately: a CLR primitive like `int32` can't
    /// discriminate this case, since plain CLR reflection resolves
    /// `Wrap<Int32>` on its own regardless of what the symbolic
    /// layer does. `gsc` now reports `GS0155` (a real rejection, matching
    /// `csc`'s reject decision even though the diagnostic code differs) —
    /// `T` erases to `object`, and the bare method group's own parameter
    /// type (`Item`) then fails to convert to the erased delegate
    /// shape (`Func[object, bool]`).
    @Fact
    func Issue4133_BareMethodGroupWithNoOtherBoundFailsToInferJustLikeCSharp() {
        const csSource = `namespace Sibling
{
    public static class Fallback
    {
        public static System.Func<T, bool> Wrap<T>(System.Func<T, bool> predicate) => predicate;
    }
}`
        const gSource = `package ImportedMemberMatrix.Issue4133MethodGroupFallback

import System
import Sibling

class Item {
    init(name string) {
        this.Name = name
    }
    prop Name string {
        get;
        init;
    }
}

func check(x Item) bool -> x.Name.Length > 0

let checker = Fallback.Wrap(check)
Console.WriteLine(checker.GetType().GenericTypeArguments[0].Name)
Console.WriteLine(checker(Item("a")))`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gSource, "Issue4133Fallback.CSharp")
        Assert.Contains(GetDiagnosticIds(diagnostics), (id string) -> id == "GS0155")
    }

    /// Order-independence of the symbolic bound sets: two
    /// `Action<T>` arguments over a base and a derived type fix the
    /// same argument whichever order they are written in, in both the fixed
    /// and the expanded-params spelling. On the parent the whole shape
    /// reported `GS0159`; `csc` accepts it and prints these values.
    @Fact
    func Issue4086_DelegateUpperBoundsFixTheSameArgumentInEitherArgumentOrder() {
        const drivers = `Console.WriteLine(VarianceOverloads.UpperType(
    VarianceOverloads.BaseAction(),
    VarianceOverloads.DerivedAction()))
Console.WriteLine(VarianceOverloads.UpperType(
    VarianceOverloads.DerivedAction(),
    VarianceOverloads.BaseAction()))
Console.WriteLine(VarianceOverloads.UpperParams(
    VarianceOverloads.InferenceBaseAction(),
    VarianceOverloads.InferenceDerivedAction()))
Console.WriteLine(VarianceOverloads.UpperParams(
    VarianceOverloads.InferenceDerivedAction(),
    VarianceOverloads.InferenceBaseAction()))`
        Assert.Equal(
            "DerivedDisposable${Environment.NewLine}" +
                "DerivedDisposable${Environment.NewLine}" +
                "Derived${Environment.NewLine}" +
                "Derived${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// Issue #4159: a nullable-reference annotation on a tuple element nested
    /// inside an `async Task[...]` return type, imported from a
    /// referenced (already-compiled) assembly, must survive the CLR-metadata
    /// import path — matching the same-compilation (symbolic) named-tuple
    /// case, which already preserved it.
    ///
    /// RED (measured, before the fix): compiled with no diagnostic at all —
    /// `rows[0].Value` was typed as non-nullable `string`, so
    /// `let x string = rows[0].Value` silently accepted a nullable value.
    /// Root cause: this repro's outer `Task[IReadOnlyList[(...)]]` has a
    /// named tuple nested inside its own type argument, which is eagerly
    /// rebuilt for tuple-name preservation (see
    /// `ImportedTypeSymbol.GetConstructed`) — traced directly, that
    /// eager rebuild is what routes THIS specific repro through
    /// `ExpressionBinder.TryGetTaskElementType`'s symbolic
    /// `NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol` path
    /// (not the CLR-fallback `GetTypeArgumentSymbolForClrType`, which a
    /// PLAIN, non-tuple-containing await like `Task[string?]` uses
    /// instead — see the sibling scope-witness test below). Both paths
    /// route into `NullabilityAnnotatedTypeSymbol.TransferTupleNames`,
    /// which only matched a tuple sitting directly under one
    /// `Nullable` wrapper or a top-level `ImportedTypeSymbol`, so
    /// it needed a case for a LAZY `NullabilityAnnotatedTypeSymbol`-wrapped
    /// nested generic (the shape `IReadOnlyList[(...)]` takes one level
    /// inside `Task[...]`), materializing it eagerly before grafting
    /// names.
    ///
    /// GREEN (this test): reports `GS0155`, exactly like the
    /// same-compilation control elsewhere in this file's nullable-tuple
    /// coverage.
    @Fact
    func Issue4159_AsyncImportedNullableTupleElementPreservesNullability() {
        const csSource = `using System.Collections.Generic;
using System.Threading.Tasks;

namespace Issue4159.CSharp
{
    public class Store
    {
        public async Task<IReadOnlyList<(string Key, string? Value)>> GetNullableAsync()
        {
            await Task.Yield();
            return new List<(string, string?)> { ("k", null) };
        }
    }
}`
        const gSource = `package Issue4159.Repro
import System
import Issue4159.CSharp

async func run(store Store) {
    let rows = await store.GetNullableAsync()
    let x string = rows[0].Value
    Console.WriteLine(x)
}

run(Store()).GetAwaiter().GetResult()`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gSource, "Issue4159.CSharp")
        Assert.Contains(GetDiagnosticIds(diagnostics), (id string) -> id == "GS0155")
    }

    /// Issue #4159 negative control: the SAME shape without a nullable
    /// element must keep compiling — the fix must not start rejecting a
    /// genuinely non-nullable imported async tuple element.
    @Fact
    func Issue4159_AsyncImportedNonNullableTupleElementStillCompiles() {
        const csSource = `using System.Collections.Generic;
using System.Threading.Tasks;

namespace Issue4159Control.CSharp
{
    public class Store
    {
        public async Task<IReadOnlyList<(string Key, string Value)>> GetAsync()
        {
            await Task.Yield();
            return new List<(string, string)> { ("k", "v") };
        }
    }
}`
        const gSource = `package Issue4159.Control
import System
import Issue4159Control.CSharp

async func run(store Store) {
    let rows = await store.GetAsync()
    let x string = rows[0].Value
    Console.WriteLine(x)
}

run(Store()).GetAwaiter().GetResult()`
        Assert.Equal(
            "v${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gSource, "Issue4159Control.CSharp")
        )
    }

    /// Issue #4159, scope witness: the underlying defect (`TryGetTaskElementType`'s
    /// CLR-fallback path recovering the awaited element via a naive
    /// `TypeSymbol.FromClrType` instead of the nullability-aware
    /// `NullabilityAnnotatedTypeSymbol` accessor) is general to ANY
    /// reference-typed awaited element — not tuple-specific — so this fix is
    /// a real behavior change beyond the tuple shape the issue was filed
    /// against: a plain `Task[string?]`, with no tuple involved at all,
    /// now also correctly rejects an unguarded assignment to a non-null
    /// local. RED (measured, before the fix): compiled with no diagnostic.
    /// GREEN (this test): reports `GS0155`.
    @Fact
    func Issue4159_AsyncImportedNullablePlainReturnPreservesNullability() {
        const csSource = `using System.Threading.Tasks;

namespace Issue4159Plain.CSharp
{
    public class Store
    {
        public async Task<string?> GetNullableStringAsync()
        {
            await Task.Yield();
            return null;
        }
    }
}`
        const gSource = `package Issue4159.Plain
import System
import Issue4159Plain.CSharp

async func run(store Store) {
    let value = await store.GetNullableStringAsync()
    let x string = value
    Console.WriteLine(x)
}

run(Store()).GetAwaiter().GetResult()`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gSource, "Issue4159Plain.CSharp")
        Assert.Contains(GetDiagnosticIds(diagnostics), (id string) -> id == "GS0155")
    }

    /// Issue #4159, Copilot review finding on this PR:
    /// `NullabilityAnnotatedTypeSymbol.TransferTupleNames`'s
    /// `NullableTypeSymbol` case originally required BOTH sides
    /// already nullable-wrapped to recurse. The naive, name-bearing
    /// `source` tree does not reliably wrap a nullable REFERENCE
    /// generic argument the way the flags-derived `target` tree does
    /// (only `target`'s construction consults
    /// `[NullableAttribute]`), so a tuple nested inside a NULLABLE
    /// reference generic argument — `IReadOnlyList[(...)]?`, the LIST
    /// itself nullable, one level inside `Task[...]` — fell through
    /// every case and kept its names dropped even after the original
    /// #4159 fix landed. RED (measured, before this follow-up): the tuple
    /// arrives unnamed, so `rows!!.[0].Value` fails to bind (no
    /// `GS0155` for the nullability defect this test isn't about —
    /// the point is the NAMES, which either exist or don't). GREEN (this
    /// test): the named access compiles and runs, proving the names
    /// survived the nullable-reference wrapper asymmetry.
    @Fact
    func Issue4159_AsyncImportedNullableListOfNamedTuplePreservesNames() {
        const csSource = `using System.Collections.Generic;
using System.Threading.Tasks;

namespace Issue4159NullableList.CSharp
{
    public class Store
    {
        public async Task<IReadOnlyList<(string Key, string Value)>?> GetNullableListAsync()
        {
            await Task.Yield();
            return new List<(string, string)> { ("k", "v") };
        }
    }
}`
        const gSource = `package Issue4159.NullableList
import System
import Issue4159NullableList.CSharp

async func run(store Store) {
    let rows = await store.GetNullableListAsync()
    let x string = rows!![0].Value
    Console.WriteLine(x)
}

run(Store()).GetAwaiter().GetResult()`
        Assert.Equal(
            "v${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gSource, "Issue4159NullableList.CSharp")
        )
    }

    /// Issue #4159, Copilot review finding on this PR:
    /// `NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType`
    /// located the outer awaitable's matching generic argument by comparing
    /// CLOSED CLR types, which is ambiguous whenever two or more of the
    /// outer type's own arguments close over the exact same CLR type — here,
    /// a custom (non-`Task`) awaitable with TWO type parameters,
    /// `Awaitable[string, string?]`, where `GetResult()` returns
    /// the SECOND (nullable) parameter but both parameters erase to the
    /// identical CLR type `System.String`.
    ///
    /// This method is only reached at all when the outer awaitable's
    /// symbolic base has EMPTY `TypeArguments` — `TryGetTaskElementType`'s
    /// earlier "openDef" fast path requires non-empty `TypeArguments`
    /// even to attempt matching, and a plain (non-tuple-containing)
    /// awaitable's symbolic base is never eagerly rebuilt the way a
    /// tuple-containing one is (see `ImportedTypeSymbol.GetConstructed`
    /// / `TupleElementNamesReader.ApplyNames`), so it stays empty. This
    /// is measured, not assumed: adding a NAMED TUPLE to this repro's own
    /// type arguments (to make the wrong-index risk independently
    /// observable via tuple element names, not just nullability) makes the
    /// symbolic base eagerly rebuilt too, which flips the "openDef" gate on
    /// and routes the whole repro through the (inherently unambiguous,
    /// position-based) `GetTypeArgumentSymbol` path instead — never
    /// reaching the very code this test targets. So this repro deliberately
    /// stays scalar (no tuples) to keep exercising
    /// `GetTypeArgumentSymbolForClrType` at all, which in turn means a
    /// direct `let x string = value` (no null-check) compiles with NO
    /// diagnostic both BEFORE this follow-up (the first-match bug recovers
    /// `T1`'s own non-null annotation) AND AFTER it (the safe "refuse
    /// to guess" fallback recovers an unannotated/oblivious type, which
    /// G#'s null-safety gate treats leniently) — so a missing-GS0155
    /// assertion would NOT actually discriminate the bug from the fix here,
    /// and this test does not claim one. What DOES change, and what this
    /// test asserts: before this follow-up, a genuinely nullable value
    /// (`T2` is `string?` and this factory returns `null`)
    /// that got silently mismatched to `T1`'s non-null annotation
    /// risked the compiler trusting a non-null claim that was actually
    /// false — this test proves the runtime value survives this exact
    /// ambiguous-match code path intact (arrives as genuinely nil,
    /// observable via `value == nil`, and the emitted code doesn't
    /// crash or corrupt the delegate/call shape), which is what a wrong
    /// silent match risked breaking.
    @Fact
    func Issue4159_AmbiguousAwaitableTypeArgumentsDoesNotMisattributeNullability() {
        const csSource = `using System;
using System.Runtime.CompilerServices;

namespace Issue4159Ambiguous.CSharp
{
    public class Awaitable<T1, T2>
    {
        private readonly T2 _value;

        public Awaitable(T2 value)
        {
            _value = value;
        }

        public Awaiter GetAwaiter() => new Awaiter(_value);

        public struct Awaiter : INotifyCompletion
        {
            private readonly T2 _value;

            public Awaiter(T2 value)
            {
                _value = value;
            }

            public bool IsCompleted => true;

            public T2 GetResult() => _value;

            public void OnCompleted(Action continuation) => continuation();
        }
    }

    public static class Factory
    {
        public static Awaitable<string, string?> MakeNullable() => new Awaitable<string, string?>(null);
    }
}`
        const gSource = `package Issue4159.Ambiguous
import System
import Issue4159Ambiguous.CSharp

async func run() {
    let value = await Factory.MakeNullable()
    if value == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine(value)
    }
}

run().GetAwaiter().GetResult()`
        Assert.Equal(
            "nil${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gSource, "Issue4159Ambiguous.CSharp")
        )
    }

    /// Issue #4165: a bare method group whose declared parameter type is a
    /// BASE class is a legal contravariant method-group conversion to a
    /// delegate over a DERIVED element type — `csc` accepts
    /// `Func<Derived,string> f = Name;` when `Name(Base? x)`.
    ///
    /// RED (measured, before the fix): `GS0155: Cannot convert type
    /// '(Base?) -> string' to 'System.Func[Derived, string]'.` Root
    /// cause: `Conversion.IsFunctionToDelegateConvertible` rejected the
    /// parameter slot whenever the method group's own parameter type had no
    /// `ClrType` (true for any same-compilation class/interface
    /// mid-binding) — the CLR-assignability check could not even ask the
    /// question. Measured (via tracing, not assumed): a CLR-imported
    /// base/derived pair (e.g. Roslyn's `ISymbol`/`INamespaceOrTypeSymbol`)
    /// never reaches `IsFunctionToDelegateConvertible` at all for either
    /// a `.Select(...)` argument or a direct delegate-variable
    /// assignment — some other resolution path handles that shape, which is
    /// why this defect was only ever visible for a same-compilation
    /// parameter type, never an imported one.
    ///
    /// GREEN (this test): compiles and runs, printing the derived instance's
    /// name, matching `csc`. Fixing the parameter loop's unconditional
    /// rejection also surfaced a dormant, unrelated erasure bug in the
    /// RETURN-type check that this fix's own validation caught as a
    /// regression in `Issue1518NullableDelegateInferenceEmitTests` (a
    /// nullable-VALUE-type return, e.g. `bool?`, became indistinguishable
    /// from the bare `bool` once the parameter gate that used to reject
    /// every same-compilation-parameter candidate outright stopped masking
    /// it) — fixed alongside this one via `NullableLifting.GetEffectiveClrType`
    /// on the return-type identity check. The identical erasure gap on the
    /// PARAMETER side (untouched, since no currently-passing test reaches
    /// it) is tracked separately as issue #4184.
    @Fact
    func Issue4165_BareMethodGroupWithBaseParameterConvertsToDerivedElementDelegate() {
        const gSource = `package Issue4165.Repro
import System
import System.Collections.Generic
import System.Linq

open class Base {
    init(name string) {
        this.Name = name
    }
    prop Name string {
        get;
        init;
    }
}
class Derived : Base {
    init(name string) : base(name) {
    }
}

func Name(x Base?) string -> x!!.Name

func namesOf(items IEnumerable[Derived]) List[string] {
    return items.Select(Name).ToList()
}

let xs = List[Derived]()
xs.Add(Derived("hello"))
let result = namesOf(xs)
Console.WriteLine(result[0])`
        Assert.Equal("hello${Environment.NewLine}", CompileAndRun(gSource))
    }

    /// Issue #4171: a bare method group passed to a doubly-nested
    /// contravariant delegate parameter (`Action[Action[T]]`) whose own
    /// declared parameter type does NOT actually satisfy the delegate once
    /// `T` is correctly inferred must report a clean diagnostic — never
    /// crash.
    ///
    /// RED (measured, before the fix): `error GS9998:
    /// NotSupportedException: Cannot encode signature for type '?' yet.` —
    /// an internal-compiler-error crash during PE emission. Root cause: when
    /// a static imported generic method call's arguments include an
    /// unresolved bare method group (typed `TypeSymbol.Error` by design,
    /// per `ClrOverloadResolution.IsUnresolvedMethodGroupArgument`'s
    /// deliberate "defer me" sentinel) and NO candidate ultimately accepts the
    /// call, `ExpressionBinder.Calls.Invocation.cs`'s "an argument that
    /// already failed to bind cannot participate in overload resolution"
    /// guard unconditionally treated ANY `TypeSymbol.Error`-typed
    /// argument as already-diagnosed and silently returned an undiagnosed
    /// `BoundErrorExpression` — even though an unresolved method group is
    /// never a prior failure. The top-level `let`'s declared type became
    /// the bare `TypeSymbol.Error` sentinel with zero diagnostics
    /// reported, and it reached the emitter, which crashed trying to encode a
    /// signature for it.
    ///
    /// GREEN (this test): reports `GS0159` ("Cannot find function
    /// Pick"), matching `csc`'s own rejection (CS1503) in spirit — no
    /// crash, no silent failure.
    @Fact
    func Issue4171_DoublyNestedContravariantDelegateWithUnsatisfiableMethodGroupReportsCleanDiagnostic() {
        const csSource = `using System;
using System.Collections.Generic;

namespace Issue4171.CSharp
{
    public static class NestedVariance
    {
        public static T Pick<T>(IEnumerable<T> items, Action<Action<T>> handler)
        {
            T result = default!;
            foreach (var item in items)
            {
                result = item;
            }

            handler(_ => { });
            return result;
        }

        public static void Handler(Action<object> x)
        {
        }
    }
}`
        const gSource = `package Issue4171.Repro
import System
import System.Collections.Generic
import Issue4171.CSharp

let strings = List[string]()
strings.Add("a")
strings.Add("b")
let result = NestedVariance.Pick(strings, NestedVariance.Handler)
Console.WriteLine(result)`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gSource, "Issue4171.CSharp")
        Assert.DoesNotContain(GetDiagnosticIds(diagnostics), (id string) -> id == "GS9998")
        Assert.Contains(GetDiagnosticIds(diagnostics), (id string) -> id == "GS0159")
    }

    /// Issue #4171 positive control: the SAME nested-variance shape, but with
    /// a handler whose declared parameter genuinely satisfies the inferred
    /// delegate (`Action[string]`, not `Action[object]`), must
    /// still compile and run — measured directly against `csc`, which
    /// accepts it and infers `T = string` from the receiver alone.
    @Fact
    func Issue4171_DoublyNestedContravariantDelegateWithSatisfiableMethodGroupCompilesAndRuns() {
        const csSource = `using System;
using System.Collections.Generic;

namespace Issue4171Control.CSharp
{
    public static class NestedVariance
    {
        public static T Pick<T>(IEnumerable<T> items, Action<Action<T>> handler)
        {
            T result = default!;
            foreach (var item in items)
            {
                result = item;
            }

            handler(_ => { });
            return result;
        }

        public static void Handler(Action<string> x)
        {
        }
    }
}`
        const gSource = `package Issue4171.Control
import System
import System.Collections.Generic
import Issue4171Control.CSharp

let strings = List[string]()
strings.Add("a")
strings.Add("b")
let result = NestedVariance.Pick(strings, NestedVariance.Handler)
Console.WriteLine(result)`
        Assert.Equal(
            "b${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gSource, "Issue4171Control.CSharp")
        )
    }

    /// `List<T>` is invariant, so `List<object>` and
    /// `List<T>` cannot both fix one method slot; the non-generic
    /// candidate wins, in the fixed and expanded spellings alike. On the
    /// parent the fixed spelling picked the GENERIC candidate and the expanded
    /// one reported `GS0155`; `csc` prints these two values.
    @Fact
    func Issue4086_AnInvariantConflictSelectsTheNonGenericOverload() {
        const drivers = `Console.WriteLine(throughInvariantConflict[DisposableBase](List[DisposableBase]()))
Console.WriteLine(throughInvariantExpandedConflict[DisposableBase](List[DisposableBase]()))`
        Assert.Equal(
            "object-invariant${Environment.NewLine}" + "object-invariant-params${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// A method group argument contributes its RETURN type as output evidence
    /// for a method type parameter that appears nowhere else. Covers instance,
    /// static, inherited, extension and same-compilation receivers; fixed,
    /// expanded-params and named spellings; an escaped CLR parameter name
    /// (`@func` → `func_`); and a same-compilation
    /// `Derived` input with a `Base` return, which proves the
    /// recovered call type reaches MethodSpec emission.
    /// @remarks This is the shape a reviewer flagged on #4108: an OVERLOADED
    /// zero-argument group returning the base type must fix the parameter to
    /// the base, not to the argument's derived type. Measured on the parent —
    /// `receiver.ChooseParams(value, methodGroup)` was an internal
    /// compiler error there (`GS9998: Invariant violated:
    /// 'methodGroup.FunctionType' was null`).
    @Fact
    func Issue4086_MethodGroupOutputInferenceFixesTheOutputTypeParameter() {
        const drivers = `Console.WriteLine(throughInstanceMethodGroup(InstanceOverloads()))
Console.WriteLine(throughExpandedInstanceMethodGroup(InstanceOverloads()))
Console.WriteLine(throughFixedMethodGroupOutputInference())
Console.WriteLine(throughExpandedMethodGroupOutputInference())
Console.WriteLine(throughNamedFixedMethodGroupOutputInference())
Console.WriteLine(throughNamedExpandedMethodGroupOutputInference())
Console.WriteLine(throughNamedFixedMethodGroupOutputValue())
Console.WriteLine(throughNamedExpandedMethodGroupOutputValue())
Console.WriteLine(throughNamedExpandedMultiMethodGroupOutputValue())
Console.WriteLine(throughExpandedStaticMethodGroup())
Console.WriteLine(throughExpandedSymbolicInstanceMethodGroup(InstanceOverloads()))
Console.WriteLine(throughExpandedInheritedMethodGroup(DerivedInstanceOverloads()))
Console.WriteLine(throughExpandedExtensionMethodGroup(InstanceOverloads()))`
        Assert.Equal(
            "DisposableBase${Environment.NewLine}" +
                "DisposableBase${Environment.NewLine}" +
                "Derived:Base${Environment.NewLine}" +
                "Derived:Base${Environment.NewLine}" +
                "Derived:Base${Environment.NewLine}" +
                "Derived:Base${Environment.NewLine}" +
                "same-compilation-Base${Environment.NewLine}" +
                "same-compilation-Base${Environment.NewLine}" +
                "same-compilation-Base${Environment.NewLine}" +
                "Base${Environment.NewLine}" +
                "Base${Environment.NewLine}" +
                "Base${Environment.NewLine}" +
                "Base${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, Issue4086GsDeclarations + "\n" + drivers, "Issue4086.CSharp")
        )
    }

    /// The dispatch paths a reviewer flagged on #4108 as still erasing the
    /// argument: an imported call through a TYPE-PARAMETER receiver, both the
    /// instance form and the static-abstract-interface form, including one
    /// that spills through an `await`. Measured on the parent, both
    /// picked the boxing `Take(object)` AND emitted IL the verifier
    /// rejects with `[StackUnexpected] [found value 'T'][expected ref
    /// 'object']`; here they pick the constrained generic and that error is
    /// gone.
    /// @remarks The genuine-(cref:object) and mixed-inference controls sit in
    /// the same fact so a fix that simply prefers the generic candidate cannot
    /// pass. ILVerify runs strictly over everything except these
    /// static-virtual-interface functions, where the two established
    /// (cref:IlVerifier.KnownIssues.StaticVirtualInterface) codes are
    /// tolerated; the rest of the assembly is verified with no suppression.
    @Fact
    func Issue4086_ConstrainedInstanceAndStaticDispatchKeepTheSymbolicArgument() {
        const drivers = `Console.WriteLine(throughConstrainedInstanceMethodGroup[InstanceOverloads](
    InstanceOverloads()))
Console.WriteLine(throughExpandedConstrainedInstanceMethodGroup[InstanceOverloads](
    InstanceOverloads()))
Console.WriteLine(throughConstrainedInstance[InstanceOverloads, DisposableBase](
    InstanceOverloads(),
    DisposableBase()))
Console.WriteLine(throughConstrainedInstanceObject[InstanceOverloads](
    InstanceOverloads(),
    DisposableBase()))
Console.WriteLine(throughConstrainedStatic[StaticOverloads, DisposableBase](
    DisposableBase()))
Console.WriteLine(throughConstrainedStaticAsync[AsyncStaticOverloads, DisposableBase](
    DisposableBase()).Result)
Console.WriteLine(throughConstrainedStaticObject[StaticOverloads](
    DisposableBase()))
Console.WriteLine(throughConstrainedStaticMixedInference[StaticOverloads, DisposableBase](
    DisposableBase(),
    DisposableBase()))
Console.WriteLine(throughConstrainedStaticMethodGroup[StaticOverloads]())
Console.WriteLine(throughExpandedConstrainedStaticMethodGroup[StaticOverloads]())
Console.WriteLine(throughNamedConstrainedStaticMethodGroup[StaticOverloads]())
Console.WriteLine(throughNamedExpandedConstrainedStaticMethodGroup[StaticOverloads]())`
        Assert.Equal(
            "DisposableBase${Environment.NewLine}" +
                "Base${Environment.NewLine}" +
                "instance-generic${Environment.NewLine}" +
                "instance-object${Environment.NewLine}" +
                "static-generic${Environment.NewLine}" +
                "async-static-generic${Environment.NewLine}" +
                "static-object${Environment.NewLine}" +
                "Object${Environment.NewLine}" +
                "DisposableBase${Environment.NewLine}" +
                "Base${Environment.NewLine}" +
                "DisposableBase${Environment.NewLine}" +
                "Base${Environment.NewLine}",
            CompileAndRunWithSiblingCs(
                Issue4086CsSource,
                Issue4086GsDeclarations + "\n" + Issue4086GsConstrainedStaticDeclarations + "\n" + drivers,
                "Issue4086.CSharp",
                ignoredErrorScope: "through(?:Named)?(?:Expanded)?ConstrainedStatic(?:Async)?"
            )
        )
    }

    /// The negative control for method-group output inference: a group whose
    /// only candidate takes an incompatible INPUT is not applicable, and the
    /// call is rejected rather than silently bound to the wrong candidate.
    @Fact
    func Issue4086_AnIncompatibleMethodGroupInputIsRejected() {
        const incompatibleSource = `package Issue4086.Incompatible
import Issue4086.CSharp

func incompatibleConvert(value int32) Issue4086.CSharp.Base {
    return Issue4086.CSharp.Base()
}

MethodGroupOutputInference.Choose(
    Issue4086.CSharp.Derived(),
    incompatibleConvert)`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(Issue4086CsSource, incompatibleSource, "Issue4086.CSharp")
        // Count, not presence (ADR-0154). The helper returns raw compiler
        // output lines, so count the DIAGNOSTIC lines: exactly one, and it is
        // the GS0159 for the one rejected call. A follow-on cascade or a
        // second report of the same call would break this row.
        Assert.Equal(1, diagnostics.Count((d string) -> d.Contains(": error GS", StringComparison.Ordinal)))
        Assert.Equal(
            1,
            diagnostics.Count(
                (d string) -> d.Contains("error GS0159: Cannot find function Choose.", StringComparison.Ordinal)
            )
        )
    }

    /// <summary>
    /// <summary>
    /// Issue #4134's acceptance row for reordered NAMED arguments into a
    /// <c>params</c> slot: they must evaluate in SOURCE order, not in the
    /// parameter order they are reordered into, and a <c>ref</c> lvalue must
    /// still write back.
    /// </summary>
    /// <remarks>
    /// Measured against a compiled and run C# twin: <c>csc</c> prints
    /// <c>first|second|</c> and <c>first|ref|</c>. The parent of this PR (the
    /// #4086 fix alone) BOUND these calls — <c>main</c> rejected them with
    /// <c>GS0159</c> — but evaluated them in parameter order,
    /// <c>second|first|</c> and <c>ref|first|</c>, and pinned that as a
    /// known-wrong row. This is that row flipped.
    /// </remarks>
    @Fact
    func Issue4134_AReorderedNamedArgumentIntoAParamsSlotEvaluatesInSourceOrder() {
        const source = `package Issue4134.Order
import System
import Issue4086.CSharp

func firstArgument() string {
    Console.Write("first|")
    return "first"
}

func secondArgument() int32 {
    Console.Write("second|")
    return 2
}

func refIndex() int32 {
    Console.Write("ref|")
    return 0
}

Console.WriteLine(MethodGroupOutputInference.EvaluationOrder(
    items: firstArgument(),
    value: secondArgument()))
let refValues = []int32{2}
Console.WriteLine(MethodGroupOutputInference.RefEvaluationOrder(
    items: firstArgument(),
    value: ref refValues[refIndex()]))
Console.WriteLine(refValues[0])`
        Assert.Equal(
            "first|second|2:first${Environment.NewLine}" +
                "first|ref|12:first${Environment.NewLine}" +
                "12${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        )
    }

    /// Reviewer finding on #4142: expanded overload resolution can select a
    /// `params Handler[]` candidate through a CONSTRAINED receiver — both
    /// the instance and the static-abstract-interface spelling — for a custom
    /// `[InterpolatedStringHandler]` element. Both constrained dispatch
    /// paths rebound only `FormattableString`, so the selected handler
    /// type and the argument actually packed into the expanded array
    /// disagreed and conversion failed.
    /// @remarks Measured on the parent of the fix: `GS0155 Cannot convert type
    /// 'string' to 'HelperLib2.MatrixHandler'`, twice, for both the
    /// constrained-instance and the constrained-static spelling. Both are
    /// covered in one fact because the fix is one helper call added at both
    /// sites, not two divergent patches.
    @Fact
    func Issue4142_ConstrainedDispatchRebindsCustomHandlersBeforeParamsExpansion() {
        const source = `package Issue4142.ConstrainedHandler
import System
import Issue4086.CSharp

func viaConstrainedInstance[TRecv IInstanceOverloads](recv TRecv) string {
    return recv.HandlerParams(3, "first=${7}", "second=${8}")
}

func viaConstrainedStatic[TRecv IStaticOverloads[TRecv]]() string {
    return TRecv.HandlerParams(3, "first=${7}", "second=${8}")
}

Console.WriteLine(viaConstrainedInstance[InstanceOverloads](InstanceOverloads()))
Console.WriteLine(viaConstrainedStatic[StaticOverloads]())`
        Assert.Equal(
            "3:first=7,second=8${Environment.NewLine}" + "3:first=7,second=8${Environment.NewLine}",
            CompileAndRunWithSiblingCs(
                Issue4086CsSource,
                source,
                "Issue4086.CSharp",
                ignoredErrorScope: "viaConstrainedStatic"
            )
        )
    }

    /// Issue #4134: an interpolated string bound to a `params` array of
    /// interpolated-string HANDLERS, positionally and through a reordered
    /// named argument. Neither spelling bound at all before this change
    /// (`GS0159`); `csc` compiles and runs both.
    @Fact
    func Issue4134_AParamsArrayOfInterpolatedStringHandlersBindsPositionallyAndByName() {
        const source = `package Issue4134.HandlerParams
import System
import Issue4086.CSharp

func firstArgument() string {
    Console.Write("first|")
    return "first"
}

func secondArgument() int32 {
    Console.Write("second|")
    return 2
}

Console.WriteLine(MethodGroupOutputInference.HandlerParams(
    3,
    "first=${7}",
    "second=${8}"))
Console.WriteLine(MethodGroupOutputInference.HandlerParams(
    handlers: "named=${firstArgument()}",
    value: secondArgument()))`
        Assert.Equal(
            "3:first=7,second=8${Environment.NewLine}" + "first|second|2:named=first${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        )
    }

    /// Issue #4134: a handler parameter carrying
    /// `InterpolatedStringHandlerArgument` forwards an EARLIER argument
    /// into the handler's constructor. All three spellings must evaluate in
    /// source order — `first|prefix|handler|` — and the synthesized
    /// extension receiver must be evaluated exactly ONCE.
    @Fact
    func Issue4134_AForwardedInterpolatedStringHandlerEvaluatesInSourceOrder() {
        const source = `package Issue4134.Forwarding
import System
import Issue4086.CSharp

func nonForwarded() int32 {
    Console.Write("first|")
    return 1
}

func forwarded() string {
    Console.Write("prefix|")
    return "p"
}

func hole() int32 {
    Console.Write("handler|")
    return 3
}

func receiver() InstanceOverloads {
    Console.Write("receiver|")
    return InstanceOverloads()
}

Console.WriteLine(MethodGroupOutputInference.ForwardedHandlerOrder(
    first: nonForwarded(),
    prefix: forwarded(),
    handler: "hole=${hole()}",
    rest: "tail"))
Console.WriteLine(MethodGroupOutputInference.ForwardedHandlerOrder(
    nonForwarded(),
    forwarded(),
    "hole=${hole()}",
    "tail"))
Console.WriteLine(MethodGroupOutputInference.ForwardedHandlerOrder(
    nonForwarded(),
    forwarded(),
    "hole=${hole()}",
    []object{"tail"}))
Console.WriteLine(receiver().ForwardedHandlerExtension(
    rest: "tail",
    first: nonForwarded(),
    prefix: forwarded(),
    handler: "hole=${hole()}"))`
        Assert.Equal(
            "first|prefix|handler|1:p:hole=3:tail${Environment.NewLine}" +
                "first|prefix|handler|1:p:hole=3:tail${Environment.NewLine}" +
                "first|prefix|handler|1:p:hole=3:tail${Environment.NewLine}" +
                "receiver|first|prefix|handler|1:p:hole=3:tail${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        )
    }

    /// Issue #4134: a named `FormattableString` in a reordered expanded
    /// call keeps its own lexical position — `first|format|second|` —
    /// and still lowers to `FormattableStringFactory.Create`.
    @Fact
    func Issue4134_ANamedFormattableStringInAReorderedExpandedCallKeepsItsPosition() {
        const source = `package Issue4134.Formattable
import System
import Issue4086.CSharp

func firstArgument() string {
    Console.Write("first|")
    return "first"
}

func secondArgument() int32 {
    Console.Write("second|")
    return 2
}

func holeArgument() int32 {
    Console.Write("format|")
    return 7
}

Console.WriteLine(MethodGroupOutputInference.FormattableOrder(
    rest: firstArgument(),
    item: "item=${holeArgument()}",
    value: secondArgument()))`
        Assert.Equal(
            "first|format|second|item={0}:7:2:first${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        )
    }

    /// Issue #4134, the CS8950 rule: a handler-forwarded argument that occurs
    /// AT OR AFTER the handler expression is rejected, and rejected with a
    /// message that names the rule rather than the parent's
    /// `GS0159 Cannot find function`.
    @Fact
    func Issue4134_AHandlerForwardedArgumentAfterTheHandlerIsRejected() {
        const source = `package Issue4134.ForwardReference
import Issue4086.CSharp

MethodGroupOutputInference.ForwardedHandlerOrder(
    handler: "bad=${1}",
    prefix: "p",
    first: 1,
    rest: "tail")`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        // Count, not presence: exactly one diagnostic line, and it is the
        // forward-reference rule naming the parameter it could not forward.
        Assert.Equal(1, diagnostics.Count((d string) -> d.Contains(": error GS", StringComparison.Ordinal)))
        Assert.Equal(
            1,
            diagnostics.Count(
                (d string) -> d.Contains("GS0221", StringComparison.Ordinal) && d.Contains(
                    "preceding argument",
                    StringComparison.Ordinal
                )
            )
        )
    }

    /// Blast-radius CONTROL for #4134, and deliberately green on both sides:
    /// the expanded-argument reordering must fire ONLY where a `params`
    /// slot is actually expanded from reordered source, and must leave every
    /// neighbouring call shape exactly as it was.
    /// @remarks This fact does not pin the fix — it pins the fix's BOUNDARY. Each
    /// row was compiled and run under `main` and under this branch and
    /// produces the same answer on both, and that answer is `csc`'s: an
    /// ordinary positional call, the same call with names in source order, the
    /// same call with names REORDERED but no `params` slot, a
    /// `params` call written positionally, and a reordered named call
    /// whose `params` slot is given an EXPLICIT array, so nothing is
    /// expanded.
    ///
    /// The one neighbour that does move is the single-element expanded
    /// form, pinned by
    /// (cref:Issue4134_AReorderedNamedArgumentIntoAParamsSlotEvaluatesInSourceOrder).
    /// Keeping the five unmoved shapes here means a future change to the
    /// reordering cannot widen silently.
    @Fact
    func Issue4134_OrdinaryAndPositionalCallsKeepTheirEvaluationOrder() {
        const source = `package Issue4134.Control
import System
import Issue4086.CSharp

func a() string {
    Console.Write("a|")
    return "a"
}

func b() int32 {
    Console.Write("b|")
    return 2
}

func c() string {
    Console.Write("c|")
    return "c"
}

Console.WriteLine(MethodGroupOutputInference.Plain(a(), b(), c()))
Console.WriteLine(MethodGroupOutputInference.Plain(a: a(), b: b(), c: c()))
Console.WriteLine(MethodGroupOutputInference.Plain(c: c(), a: a(), b: b()))
Console.WriteLine(MethodGroupOutputInference.EvaluationOrder(b(), a(), c()))
Console.WriteLine(MethodGroupOutputInference.EvaluationOrder(
    items: []object{a(), c()},
    value: b()))`
        Assert.Equal(
            "a|b|c|a:2:c${Environment.NewLine}" +
                "a|b|c|a:2:c${Environment.NewLine}" +
                "c|a|b|a:2:c${Environment.NewLine}" +
                "b|a|c|2:a,c${Environment.NewLine}" +
                "a|c|b|2:a,c${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue4086CsSource, source, "Issue4086.CSharp")
        )
    }

    @Theory
    @InlineData(false, `301
302
311
312
321
322
331
332
341
342
351
352
`)
    @InlineData(true, `201
202
211
212
121
122
221
222
231
232
241
242
`)
    func Issue3076_GenericStaticClrStores_CompileAndRun(throughTypeParameter bool, expected string) {
        let source = Issue3076Source("Issue3076.CSharp", throughTypeParameter)
        Assert.Equal(expected, CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp"))
    }

    @Fact
    func Issue3076_GenericStaticClrStores_PreserveContainerThroughSideEffectSpilling() {
        const source = `import Issue3076.CSharp
import System

func PropertyMarker() int32 { return 401 }
func FieldMarker() int32 { return 402 }

func Store[T]() {
    Issue3076GenericStaticSlot[T].Property = PropertyMarker()
    Issue3076GenericStaticSlot[T].Field = FieldMarker()
}

Issue3076GenericStaticSlot[int32].Property = 101
Issue3076GenericStaticSlot[int32].Field = 102
Issue3076GenericStaticSlot[object].Property = 121
Issue3076GenericStaticSlot[object].Field = 122
Store[int32]()
Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
Console.WriteLine(Issue3076GenericStaticSlot[object].Field)`
        Assert.Equal(
            "401${Environment.NewLine}402${Environment.NewLine}121${Environment.NewLine}122${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp")
        )
    }

    @Fact
    func Issue3076_GenericStaticClrStores_PreserveContainerThroughNullCoalescingAssignment() {
        const source = `import Issue3076.CSharp
import System

func StoreIfMissing[T]() {
    Issue3076GenericStaticSlot[T].TextProperty ??= "property"
    Issue3076GenericStaticSlot[T].TextField ??= "field"
}

Issue3076GenericStaticSlot[int32].TextProperty = nil
Issue3076GenericStaticSlot[int32].TextField = nil
Issue3076GenericStaticSlot[object].TextProperty = "object-property"
Issue3076GenericStaticSlot[object].TextField = "object-field"
StoreIfMissing[int32]()
Console.WriteLine(Issue3076GenericStaticSlot[int32].TextProperty)
Console.WriteLine(Issue3076GenericStaticSlot[int32].TextField)
Console.WriteLine(Issue3076GenericStaticSlot[object].TextProperty)
Console.WriteLine(Issue3076GenericStaticSlot[object].TextField)`
        Assert.Equal(
            "property${Environment.NewLine}field${Environment.NewLine}object-property${Environment.NewLine}object-field${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp")
        )
    }

    @Fact
    func Issue3076_GenericStaticClrStores_PreserveContainerThroughAsyncSpilling() {
        const source = `import Issue3076.CSharp
import System

async func StoreAsync[T]() {
    Issue3076GenericStaticSlot[T].Property = await Issue3076AsyncValues.Get(501)
    Issue3076GenericStaticSlot[T].Field = await Issue3076AsyncValues.Get(502)
}

Issue3076GenericStaticSlot[int32].Property = 101
Issue3076GenericStaticSlot[int32].Field = 102
Issue3076GenericStaticSlot[object].Property = 121
Issue3076GenericStaticSlot[object].Field = 122
StoreAsync[int32]().GetAwaiter().GetResult()
Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
Console.WriteLine(Issue3076GenericStaticSlot[object].Field)`
        Assert.Equal(
            "501${Environment.NewLine}502${Environment.NewLine}121${Environment.NewLine}122${Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp")
        )
    }

    @Theory
    @InlineData(false, `301
302
311
312
321
322
331
332
341
342
351
352
`)
    @InlineData(true, `201
202
211
212
121
122
221
222
231
232
241
242
`)
    func Issue3076_GenericStaticClrStores_Evaluate(throughTypeParameter bool, expected string) {
        let workDir = CreateWorkDir("issue3076_evaluate_")
        try {
            let sourcePath = Path.Combine(workDir, "test.gs")
            File.WriteAllText(sourcePath, Issue3076Source("GSharp.Compiler.Tests", throughTypeParameter))
            let (exitCode, output) = RunCompiler([]string{sourcePath})
            Assert.Equal(0, exitCode)
            Assert.Equal(expected + "Success.${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
        } finally {
            TryDelete(workDir)
        }
    }

    @Fact
    func ImportedMemberMatrix_GenericImportedInterfaceMethodAndInterfaceObjectMembers_CompileAndRun() {
        const csSource = `namespace ImportedMemberMatrix.CSharp
{
    public interface IStore
    {
        void Put<T>(T value);
    }

    public interface IHasDefault
    {
        int Ping() => 7;
    }

    public sealed class DefaultThing : IHasDefault
    {
        public override string ToString() => "thing";
    }
}`
        const gsSource = `package ImportedMemberMatrix.Probe
import ImportedMemberMatrix.CSharp
import System

class Store : IStore {
    func Put[T](value T) { Console.WriteLine(value.ToString()) }
}

var store IStore = Store()
store.Put[int32](42)
store.Put[string]("ok")

var thing IHasDefault = DefaultThing()
Console.WriteLine(thing.Ping())
Console.WriteLine(thing.ToString())
Console.WriteLine(thing.GetHashCode() == thing.GetHashCode())
Console.WriteLine(thing.Equals(thing))`
        Assert.Equal(
            "42${Environment.NewLine}ok${Environment.NewLine}7${Environment.NewLine}thing${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_LinqExtensionsOnImportedGenericEnumerableReceivers_CompileAndRun() {
        const csSource = `namespace ImportedMemberMatrix.CSharp
{
    public sealed class Item
    {
        public string Name { get; set; } = "";
        public int Rank { get; set; }
    }
}`
        const gsSource = `package ImportedMemberMatrix.Probe
import ImportedMemberMatrix.CSharp
import System
import System.Collections.Generic
import System.Linq

var xs = List[Item]()
var b = Item()
b.Name = "b"
b.Rank = 2
xs.Add(b)
var a = Item()
a.Name = "a"
a.Rank = 1
xs.Add(a)

var collection ICollection[Item] = xs
var enumerable IEnumerable[Item] = collection
Console.WriteLine(enumerable.FirstOrDefault() == nil)
Console.WriteLine(collection.Any())
Console.WriteLine(enumerable.Count())
Console.WriteLine(enumerable.Where(func(i Item) bool { return i.Rank > 0 }).Count())
Console.WriteLine(enumerable.OrderBy(func(i Item) int32 { return i.Rank }).Count())`
        Assert.Equal(
            "False${Environment.NewLine}True${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_ImportedRecordClassAndRecordStruct_WithCopy_CompileAndRun() {
        const csSource = `namespace ImportedMemberMatrix.CSharp
{
    public record PersonRecord(string Name, int Age);
    public readonly record struct PointRecord(int X, int Y);
}`
        const gsSource = `package ImportedMemberMatrix.Probe
import ImportedMemberMatrix.CSharp
import System

var p = PersonRecord("ana", 1)
var p2 = p with { Age = 2 }
Console.WriteLine(p.Name)
Console.WriteLine(p.Age)
Console.WriteLine(p2.Name)
Console.WriteLine(p2.Age)

var pt = PointRecord(3, 4)
var pt2 = pt with { Y = 9 }
Console.WriteLine(pt.X)
Console.WriteLine(pt.Y)
Console.WriteLine(pt2.X)
Console.WriteLine(pt2.Y)`
        Assert.Equal(
            "ana${Environment.NewLine}1${Environment.NewLine}ana${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}4${Environment.NewLine}3${Environment.NewLine}9${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_SourceOnlyDataAndLinqReceivers_StillBind() {
        const source = `package ImportedMemberMatrix.SourceOnly
import System
import System.Collections.Generic
import System.Linq

data class SourceItem(Name string, Rank int32) {}

var item = SourceItem("a", 1)
var updated = item with { Name = "b" }
Console.WriteLine(item.Name)
Console.WriteLine(updated.Name)

var xs = List[SourceItem]()
xs.Add(item)
xs.Add(updated)
Console.WriteLine(xs.FirstOrDefault().Name)
Console.WriteLine(xs.Where(func(i SourceItem) bool { return i.Rank == 1 }).Count())
Console.WriteLine(xs.OrderBy(func(i SourceItem) string { return i.Name }).Count())`
        Assert.Equal(
            "a${Environment.NewLine}b${Environment.NewLine}a${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ImportedMemberMatrix_NonDataImportedClass_WithCopy_StillRejected() {
        const csSource = `namespace ImportedMemberMatrix.CSharp
{
    public sealed class PlainClass
    {
        public string Name { get; set; } = "";
    }
}`
        const gsSource = `package ImportedMemberMatrix.Probe
import ImportedMemberMatrix.CSharp

var value = PlainClass()
value.Name = "before"
var copy = value with { Name = "after" }`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0161", StringComparison.Ordinal))
        Assert.Contains(diagnostics, (d string) -> d.Contains("data class or data struct", StringComparison.Ordinal))
    }

    @Fact
    func ImportedMemberMatrix_OptionalDefaults_AreResolvedAndEmittedAcrossCallableKinds() {
        const csSource = `using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;

namespace ImportedOptional.CSharp
{
    public enum Tone { First = 1, Second = 2 }

    public record ProgressMessage(int Count, string Text = "ready");

    public delegate string OptionalDelegate(bool enabled = true);

    public sealed class OptionalApi
    {
        private readonly int seed;
        private string? indexed;

        public OptionalApi(int seed, int add = 5) => this.seed = seed + add;

        public int Instance(int value = 7) => seed + value;

        public static string Constants(
            string text = "ok",
            Tone tone = Tone.Second,
            decimal amount = 12.5m,
            CancellationToken token = default) =>
            $"{text}:{(int)tone}:{amount}:{token.CanBeCanceled}";

        public static long Date([Optional, DateTimeConstant(123)] DateTime value) => value.Ticks;

        public static bool MissingValue([Optional] object value) =>
            ReferenceEquals(value, Missing.Value);

        public static int Params(int prefix = 2, params int[] values) =>
            prefix + values.Length;

        public string this[int x, int y = 4]
        {
            get => indexed ?? $"{x}:{y}";
            set => indexed = $"{x}:{y}:{value}";
        }
    }
}`
        const gsSource = `package ImportedOptional.Probe
import ImportedOptional.CSharp
import System

var message = ProgressMessage(3)
var api = OptionalApi(10)
var callback OptionalDelegate = func(enabled bool) string {
    return enabled ? "yes" : "no"
}

Console.WriteLine(message.Text)
Console.WriteLine(api.Instance())
Console.WriteLine(OptionalApi.Constants())
Console.WriteLine(OptionalApi.Date())
Console.WriteLine(OptionalApi.MissingValue())
Console.WriteLine(OptionalApi.Params())
Console.WriteLine(callback())
Console.WriteLine(api[3])
api[3] = "set"
Console.WriteLine(api[3])`
        Assert.Equal(
            "ready${Environment.NewLine}22${Environment.NewLine}ok:2:12.5:False${Environment.NewLine}123${Environment.NewLine}True${Environment.NewLine}2${Environment.NewLine}yes${Environment.NewLine}3:4${Environment.NewLine}3:4:set${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedOptional.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_OptionalOverloads_PreserveAmbiguityAndRequiredDiagnostics() {
        const csSource = `namespace ImportedOptionalDiagnostics.CSharp
{
    public static class Calls
    {
        public static int Ambiguous(string? value = null) => 1;
        public static long Ambiguous(System.Uri? value = null) => 2;
        public static int Required(int value, int extra = 2) => value + extra;
    }
}`
        const ambiguousSource = `package ImportedOptionalDiagnostics.Probe
import ImportedOptionalDiagnostics.CSharp

var a = Calls.Ambiguous()`
        let ambiguityDiagnostics = CompileExpectingErrorsWithSiblingCs(
            csSource,
            ambiguousSource,
            "ImportedOptionalDiagnostics.CSharp"
        )
        Assert.Contains(ambiguityDiagnostics, (d string) -> d.Contains("ambiguous", StringComparison.OrdinalIgnoreCase))
        const requiredSource = `package ImportedOptionalDiagnostics.Probe
import ImportedOptionalDiagnostics.CSharp

var b = Calls.Required()`
        let requiredDiagnostics = CompileExpectingErrorsWithSiblingCs(
            csSource,
            requiredSource,
            "ImportedOptionalDiagnostics.CSharp"
        )
        Assert.Contains(requiredDiagnostics, (d string) -> d.Contains("Required", StringComparison.Ordinal))
    }

    @Fact
    func ImportedMemberMatrix_InParameterDelegate_LambdaCompilesAndRuns() {
        const csSource = `namespace ImportedInDelegate.CSharp
{
    public delegate bool Predicate(in int value);

    public static class Api
    {
        public static bool Invoke(Predicate predicate)
        {
            var value = 100;
            return predicate(in value);
        }
    }
}`
        const gsSource = `package ImportedInDelegate.Probe
import ImportedInDelegate.CSharp
import System

Console.WriteLine(Api.Invoke((in value int32) -> value == 100))`
        Assert.Equal(
            "True${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedInDelegate.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_InParameterDelegate_RejectsMismatchedLambdaRefKind() {
        const csSource = `namespace ImportedInDelegateMismatch.CSharp
{
    public delegate bool Predicate(in int value);

    public static class Api
    {
        public static bool Invoke(Predicate predicate) => true;
    }
}`
        const gsSource = `package ImportedInDelegateMismatch.Probe
import ImportedInDelegateMismatch.CSharp

var result = Api.Invoke((ref value int32) -> value == 100)`
        let diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gsSource, "ImportedInDelegateMismatch.CSharp")
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155", StringComparison.Ordinal))
    }

    @Fact
    func ImportedMemberMatrix_RefAndOutParameterDelegates_LambdasCompileAndRun() {
        const csSource = `namespace ImportedRefOutDelegates.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate bool OutPredicate(out int value);
    public delegate void ValueAction(int value);

    public static class Api
    {
        public static int Apply(RefAction action)
        {
            var value = 40;
            action(ref value);
            return value;
        }

        public static int Read(OutPredicate predicate) =>
            predicate(out var value) ? value : -1;

        public static string Kind(RefAction action) => "ref";
        public static string Kind(ValueAction action) => "value";
    }
}`
        const gsSource = `package ImportedRefOutDelegates.Probe
import ImportedRefOutDelegates.CSharp
import System

Console.WriteLine(Api.Apply((ref value int32) -> { value = value + 2 }))
Console.WriteLine(Api.Read((out value int32) -> {
    value = 42
    return true
}))
Console.WriteLine(Api.Kind((ref value int32) -> { value = value + 1 }))
Console.WriteLine(Api.Kind((value int32) -> { }))`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}ref${Environment.NewLine}value${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedRefOutDelegates.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_GenericRefOutInParameterDelegates_LambdasCompileAndRun() {
        const csSource = `namespace ImportedGenericRefDelegates.CSharp
{
    public delegate void RefAction<T>(ref T value);
    public delegate bool OutPredicate<T>(out T value);
    public delegate bool InPredicate<T>(in T value);

    public static class Api
    {
        public static T Apply<T>(T value, RefAction<T> action)
        {
            action(ref value);
            return value;
        }

        public static T Read<T>(OutPredicate<T> predicate)
        {
            predicate(out var value);
            return value;
        }

        public static bool Test<T>(T value, InPredicate<T> predicate) =>
            predicate(in value);
    }
}`
        const gsSource = `package ImportedGenericRefDelegates.Probe
import ImportedGenericRefDelegates.CSharp
import System

func Apply[T](value T, replacement T) T {
    return Api.Apply[T](value, (ref current T) -> { current = replacement })
}

func Read[T](value T) T {
    var predicate OutPredicate[T] = (out result T) -> {
        result = value
        return true
    }
    return Api.Read[T](predicate)
}

func Test[T](value T) bool {
    var predicate InPredicate[T] = (in current T) -> current.ToString() == value.ToString()
    return Api.Test[T](value, predicate)
}

Console.WriteLine(Apply[int32](40, 42))
Console.WriteLine(Read[int32](42))
Console.WriteLine(Test[int32](42))`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedGenericRefDelegates.CSharp")
        )
    }

    @Fact
    func ImportedMemberMatrix_GenericRefOutInParameterDelegates_ReportRefKindMismatches() {
        const csSource = `namespace ImportedGenericRefDelegateMismatch.CSharp
{
    public delegate void RefAction<T>(ref T value);
    public delegate bool OutPredicate<T>(out T value);
    public delegate bool InPredicate<T>(in T value);
}`
        let sources = []string{`package ImportedGenericRefDelegateMismatch.RefProbe
import ImportedGenericRefDelegateMismatch.CSharp

func Bad[T]() {
    var callback RefAction[T] = (value T) -> { }
}`, `package ImportedGenericRefDelegateMismatch.OutProbe
import ImportedGenericRefDelegateMismatch.CSharp

func Bad[T]() {
    var callback OutPredicate[T] = (ref value T) -> true
}`, `package ImportedGenericRefDelegateMismatch.InProbe
import ImportedGenericRefDelegateMismatch.CSharp

func Bad[T]() {
    var callback InPredicate[T] = (out value T) -> {
        return true
    }
}`}
        for source in sources {
            let diagnostics = CompileExpectingErrorsWithSiblingCs(
                csSource,
                source,
                "ImportedGenericRefDelegateMismatch.CSharp"
            )
            Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155", StringComparison.Ordinal))
            Assert.DoesNotContain(diagnostics, (d string) -> d.Contains("GS0159", StringComparison.Ordinal))
            Assert.DoesNotContain(diagnostics, (d string) -> d.Contains("GS9998", StringComparison.Ordinal))
        }
    }

    @Fact
    func ImportedMemberMatrix_RefAndOutParameterDelegates_ReportConversionDiagnosticForMismatchedRefKinds() {
        const csSource = `namespace ImportedRefOutDelegateMismatch.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate bool OutPredicate(out int value);

    public static class Api
    {
        public static void Apply(RefAction action) { }
        public static bool Read(OutPredicate predicate) => true;
    }
}`
        let sources = []string{`package ImportedRefOutDelegateMismatch.RefProbe
import ImportedRefOutDelegateMismatch.CSharp

Api.Apply((value int32) -> { })`, `package ImportedRefOutDelegateMismatch.OutProbe
import ImportedRefOutDelegateMismatch.CSharp

var result = Api.Read((ref value int32) -> true)`, `package ImportedRefOutDelegateMismatch.ValueProbe
import ImportedRefOutDelegateMismatch.CSharp

let callback (int32) -> void = (value int32) -> { }
Api.Apply(callback)`}
        for source in sources {
            let diagnostics = CompileExpectingErrorsWithSiblingCs(
                csSource,
                source,
                "ImportedRefOutDelegateMismatch.CSharp"
            )
            Assert.Contains(diagnostics, (d string) -> d.Contains("GS0155", StringComparison.Ordinal))
            Assert.DoesNotContain(diagnostics, (d string) -> d.Contains("GS0159", StringComparison.Ordinal))
        }
    }

    @Fact
    func SourceNamedRefOutInParameterDelegates_LambdasCompileAndRun() {
        const source = `package SourceRefKindDelegates.Probe
import System

delegate RefAction(ref value int32);
delegate OutAction(out value int32);
delegate InPredicate(in value int32) bool;
delegate GenericRefAction[T](ref value T);
delegate GenericOutAction[T](out value T);
delegate GenericInPredicate[T](in value T) bool;

var refAction RefAction = (ref value int32) -> { value = value + 1 }
var outAction OutAction = (out value int32) -> { value = 42 }
var inPredicate InPredicate = (in value int32) -> value == 42
var genericRefAction GenericRefAction[int32] = (ref value int32) -> { value = value + 1 }
var genericOutAction GenericOutAction[int32] = (out value int32) -> { value = 42 }
var genericInPredicate GenericInPredicate[int32] = (in value int32) -> value == 42

var value = 41
refAction(ref value)
outAction(out value)
Console.WriteLine(inPredicate(in value))
value = 41
genericRefAction(ref value)
genericOutAction(out value)
Console.WriteLine(genericInPredicate(in value))`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SourceNamedRefOutInParameterDelegates_MethodGroupsCompileAndRun() {
        const source = `package SourceRefKindMethodGroups.Probe
import System

delegate RefAction(ref value int32);
delegate OutAction(out value int32);
delegate InPredicate(in value int32) bool;
delegate GenericRefAction[T](ref value T);
delegate GenericOutAction[T](out value T);
delegate GenericInPredicate[T](in value T) bool;

func AddOne(ref value int32) { value = value + 1 }
func Set42(out value int32) { value = 42 }
func Is42(in value int32) bool { return value == 42 }

var refAction RefAction = AddOne
var outAction OutAction = Set42
var inPredicate InPredicate = Is42
var genericRefAction GenericRefAction[int32] = AddOne
var genericOutAction GenericOutAction[int32] = Set42
var genericInPredicate GenericInPredicate[int32] = Is42

var value = 41
refAction(ref value)
Console.WriteLine(value)
outAction(out value)
Console.WriteLine(value)
Console.WriteLine(inPredicate(in value))
value = 41
genericRefAction(ref value)
Console.WriteLine(value)
genericOutAction(out value)
Console.WriteLine(value)
Console.WriteLine(genericInPredicate(in value))`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ImportedRefOutInParameterDelegates_SourceMethodGroupsCompileAndRun() {
        const csSource = `using System;

namespace ImportedDelegateSourceMethodGroups.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate void OutAction(out int value);
    public delegate bool InPredicate(in int value);
    public delegate void GenericRefAction<T>(ref T value);

    public static class Api
    {
        public static void Apply(RefAction action, ref int value) => action(ref value);
        public static void Fill(OutAction action, out int value) => action(out value);
        public static bool Test(InPredicate predicate, in int value) => predicate(in value);
        public static string Pick(RefAction action) => "ref";
        public static string Pick(Action<int> action) => "value";
    }
}`
        const source = `package ImportedDelegateSourceMethodGroups.Probe
import System
import ImportedDelegateSourceMethodGroups.CSharp

func AddOne(ref value int32) { value = value + 1 }
func Set42(out value int32) { value = 42 }
func Is42(in value int32) bool { return value == 42 }

var genericRefAction GenericRefAction[int32] = AddOne
var value = 41
Api.Apply(AddOne, ref value)
Console.WriteLine(value)
Api.Fill(Set42, out value)
Console.WriteLine(value)
Console.WriteLine(Api.Test(Is42, in value))
value = 41
genericRefAction(ref value)
Console.WriteLine(value)
Console.WriteLine(Api.Pick(AddOne))`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}42${Environment.NewLine}ref${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, source, "ImportedDelegateSourceMethodGroups.CSharp")
        )
    }

    @Fact
    func ImportedRefOutInParameterDelegates_ClrMethodGroupsCompileAndRun() {
        const csSource = `namespace ImportedClrMethodGroups.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate void OutAction(out int value);
    public delegate bool InPredicate(in int value);
    public delegate void GenericRefAction<T>(ref T value);

    public static class Methods
    {
        public static void AddOne(ref int value) => value++;
        public static void Set42(out int value) => value = 42;
        public static bool Is42(in int value) => value == 42;
    }

    public static class Api
    {
        public static void Apply(RefAction action, ref int value) => action(ref value);
        public static void Fill(OutAction action, out int value) => action(out value);
        public static bool Test(InPredicate predicate, in int value) => predicate(in value);
    }
}`
        const source = `package ImportedClrMethodGroups.Probe
import System
import ImportedClrMethodGroups.CSharp

var refAction RefAction = Methods.AddOne
var outAction OutAction = Methods.Set42
var inPredicate InPredicate = Methods.Is42
var genericRefAction GenericRefAction[int32] = Methods.AddOne

var value = 41
refAction(ref value)
Console.WriteLine(value)
outAction(out value)
Console.WriteLine(value)
Console.WriteLine(Api.Test(inPredicate, in value))
value = 41
Api.Apply(Methods.AddOne, ref value)
Console.WriteLine(value)
Api.Fill(Methods.Set42, out value)
Console.WriteLine(value)
Console.WriteLine(Api.Test(Methods.Is42, in value))
value = 41
genericRefAction(ref value)
Console.WriteLine(value)`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}42${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, source, "ImportedClrMethodGroups.CSharp")
        )
    }

    @Fact
    func ImportedGenericFunction_InfersTypeFromSingleCandidateMethodGroupParameters() {
        const csSource = `using System;

namespace ImportedSingleMethodGroupInference.CSharp
{
    public static class Api
    {
        public static void RunOnly<T>(Action<T> action) => action(default!);
        public static void Accept<TIn, TOut>(Func<TIn, TOut> function) { }
        public static void Emit(int value) => Console.WriteLine("emit" + value);
    }
}`
        const source = `package ImportedSingleMethodGroupInference.Probe
import System
import ImportedSingleMethodGroupInference.CSharp

func EmitSource(value int32) { Console.WriteLine("source" + value.ToString()) }
async func AsyncText(value int32) string { return value.ToString() }

Api.RunOnly(Api.Emit)
Api.RunOnly(EmitSource)
Api.Accept(AsyncText)`
        Assert.Equal(
            "emit0${Environment.NewLine}source0${Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, source, "ImportedSingleMethodGroupInference.CSharp")
        )
    }

    @Fact
    func SourceAndImportedMethodGroups_RefKindMismatchesStayDiagnosed() {
        const sourceDefined = `package SourceMethodGroupRefKindMismatch.Probe

delegate RefAction(ref value int32);
delegate OutAction(out value int32);
delegate InPredicate(in value int32) bool;

func AddOne(ref value int32) { value = value + 1 }
func Set42(out value int32) { value = 42 }
func Is42Ref(ref value int32) bool { return value == 42 }

var refCallback RefAction = Set42
var outCallback OutAction = AddOne
var inCallback InPredicate = Is42Ref`
        const csSource = `namespace ImportedMethodGroupRefKindMismatch.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate void OutAction(out int value);
    public delegate bool InPredicate(in int value);

    public static class Methods
    {
        public static void AddOne(ref int value) => value++;
        public static void Set42(out int value) => value = 42;
        public static bool Is42Ref(ref int value) => value == 42;
    }

    public static class Api
    {
        public static void Apply(RefAction action) { }
    }
}`
        const imported = `package ImportedMethodGroupRefKindMismatch.Probe
import ImportedMethodGroupRefKindMismatch.CSharp

func SetSource42(out value int32) { value = 42 }

var refCallback RefAction = Methods.Set42
var outCallback OutAction = Methods.AddOne
var inCallback InPredicate = Methods.Is42Ref
Api.Apply(SetSource42)
Api.Apply(Methods.Set42)`
        let workDir = CreateWorkDir("method_group_ref_kind_mismatch_")
        try {
            let siblingDll = BuildCsLibrary(workDir, csSource, "ImportedMethodGroupRefKindMismatch.CSharp")
            let sourceDiagnostics = CompileExpectingErrors(sourceDefined, Array.Empty[string](), workDir)
            let importedDiagnostics = CompileExpectingErrors(imported, []string{siblingDll}, workDir)
            Assert.Equal(Enumerable.Repeat("GS0155", 3), GetDiagnosticIds(sourceDiagnostics))
            Assert.Equal(
                []string{"GS0218", "GS0218", "GS0218", "GS0155", "GS0218"},
                GetDiagnosticIds(importedDiagnostics)
            )
        } finally {
            TryDelete(workDir)
        }
    }

    @Fact
    func SourceNamedRefOutInParameterDelegates_MatchImportedMismatchDiagnostics() {
        const csSource = `namespace RefKindDelegateParity.CSharp
{
    public delegate void RefAction(ref int value);
    public delegate void OutAction(out int value);
    public delegate bool InPredicate(in int value);
    public delegate void GenericRefAction<T>(ref T value);
    public delegate void GenericOutAction<T>(out T value);
    public delegate bool GenericInPredicate<T>(in T value);
}`
        const sourceDefined = `package SourceRefKindDelegateMismatch.Probe

delegate RefAction(ref value int32);
delegate OutAction(out value int32);
delegate InPredicate(in value int32) bool;
delegate GenericRefAction[T](ref value T);
delegate GenericOutAction[T](out value T);
delegate GenericInPredicate[T](in value T) bool;

var refCallback RefAction = (value int32) -> { }
var outCallback OutAction = (ref value int32) -> { }
var inCallback InPredicate = (value int32) -> true
var genericRefCallback GenericRefAction[int32] = (value int32) -> { }
var genericOutCallback GenericOutAction[int32] = (ref value int32) -> { }
var genericInCallback GenericInPredicate[int32] = (value int32) -> true`
        const imported = `package ImportedRefKindDelegateMismatch.Probe
import RefKindDelegateParity.CSharp

var refCallback RefAction = (value int32) -> { }
var outCallback OutAction = (ref value int32) -> { }
var inCallback InPredicate = (value int32) -> true
var genericRefCallback GenericRefAction[int32] = (value int32) -> { }
var genericOutCallback GenericOutAction[int32] = (ref value int32) -> { }
var genericInCallback GenericInPredicate[int32] = (value int32) -> true`
        let workDir = CreateWorkDir("ref_kind_delegate_parity_")
        try {
            let siblingDll = BuildCsLibrary(workDir, csSource, "RefKindDelegateParity.CSharp")
            let sourceDiagnostics = CompileExpectingErrors(sourceDefined, Array.Empty[string](), workDir)
            let importedDiagnostics = CompileExpectingErrors(imported, []string{siblingDll}, workDir)
            Assert.Equal(Enumerable.Repeat("GS0155", 6), GetDiagnosticIds(sourceDiagnostics))
            Assert.Equal(GetDiagnosticIds(importedDiagnostics), GetDiagnosticIds(sourceDiagnostics))
        } finally {
            TryDelete(workDir)
        }
    }

    @Fact
    func NamedDelegate_OmittedOptionalArgument_UsesDeclaredDefault() {
        const source = `package OptionalDelegate.Probe
import System

delegate Toggle(enabled bool = true) string;

var callback Toggle = func(enabled bool) string {
    return enabled ? "yes" : "no"
}

Console.WriteLine(callback())`
        Assert.Equal("yes${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private const Issue4086CsSource string = (`namespace Issue4086.CSharp;

public class DisposableBase : System.IDisposable
{
    public void Dispose()
    {
    }
}

public sealed class DerivedDisposable : DisposableBase
{
}

public class Base
{
}

public sealed class Derived : Base
{
}

public interface IInstanceOverloads
{
    string Take<T>(T value) where T : System.IDisposable;
    string Take(object value);
    string Choose<T>(T value, System.Func<T> factory);
    string ChooseParams<T>(T value, params System.Func<T>[] factories);

    // Reviewer finding on #4142: a constrained-instance dispatch
    // through a type-parameter receiver selecting an expanded
    // ` + "`" + `params Handler[]` + "`" + ` candidate for a custom
    // [InterpolatedStringHandler] element.
    string HandlerParams(int value, params MethodGroupOutputInference.MatrixHandler[] handlers);
}

public class InstanceOverloads : IInstanceOverloads
{
    public string Take<T>(T value)
        where T : System.IDisposable
        => "instance-generic";

    public string Take(object value)
        => "instance-object";

    public string Choose<T>(T value, System.Func<T> factory)
        => typeof(T).Name;

    public string ChooseParams<T>(T value, params System.Func<T>[] factories)
        => typeof(T).Name;

    public string HandlerParams(int value, params MethodGroupOutputInference.MatrixHandler[] handlers)
        => value + ":" + string.Join(",", handlers);
}

public sealed class DerivedInstanceOverloads : InstanceOverloads
{
}

public interface IStaticOverloads<TSelf>
    where TSelf : IStaticOverloads<TSelf>
{
    static abstract string Take<T>(T value)
        where T : System.IDisposable;

    static abstract string Take(object value);

    static abstract string Pick<T>(T first, T second);
    static abstract string Choose<T>(T value, System.Func<T> factory);
    static abstract string ChooseParams<T>(T value, params System.Func<T>[] factories);

    // Reviewer finding on #4142: the constrained-STATIC sibling of
    // IInstanceOverloads.HandlerParams above.
    static abstract string HandlerParams(int value, params MethodGroupOutputInference.MatrixHandler[] handlers);
}

public sealed class StaticOverloads : IStaticOverloads<StaticOverloads>
{
    public static string Take<T>(T value)
        where T : System.IDisposable
        => "static-generic";

    public static string Take(object value)
        => "static-object";

    public static string Pick<T>(T first, T second)
        => typeof(T).Name;

    public static string Choose<T>(T value, System.Func<T> factory)
        => typeof(T).Name;

    public static string ChooseParams<T>(T value, params System.Func<T>[] factories)
        => typeof(T).Name;

    public static string HandlerParams(int value, params MethodGroupOutputInference.MatrixHandler[] handlers)
        => value + ":" + string.Join(",", handlers);
}

public interface IAsyncStaticOverloads
{
    static abstract string Take<T>(T value)
        where T : System.IDisposable;

    static abstract string Take(object value);
}

public sealed class AsyncStaticOverloads : IAsyncStaticOverloads
{
    public static string Take<T>(T value)
        where T : System.IDisposable
        => "async-static-generic";

    public static string Take(object value)
        => "async-static-object";
}

public static class Overloads
{
    public static string Take<T>(T value)
        where T : System.IDisposable
        => "generic-disposable";

    public static string Take(object value)
        => "object";

    public static string Pick<T>(T first, T second)
        => "generic";

    public static string Pick(object first, object second)
        => "object";

    public static string PickNested<T>(
        T first,
        System.Collections.Generic.IEnumerable<T> second)
        => "generic-nested";

    public static string PickNested(
        object first,
        System.Collections.Generic.IEnumerable<object> second)
        => "object-nested";
}

public static class GenericOnly
{
    public static string Pick<T>(T first, T second)
        => typeof(T).Name;

    public static string PickParams<T>(params T[] values)
        => typeof(T).Name;

    public static string ChooseParams<T>(T value, params System.Func<T>[] factories)
        => typeof(T).Name;
}

public static class MethodGroupOutputInference
{
    [System.Runtime.CompilerServices.InterpolatedStringHandler]
    public struct MatrixHandler
    {
        private System.Text.StringBuilder builder;

        public MatrixHandler(int literalLength, int formattedCount)
        {
            builder = new System.Text.StringBuilder(literalLength);
        }

        public void AppendLiteral(string value)
            => builder.Append(value);

        public void AppendFormatted<T>(T value)
            => builder.Append(value);

        public override string ToString()
            => builder.ToString();
    }

    [System.Runtime.CompilerServices.InterpolatedStringHandler]
    public struct ForwardingMatrixHandler
    {
        private System.Text.StringBuilder builder;

        public ForwardingMatrixHandler(
            int literalLength,
            int formattedCount,
            string prefix)
        {
            builder = new System.Text.StringBuilder(literalLength + prefix.Length + 1);
            builder.Append(prefix);
            builder.Append(':');
        }

        public ForwardingMatrixHandler(
            int literalLength,
            int formattedCount,
            InstanceOverloads receiver,
            string prefix)
            : this(literalLength, formattedCount, prefix)
        {
        }

        public void AppendLiteral(string value)
            => builder.Append(value);

        public void AppendFormatted<T>(T value)
            => builder.Append(value);

        public override string ToString()
            => builder.ToString();
    }

    public static string Choose<TIn, TOut>(
        TIn value,
        System.Func<TIn, TOut> converter)
        => typeof(TIn).Name + ":" + typeof(TOut).Name;

    public static string ChooseParams<TIn, TOut>(
        TIn value,
        params System.Func<TIn, TOut>[] converters)
        => typeof(TIn).Name + ":" + typeof(TOut).Name;

    public static TOut Convert<TIn, TOut>(
        TIn value,
        System.Func<TIn, TOut> converter)
        => converter(value);

    public static TOut ConvertParams<TIn, TOut>(
        TIn value,
        params System.Func<TIn, TOut>[] converters)
        => converters[0](value);

    public static TOut EscapedConvert<TIn, TOut>(
        TIn value,
        System.Func<TIn, TOut> @func)
        => @func(value);

    public static TOut EscapedConvertParams<TIn, TOut>(
        TIn value,
        params System.Func<TIn, TOut>[] @func)
        => @func[0](value);

    public static string EvaluationOrder<T>(
        T value,
        params object[] items)
        => value + ":" + string.Join(",", items);

    // Used only by the blast-radius control: an ordinary method with
    // no params slot, so the expanded-argument reordering must never
    // touch it.
    public static string Plain(string a, int b, string c)
        => a + ":" + b + ":" + c;

    public static string FormattableOrder(
        int value,
        System.FormattableString item,
        params object[] rest)
        => item.Format + ":" + item.GetArgument(0) + ":" + value + ":" + rest[0];

    public static string HandlerParams(
        int value,
        params MatrixHandler[] handlers)
        => value + ":" + string.Join(",", handlers);

    public static string ForwardedHandlerOrder(
        int first,
        string prefix,
        [System.Runtime.CompilerServices.InterpolatedStringHandlerArgument("prefix")]
        ForwardingMatrixHandler handler,
        params object[] rest)
        => first + ":" + handler + ":" + string.Join(",", rest);

    public static string RefEvaluationOrder(
        ref int value,
        params object[] items)
    {
        value += 10;
        return value + ":" + string.Join(",", items);
    }
}

public static class ExtensionOverloads
{
    public static string ChooseExtensionParams<T>(
        this InstanceOverloads receiver,
        T value,
        params System.Func<T>[] factories)
        => typeof(T).Name;

    public static string ForwardedHandlerExtension(
        this InstanceOverloads receiver,
        int first,
        string prefix,
        [System.Runtime.CompilerServices.InterpolatedStringHandlerArgument("receiver", "prefix")]
        MethodGroupOutputInference.ForwardingMatrixHandler handler,
        params object[] rest)
        => first + ":" + handler + ":" + string.Join(",", rest);
}

public static class VarianceOverloads
{
    public static string DelegateType<T>(T value, System.Action<T> sink)
        => typeof(T).Name;

    public static string DelegateWinner<T>(T value, System.Action<T> sink)
        => "generic-delegate:" + typeof(T).Name;

    public static string DelegateWinner(
        object value,
        System.Delegate sink)
        => "object-delegate";

    public static string InterfaceType<T>(
        T value,
        System.Collections.Generic.IComparer<T> sink)
        => typeof(T).Name;

    public static string InterfaceWinner<T>(
        T value,
        System.Collections.Generic.IComparer<T> sink)
        => "generic-interface:" + typeof(T).Name;

    public static string InterfaceWinner(
        object value,
        object sink)
        => "object-interface";

    public static System.Action<object> ObjectAction()
        => _ => { };

    public static System.Collections.Generic.IComparer<object> ObjectComparer()
        => System.Collections.Generic.Comparer<object>.Default;

    public static System.Action<DisposableBase> BaseAction()
        => _ => { };

    public static System.Action<DerivedDisposable> DerivedAction()
        => _ => { };

    public static System.Action<Base> InferenceBaseAction()
        => _ => { };

    public static System.Action<Derived> InferenceDerivedAction()
        => _ => { };

    public static string UpperType<T>(
        System.Action<T> first,
        System.Action<T> second)
        => typeof(T).Name;

    public static string UpperParams<T>(params System.Action<T>[] sinks)
        => typeof(T).Name;

    public static string InvariantWinner<T>(
        System.Collections.Generic.List<T> first,
        System.Collections.Generic.List<T> second)
        => "generic-invariant";

    public static string InvariantWinner(
        System.Collections.Generic.List<object> first,
        object second)
        => "object-invariant";

    public static string InvariantParams<T>(
        params System.Collections.Generic.List<T>[] values)
        => "generic-invariant-params";

    public static string InvariantParams(
        System.Collections.Generic.List<object> first,
        params object[] rest)
        => "object-invariant-params";
}`)

        private const Issue4086GsDeclarations string = `package Issue4086.Probe
import System
import System.Collections.Generic
import System.Threading.Tasks
import Issue4086.CSharp

open class Base {
    public func Kind() string {
        return "same-compilation-Base"
    }
}

class Derived : Base {
}

func throughClassBound[T DisposableBase](value T) string {
    return Overloads.Take(value)
}

func throughInterface[T IDisposable](value T) string {
    return Overloads.Take(value)
}

func throughObject(value object) string {
    return Overloads.Take(value)
}

func throughMixedInference[T](first T, second object) string {
    return Overloads.Pick(first, second)
}

func throughGenericOnlyMixedInference[T](first T, second object) string {
    return GenericOnly.Pick(first, second)
}

func throughDefaultInference[T](value T) string {
    return GenericOnly.Pick(value, default)
}

func throughNestedMixedInference[T](
    first T,
    second IEnumerable[object]) string {
    return Overloads.PickNested(first, second)
}

func throughExpandedMixedInference[T](first T, second object) string {
    return GenericOnly.PickParams(first, second)
}

func throughDelegateUpperBoundType[T DisposableBase](value T) string {
    return VarianceOverloads.DelegateType(value, VarianceOverloads.ObjectAction())
}

func throughDelegateUpperBoundWinner[T DisposableBase](value T) string {
    return VarianceOverloads.DelegateWinner(value, VarianceOverloads.ObjectAction())
}

func throughInterfaceUpperBoundType[T DisposableBase](value T) string {
    return VarianceOverloads.InterfaceType(value, VarianceOverloads.ObjectComparer())
}

func throughInterfaceUpperBoundWinner[T DisposableBase](value T) string {
    return VarianceOverloads.InterfaceWinner(value, VarianceOverloads.ObjectComparer())
}

func throughInvariantConflict[T](value List[T]) string {
    return VarianceOverloads.InvariantWinner(List[object](), value)
}

func throughInvariantExpandedConflict[T](value List[T]) string {
    return VarianceOverloads.InvariantParams(List[object](), value)
}

func methodGroupFactory() DisposableBase {
    return DisposableBase()
}

func methodGroupFactory(value int32) DerivedDisposable {
    return DerivedDisposable()
}

func throughInstanceMethodGroup(receiver InstanceOverloads) string {
    return receiver.Choose(DerivedDisposable(), methodGroupFactory)
}

func throughExpandedInstanceMethodGroup(receiver InstanceOverloads) string {
    return receiver.ChooseParams(DerivedDisposable(), methodGroupFactory)
}

func expandedSymbolicFactory() Base {
    return Base()
}

func expandedSymbolicFactory(value int32) Derived {
    return Derived()
}

func outputInferenceConvert(value object) Issue4086.CSharp.Base {
    return Issue4086.CSharp.Base()
}

func outputInferenceConvert(value int32) Issue4086.CSharp.Derived {
    return Issue4086.CSharp.Derived()
}

func throughFixedMethodGroupOutputInference() string {
    return MethodGroupOutputInference.Choose(
        Issue4086.CSharp.Derived(),
        outputInferenceConvert)
}

func throughExpandedMethodGroupOutputInference() string {
    return MethodGroupOutputInference.ChooseParams(
        Issue4086.CSharp.Derived(),
        outputInferenceConvert)
}

func throughNamedFixedMethodGroupOutputInference() string {
    return MethodGroupOutputInference.Choose(
        converter: outputInferenceConvert,
        value: Issue4086.CSharp.Derived())
}

func throughNamedExpandedMethodGroupOutputInference() string {
    return MethodGroupOutputInference.ChooseParams(
        converters: outputInferenceConvert,
        value: Issue4086.CSharp.Derived())
}

func symbolicOutputConvert(value object) Base {
    return Base()
}

func symbolicOutputConvert(value int32) Derived {
    return Derived()
}

func throughNamedFixedMethodGroupOutputValue() string {
    var result Base = MethodGroupOutputInference.Convert(
        converter: symbolicOutputConvert,
        value: Derived())
    return result.Kind()
}

func throughNamedExpandedMethodGroupOutputValue() string {
    var result Base = MethodGroupOutputInference.ConvertParams(
        converters: symbolicOutputConvert,
        value: Derived())
    return result.Kind()
}

func throughNamedExpandedMultiMethodGroupOutputValue() string {
    var result Base = MethodGroupOutputInference.ConvertParams(
        value: Derived(),
        symbolicOutputConvert,
        symbolicOutputConvert)
    return result.Kind()
}

func throughEscapedNamedFixedMethodGroupOutputValue() string {
    var result Base = MethodGroupOutputInference.EscapedConvert(
        func_: symbolicOutputConvert,
        value: Derived())
    return result.Kind()
}

func throughEscapedNamedExpandedMethodGroupOutputValue() string {
    var result Base = MethodGroupOutputInference.EscapedConvertParams(
        func_: symbolicOutputConvert,
        value: Derived())
    return result.Kind()
}

func firstExpandedNamedArgument() string {
    Console.Write("first|")
    return "first"
}

func secondExpandedNamedArgument() int32 {
    Console.Write("second|")
    return 2
}

func interpolatedExpandedNamedArgument() int32 {
    Console.Write("format|")
    return 7
}

func refExpandedNamedArgument() int32 {
    Console.Write("ref|")
    return 0
}

func nonForwardedHandlerArgument() int32 {
    Console.Write("first|")
    return 1
}

func forwardedHandlerArgument() string {
    Console.Write("prefix|")
    return "p"
}

func handlerHoleArgument() int32 {
    Console.Write("handler|")
    return 3
}

func extensionHandlerReceiver() InstanceOverloads {
    Console.Write("receiver|")
    return InstanceOverloads()
}

func throughExpandedStaticMethodGroup() string {
    return GenericOnly.ChooseParams(Derived(), expandedSymbolicFactory)
}

func throughExpandedSymbolicInstanceMethodGroup(receiver InstanceOverloads) string {
    return receiver.ChooseParams(Derived(), expandedSymbolicFactory)
}

func throughExpandedInheritedMethodGroup(receiver DerivedInstanceOverloads) string {
    return receiver.ChooseParams(Derived(), expandedSymbolicFactory)
}

func throughExpandedExtensionMethodGroup(receiver InstanceOverloads) string {
    return receiver.ChooseExtensionParams(Derived(), expandedSymbolicFactory)
}

func throughConstrainedInstanceMethodGroup[TReceiver IInstanceOverloads](
    receiver TReceiver) string {
    return receiver.Choose(DerivedDisposable(), methodGroupFactory)
}

func throughExpandedConstrainedInstanceMethodGroup[TReceiver IInstanceOverloads](
    receiver TReceiver) string {
    return receiver.ChooseParams(Derived(), expandedSymbolicFactory)
}

func throughConstrainedInstance[TReceiver IInstanceOverloads, TValue DisposableBase](
    receiver TReceiver,
    value TValue) string {
    return receiver.Take(value)
}

func throughConstrainedInstanceObject[TReceiver IInstanceOverloads](
    receiver TReceiver,
    value object) string {
    return receiver.Take(value)
}`

        /// The static-abstract-interface declarations, kept apart from the
        /// shared prelude: every program that contains them needs the two
        /// established static-virtual-interface ILVerify suppressions, so only
        /// the fact that exercises them pays that cost and every other fact
        /// verifies with no suppression at all.
        private const Issue4086GsConstrainedStaticDeclarations string = `func throughConstrainedStatic[
    TReceiver IStaticOverloads[TReceiver],
    TValue DisposableBase](value TValue) string {
    return TReceiver.Take(value)
}

async func throughConstrainedStaticAsync[
    TReceiver IAsyncStaticOverloads,
    TValue DisposableBase](value TValue) string {
    return TReceiver.Take(await Task.FromResult[TValue](value))
}

func throughConstrainedStaticObject[TReceiver IStaticOverloads[TReceiver]](
    value object) string {
    return TReceiver.Take(value)
}

func throughConstrainedStaticMixedInference[
    TReceiver IStaticOverloads[TReceiver],
    TValue](first TValue, second object) string {
    return TReceiver.Pick(first, second)
}

func throughConstrainedStaticMethodGroup[
    TReceiver IStaticOverloads[TReceiver]]() string {
    return TReceiver.Choose(DerivedDisposable(), methodGroupFactory)
}

func throughExpandedConstrainedStaticMethodGroup[
    TReceiver IStaticOverloads[TReceiver]]() string {
    return TReceiver.ChooseParams(Derived(), expandedSymbolicFactory)
}

func throughNamedConstrainedStaticMethodGroup[
    TReceiver IStaticOverloads[TReceiver]]() string {
    return TReceiver.Choose(
        factory: methodGroupFactory,
        value: DerivedDisposable())
}

func throughNamedExpandedConstrainedStaticMethodGroup[
    TReceiver IStaticOverloads[TReceiver]]() string {
    return TReceiver.ChooseParams(
        factories: expandedSymbolicFactory,
        value: Derived())
}`

        private const Issue3076CsSource string = `namespace Issue3076.CSharp
{
    public static class Issue3076GenericStaticSlot<T>
    {
        public static int Property { get; set; }
        public static int Field;
        public static string? TextProperty { get; set; }
        public static string? TextField;

        public static int ReadProperty() => Property;
        public static int ReadField() => Field;
    }

    public static class Issue3076GenericPairSlot<TFirst, TSecond>
    {
        public static int Property { get; set; }
        public static int Field;
    }

    public sealed class Issue3076GenericBox<T>
    {
    }

    public static class Issue3076PlainStaticSlot
    {
        public static int Property { get; set; }
        public static int Field;
    }

    public static class Issue3076AsyncValues
    {
        public static System.Threading.Tasks.Task<int> Get(int value)
            => System.Threading.Tasks.Task.FromResult(value);
    }
}`

        internal func CompileAndRunWithSiblingCs(
            csSource string,
            gSource string,
            siblingName string,
            ignoredErrorScope string? = nil
        ) string {
            let workDir = CreateWorkDir("imported_member_matrix_")
            try {
                let siblingDll = BuildCsLibrary(workDir, csSource, siblingName)
                File.Copy(siblingDll, Path.Combine(workDir, Path.GetFileName(siblingDll)), overwrite: true)
                return CompileAndRun(gSource, []string{siblingDll}, workDir, ignoredErrorScope)
            } finally {
                TryDelete(workDir)
            }
        }

        private func Issue3076Source(fixtureNamespace string, throughTypeParameter bool) string {
            if !throughTypeParameter {
                return (`    import ` + "$fixtureNamespace" + `
    import System

    Issue3076GenericStaticSlot[int32].Property = 301
    Issue3076GenericStaticSlot[int32].Field = 302
    Issue3076GenericStaticSlot[string].Property = 311
    Issue3076GenericStaticSlot[string].Field = 312
    Issue3076GenericStaticSlot[object].Property = 321
    Issue3076GenericStaticSlot[object].Field = 322
    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property = 331
    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field = 332
    Issue3076GenericPairSlot[int32, string].Property = 341
    Issue3076GenericPairSlot[int32, string].Field = 342
    Issue3076PlainStaticSlot.Property = 351
    Issue3076PlainStaticSlot.Field = 352

    Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
    Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
    Console.WriteLine(Issue3076GenericStaticSlot[string].Property)
    Console.WriteLine(Issue3076GenericStaticSlot[string].Field)
    Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
    Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property)
    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field)
    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Property)
    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Field)
    Console.WriteLine(Issue3076PlainStaticSlot.Property)
    Console.WriteLine(Issue3076PlainStaticSlot.Field)`)
            }
            return (`    import ` + "$fixtureNamespace" + `
    import System

    func Store[T](propertyValue int32, fieldValue int32) {
        Issue3076GenericStaticSlot[T].Property = propertyValue
        Issue3076GenericStaticSlot[T].Field = fieldValue
    }

    func StorePropertyAndRead[T](value int32) int32 {
        Issue3076GenericStaticSlot[T].Property = value
        return Issue3076GenericStaticSlot[T].Property
    }

    func StoreFieldAndRead[T](value int32) int32 {
        Issue3076GenericStaticSlot[T].Field = value
        return Issue3076GenericStaticSlot[T].Field
    }

    func ReadProperty[T]() int32 {
        return Issue3076GenericStaticSlot[T].Property
    }

    func ReadField[T]() int32 {
        return Issue3076GenericStaticSlot[T].Field
    }

    func StoreNested[T](propertyValue int32, fieldValue int32) {
        Issue3076GenericStaticSlot[Issue3076GenericBox[T]].Property = propertyValue
        Issue3076GenericStaticSlot[Issue3076GenericBox[T]].Field = fieldValue
    }

    func StorePair[TFirst, TSecond](propertyValue int32, fieldValue int32) {
        Issue3076GenericPairSlot[TFirst, TSecond].Property = propertyValue
        Issue3076GenericPairSlot[TFirst, TSecond].Field = fieldValue
    }

    Issue3076GenericStaticSlot[int32].Property = 101
    Issue3076GenericStaticSlot[int32].Field = 102
    Issue3076GenericStaticSlot[string].Property = 111
    Issue3076GenericStaticSlot[string].Field = 112
    Issue3076GenericStaticSlot[object].Property = 121
    Issue3076GenericStaticSlot[object].Field = 122
    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property = 131
    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field = 132
    Issue3076GenericPairSlot[int32, string].Property = 141
    Issue3076GenericPairSlot[int32, string].Field = 142

    var intProperty = StorePropertyAndRead[int32](201)
    var intField = StoreFieldAndRead[int32](202)
    Store[string](211, 212)
    StoreNested[int32](221, 222)
    StorePair[int32, string](231, 232)
    Issue3076PlainStaticSlot.Property = 241
    Issue3076PlainStaticSlot.Field = 242

    Console.WriteLine(intProperty)
    Console.WriteLine(intField)
    Console.WriteLine(ReadProperty[string]())
    Console.WriteLine(ReadField[string]())
    Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
    Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].ReadProperty())
    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].ReadField())
    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Property)
    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Field)
    Console.WriteLine(Issue3076PlainStaticSlot.Property)
    Console.WriteLine(Issue3076PlainStaticSlot.Field)`)
        }

        internal func CompileExpectingErrorsWithSiblingCs(csSource string, gSource string, siblingName string) List[
            string
        ] {
            let workDir = CreateWorkDir("imported_member_matrix_err_")
            try {
                let siblingDll = BuildCsLibrary(workDir, csSource, siblingName)
                return CompileExpectingErrors(gSource, []string{siblingDll}, workDir)
            } finally {
                TryDelete(workDir)
            }
        }

        internal func CompileAndRun(source string) string {
            let workDir = CreateWorkDir("imported_member_matrix_source_")
            try {
                return CompileAndRun(source, Array.Empty[string](), workDir)
            } finally {
                TryDelete(workDir)
            }
        }

        private func CompileAndRun(
            source string,
            references IReadOnlyCollection[string],
            workDir string,
            ignoredErrorScope string? = nil
        ) string {
            let srcPath = Path.Combine(workDir, "test.gs")
            let outPath = Path.Combine(workDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = GscArgs(outPath, "exe", references, srcPath)
            let (exitCode, diagnostics) = RunCompiler(args)
            Assert.True(exitCode == 0, diagnostics)
            IlVerifier.Verify(
                outPath,
                additionalReferences: references,
                ignoredErrorCodes: if ignoredErrorScope == nil {
                    default([]?string)
                } else {
                    IlVerifier.KnownIssues.StaticVirtualInterface
                },
                ignoredErrorScope: ignoredErrorScope
            )
            let runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json")
            if !File.Exists(runtimeConfig) {
                File.WriteAllText(runtimeConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            }
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(runtimeConfig)
            psi.ArgumentList.Add(outPath)
            using let proc = Process.Start(psi) ?? throw InvalidOperationException("failed to start dotnet exec")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func CompileExpectingErrors(source string, references IReadOnlyCollection[string], workDir string) List[
            string
        ] {
            let srcPath = Path.Combine(workDir, "test.gs")
            let outPath = Path.Combine(workDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let (exitCode, diagnostics) = RunCompiler(GscArgs(outPath, "exe", references, srcPath))
            Assert.True(exitCode != 0, "expected gsc to report errors but it succeeded")
            return diagnostics.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries).ToList()
        }

        private func GetDiagnosticIds(diagnostics IEnumerable[string]) List[string] {
            let ids = List[string]()
            for diagnostic in diagnostics {
                let index = diagnostic.IndexOf("GS", StringComparison.Ordinal)
                if index >= 0 && diagnostic.Length >= index + 6 {
                    ids.Add(diagnostic.Substring(index, 6))
                }
            }
            return ids
        }

        private func GscArgs(
            outPath string,
            target string,
            references IReadOnlyCollection[string],
            srcPath string
        )[]string {
            let args = List[string]{
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in references.Concat(TrustedPlatformAssemblies()) {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            return args.ToArray()
        }

        private func RunCompiler(args[]string)(ExitCode int32, Diagnostics string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
        }

        private func BuildCsLibrary(workDir string, source string, assemblyName string) string {
            let csDir = Path.Combine(workDir, "csref")
            Directory.CreateDirectory(csDir)
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source)
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <NoWarn>1591;SA1649;SA1518;SA1516;SA1122;SA1201</NoWarn>
    <RunAnalyzers>false</RunAnalyzers>
    <AssemblyName>` + "$assemblyName" + `</AssemblyName>
    <RootNamespace>` + "$assemblyName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
            RunDotnet(csDir, "restore")
            let outDir = Path.Combine(csDir, "out")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore", "-o", outDir)
            let dll = Path.Combine(outDir, assemblyName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for arg in args {
                psi.ArgumentList.Add(arg)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
        }

        private func CreateWorkDir(prefix string) string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }

        private func TryDelete(path string) {
            try {
                if Directory.Exists(path) {
                    Directory.Delete(path, recursive: true)
                }
            } catch { }
        }
    }
}
