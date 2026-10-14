// <copyright file="Issue2423InterfaceMethodContractTaintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Regression tests for issue #2423: `ObliviousNullabilityAnalyzer
/// .CollectInterfaceImplementationEdges` (added for issue #2285) only
/// synchronized taint between an interface PROPERTY and the property that
/// implements it — it had no case at all for methods. `SeedMethodLikeReturnTaint`,
/// unlike its property counterpart (which gates transitivity via
/// `ImplementsBaseOrInterfaceMember`), applies unconditional transitive
/// return-taint promotion to every method, so a concrete method that
/// implements an interface member and forwards a tainted call (e.g. an
/// `async Task<T>` method delegating to a sibling overload that can
/// return null — the exact Oahu.Core `AudibleApi.GetLibraryAsync` shape)
/// is correctly promoted to `T?`, but the interface declaration it
/// implements — which has no body to seed taint from, and C# interfaces
/// cannot declare `async` members — never is. This produced an internally
/// inconsistent translation that gsc's Kotlin-style interface-conformance
/// check rejects (GS0187: "does not implement interface method").
///
/// <b>Fix, part 1 (taint-graph sync)</b>: `CollectInterfaceImplementationEdges`
/// is split into a per-member-kind dispatcher; the existing property handling
/// is extracted unchanged into `CollectInterfacePropertyEdges`, and a new
/// `CollectInterfaceMethodEdges` adds the same bidirectional taint edges
/// between an ordinary, non-void interface method and
/// `type.FindImplementationForInterfaceMember`'s result, keyed off the
/// UNWRAPPED `async Task<T>`/`ValueTask<T>` result
/// (`UnwrapAwaitedType`) so the interface method's `Task<T>`-typed
/// `ReturnType` is judged on the same effective type as an async
/// implementation's awaited result.
///
/// <b>Fix, part 2 (return-shape parity)</b>: syncing the taint symbols alone
/// was insufficient. `CSharpToGSharpTranslator.MapReturnType`'s
/// synchronous path mapped a `Task<T>`-returning, NON-async declaration
/// (every interface method — interfaces can't be `async` — and any plain
/// synchronous method that happens to return a `Task<T>` literally) by
/// promoting the WHOLE mapped `Task[T]` envelope to nullable when tainted
/// (`Task[T]?`), whereas an `async` implementation's sugar instead nullifies
/// only the AWAITED result (`Task[T?]`, via `PromoteAwaitedReturnIfTainted`).
/// These are different G# types (G# has real, structural nullable types, not
/// C#-style annotations) — a nullable Task REFERENCE vs. a Task of a nullable
/// result — so even after both endpoints were correctly marked tainted, gsc
/// still rejected the mismatched shapes with the SAME GS0187 diagnostic
/// (confirmed against the real Oahu.Core corpus: the taint-only fix, part 1
/// alone, left the identical GS0187 fingerprint; combined with part 2 the
/// fingerprint disappears and the failure count drops 42 -> 41 with zero
/// new fingerprints). The new `PromoteTaskEnvelopeReturnIfTainted` helper
/// closes this by promoting only the inner type ARGUMENT of the (preserved)
/// `Task[T]`/`ValueTask[T]` envelope, reusing `PromoteAwaitedReturnIfTainted`'s
/// exact eligibility/taint decision so both declaration styles converge on the
/// identical shape.
///
/// <b>Scope</b>: eligibility is guarded to reference-typed, non-annotated
/// awaited results (mirroring the #2421 async fix), so a value-typed
/// `Task<int>` is never promoted. Base/override contracts are
/// deliberately NOT synced (consistent with the pre-existing property
/// behavior, which only handles interfaces). Issue #2469 subsequently added
/// an independent element-path graph for tuple returns; its contract handling
/// is covered by the tuple-specific test below.
open class Issue2423InterfaceMethodContractTaintTests {
    @Fact
    func ImplicitImplementation_AsyncForwardingOverload_PromotesInterfaceAndImplementationInLockstep() {
        // The exact Oahu.Core AudibleApi.GetLibraryAsync shape: an implicit
        // interface implementation forwards to a sibling overload whose body
        // genuinely returns null.
        let printed = TranslateOblivious(`
using System.Threading.Tasks;

namespace Demo
{
    public class LibraryResponse
    {
    }

    public interface IAudibleApi
    {
        Task<LibraryResponse> GetLibraryAsync(bool resync);
    }

    public class AudibleApi : IAudibleApi
    {
        public async Task<LibraryResponse> GetLibraryAsync(bool resync) => await GetLibraryAsync(null, resync);

        internal async Task<LibraryResponse> GetLibraryAsync(string json, bool resync)
        {
            return null;
        }
    }
}`)
        Assert.Contains("func GetLibraryAsync(resync bool) Task[LibraryResponse?];", printed)
        Assert.Contains("async func GetLibraryAsync(resync bool) LibraryResponse?", printed)
    }

    @Fact
    func ExplicitImplementation_TaintedBody_PromotesInterfaceAndExplicitMember() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IFoo
    {
        string Get();
    }

    public class C : IFoo
    {
        string IFoo.Get() => null;
    }
}`)
        Assert.Contains("func Get() string?;", printed)
        Assert.Contains("Get() string? -> nil", printed)
    }

    @Fact
    func DefaultInterfaceExpressionBody_UsesBlockBody() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IFoo
    {
        bool Handle(int value) => false;
    }
}`)
        Assert.Contains(
            "func Handle(value int32) bool {${Environment.NewLine}        return false${Environment.NewLine}    }",
            printed
        )
        Assert.DoesNotContain("func Handle(value int32) bool -> false", printed)
    }

    @Fact
    func MultipleImplementations_OneTainted_PromotesInterfaceAndAllImplementations() {
        // The shared interface symbol is a single taint node: once ANY
        // implementer proves the contract can return null, a caller holding
        // only the interface-typed reference must see that possibility
        // regardless of which concrete implementation it actually got at
        // runtime — so the fixpoint correctly promotes every implementation
        // of the same interface method, not just the one whose own body is
        // tainted. This mirrors the pre-existing property behavior
        // (Issue2285's NullCheckThroughInterfaceTypedReference_* test) and is
        // intentional, not an unbounded/blanket promotion: it is still scoped
        // to the members that share this exact interface-method contract.
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IFoo
    {
        string Get();
    }

    public class Tainted : IFoo
    {
        public string Get() => null;
    }

    public class Clean : IFoo
    {
        public string Get() => "x";
    }
}`)
        Assert.Contains("func Get() string?;", printed)
        Assert.Contains(
            "class Tainted : IFoo {${Environment.NewLine}    func Get() string? -> nil${Environment.NewLine}}",
            printed
        )
        Assert.Contains(
            "class Clean : IFoo {${Environment.NewLine}    func Get() string? -> \"x\"${Environment.NewLine}}",
            printed
        )
    }

    @Fact
    func GenericInterface_UnconstrainedTypeParameter_LeavesInterfaceDeclarationUnpromoted() {
        // Negative/documentation control: the interface's own declared return
        // is the (unconstrained) type parameter T itself, which is not
        // `IsReferenceType` (it could be substituted by a value type at any
        // instantiation site), so the eligibility guard correctly declines to
        // promote the GENERIC declaration. The concrete instantiation's own
        // implementation is still promoted independently, from its own
        // tainted body (unrelated to this fix - the pre-existing, unconditional
        // method-return taint seeding).
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IRepo<T>
    {
        T Get();
    }

    public class Repo : IRepo<string>
    {
        public string Get() => null;
    }
}`)
        Assert.Contains("func Get() T;", printed)
        Assert.Contains("func Get() string? -> nil", printed)
    }

    @Fact
    func OverrideOfAbstractBase_ReturnContractConverges() {
        // Issue #2504 generalizes callable return contracts to base methods too:
        // a method group bound through the base contract must expose the same
        // promoted return shape as its nullable override.
        let printed = TranslateOblivious(`
namespace Demo
{
    public abstract class Base
    {
        public abstract string Get();
    }

    public class Derived : Base
    {
        public override string Get() => null;
    }
}`)
        Assert.Contains("open func Get() string?;", printed)
        Assert.Contains("override func Get() string? -> nil", printed)
    }

    @Fact
    func TupleReturningInterfaceMethod_IsSyncedByTupleElementAnalysis() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public interface IFoo
    {
        (string, string) Get();
    }

    public class C : IFoo
    {
        public (string, string) Get()
        {
            string a = null;
            return (a, "x");
        }
    }
}`)
        Assert.Contains("func Get() (string?, string);", printed)
        Assert.Contains("func Get() (string?, string)", printed)
    }

    @Fact
    func GenuinelyNonNullImplementation_InterfaceAndImplementationStayNonNull() {
        // Control: with no taint source anywhere, neither endpoint is
        // promoted - the fix must not spuriously widen untainted contracts.
        let printed = TranslateOblivious(`
using System.Threading.Tasks;

namespace Demo
{
    public interface IFoo
    {
        Task<string> Get();
    }

    public class C : IFoo
    {
        public async Task<string> Get() => "x";
    }
}`)
        Assert.Contains("func Get() Task[string];", printed)
        Assert.Contains("async func Get() string ->", printed)
        Assert.DoesNotContain("Task[string?]", printed)
        Assert.DoesNotContain("Task[string]?", printed)
    }

    @Fact
    func ValueTypedAsyncTaskReturn_IsNeverPromoted() {
        // Negative control: a value-typed awaited result (Task<int>) must
        // never be promoted through this reference-only mechanism, on either
        // the interface or the implementation side, matching the existing
        // #2421 async guard.
        let printed = TranslateOblivious(`
using System.Threading.Tasks;

namespace Demo
{
    public interface IFoo
    {
        Task<int> Get();
    }

    public class C : IFoo
    {
        public async Task<int> Get() => 1;
    }
}`)
        Assert.Contains("func Get() Task[int32];", printed)
        Assert.Contains("async func Get() int32 -> 1", printed)
    }

    @Fact
    func NullableEnabledCompilation_IsUnaffected() {
        // The oblivious taint analysis is gated to nullable-DISABLED
        // compilations (issue #2113); a nullable-enabled compilation must be
        // byte-identical to its own (correct, compiler-checked) annotations,
        // matching the precedent set by Issue2285's equivalent control.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public interface IFoo
    {
        Task<string> Get();
    }

    public class C : IFoo
    {
        public async Task<string> Get() => null!;
    }
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = PrintAndValidate(
            CSharpToGSharpTranslator().TranslateDocument(document, context),
            "Nullable-enabled control preserves a null-forgiven nil return that G# rejects at a non-null sink."
        )
        Assert.Contains("func Get() Task[string];", printed)
        Assert.Contains("async func Get() string ->", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit, roundTripOnlyReason string? = nil) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
