// <copyright file="Issue2423InterfaceMethodContractTaintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2423: <c>ObliviousNullabilityAnalyzer
/// .CollectInterfaceImplementationEdges</c> (added for issue #2285) only
/// synchronized taint between an interface PROPERTY and the property that
/// implements it — it had no case at all for methods. <c>SeedMethodLikeReturnTaint</c>,
/// unlike its property counterpart (which gates transitivity via
/// <c>ImplementsBaseOrInterfaceMember</c>), applies unconditional transitive
/// return-taint promotion to every method, so a concrete method that
/// implements an interface member and forwards a tainted call (e.g. an
/// `async Task&lt;T&gt;` method delegating to a sibling overload that can
/// return null — the exact Oahu.Core <c>AudibleApi.GetLibraryAsync</c> shape)
/// is correctly promoted to <c>T?</c>, but the interface declaration it
/// implements — which has no body to seed taint from, and C# interfaces
/// cannot declare `async` members — never is. This produced an internally
/// inconsistent translation that gsc's Kotlin-style interface-conformance
/// check rejects (GS0187: "does not implement interface method").
/// <para>
/// <b>Fix, part 1 (taint-graph sync)</b>: <c>CollectInterfaceImplementationEdges</c>
/// is split into a per-member-kind dispatcher; the existing property handling
/// is extracted unchanged into <c>CollectInterfacePropertyEdges</c>, and a new
/// <c>CollectInterfaceMethodEdges</c> adds the same bidirectional taint edges
/// between an ordinary, non-void interface method and
/// <c>type.FindImplementationForInterfaceMember</c>'s result, keyed off the
/// UNWRAPPED `async Task&lt;T&gt;`/`ValueTask&lt;T&gt;` result
/// (<c>UnwrapAwaitedType</c>) so the interface method's `Task&lt;T&gt;`-typed
/// `ReturnType` is judged on the same effective type as an async
/// implementation's awaited result.
/// </para>
/// <para>
/// <b>Fix, part 2 (return-shape parity)</b>: syncing the taint symbols alone
/// was insufficient. <c>CSharpToGSharpTranslator.MapReturnType</c>'s
/// synchronous path mapped a `Task&lt;T&gt;`-returning, NON-async declaration
/// (every interface method — interfaces can't be `async` — and any plain
/// synchronous method that happens to return a `Task&lt;T&gt;` literally) by
/// promoting the WHOLE mapped `Task[T]` envelope to nullable when tainted
/// (`Task[T]?`), whereas an `async` implementation's sugar instead nullifies
/// only the AWAITED result (`Task[T?]`, via `PromoteAwaitedReturnIfTainted`).
/// These are different G# types (G# has real, structural nullable types, not
/// C#-style annotations) — a nullable Task REFERENCE vs. a Task of a nullable
/// result — so even after both endpoints were correctly marked tainted, gsc
/// still rejected the mismatched shapes with the SAME GS0187 diagnostic
/// (confirmed against the real Oahu.Core corpus: the taint-only fix, part 1
/// alone, left the identical GS0187 fingerprint; combined with part 2 the
/// fingerprint disappears and the failure count drops 42 -&gt; 41 with zero
/// new fingerprints). The new <c>PromoteTaskEnvelopeReturnIfTainted</c> helper
/// closes this by promoting only the inner type ARGUMENT of the (preserved)
/// `Task[T]`/`ValueTask[T]` envelope, reusing `PromoteAwaitedReturnIfTainted`'s
/// exact eligibility/taint decision so both declaration styles converge on the
/// identical shape.
/// </para>
/// <para>
/// <b>Scope</b>: eligibility is guarded to reference-typed, non-annotated
/// awaited results (mirroring the #2421 async fix), so a value-typed
/// `Task&lt;int&gt;` is never promoted. Base/override contracts are
/// deliberately NOT synced (consistent with the pre-existing property
/// behavior, which only handles interfaces). Tuple-returning interface
/// methods are also NOT synced by this fix: tuple-return promotion
/// (`PromoteTupleReturnIfTainted`) is an entirely separate, per-declaration
/// SYNTACTIC mechanism that inspects a method's OWN `return` expressions — an
/// interface method has no body/no `return` expressions to inspect, so it can
/// never itself be promoted regardless of what an implementation's body
/// contains; bridging that is a materially different mechanism and out of
/// scope for this precise, symbol-taint-only fix.
/// </para>
/// </summary>
public class Issue2423InterfaceMethodContractTaintTests
{
    [Fact]
    public void ImplicitImplementation_AsyncForwardingOverload_PromotesInterfaceAndImplementationInLockstep()
    {
        // The exact Oahu.Core AudibleApi.GetLibraryAsync shape: an implicit
        // interface implementation forwards to a sibling overload whose body
        // genuinely returns null.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("func GetLibraryAsync(resync bool) Task[LibraryResponse?];", printed);
        Assert.Contains("async func GetLibraryAsync(resync bool) LibraryResponse?", printed);
    }

    [Fact]
    public void ExplicitImplementation_TaintedBody_PromotesInterfaceAndExplicitMember()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("func Get() string?;", printed);
        Assert.Contains("Get() string? -> nil", printed);
    }

    [Fact]
    public void MultipleImplementations_OneTainted_PromotesInterfaceAndAllImplementations()
    {
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
        string printed = TranslateOblivious(@"
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
        public string Get() => ""x"";
    }
}");

        Assert.Contains("func Get() string?;", printed);
        Assert.Contains("class Tainted : IFoo {\n    func Get() string? -> nil\n}", printed);
        Assert.Contains("class Clean : IFoo {\n    func Get() string? -> \"x\"\n}", printed);
    }

    [Fact]
    public void GenericInterface_UnconstrainedTypeParameter_LeavesInterfaceDeclarationUnpromoted()
    {
        // Negative/documentation control: the interface's own declared return
        // is the (unconstrained) type parameter T itself, which is not
        // `IsReferenceType` (it could be substituted by a value type at any
        // instantiation site), so the eligibility guard correctly declines to
        // promote the GENERIC declaration. The concrete instantiation's own
        // implementation is still promoted independently, from its own
        // tainted body (unrelated to this fix - the pre-existing, unconditional
        // method-return taint seeding).
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("func Get() T;", printed);
        Assert.Contains("func Get() string? -> nil", printed);
    }

    [Fact]
    public void OverrideOfAbstractBase_IsNotSyncedByThisFix()
    {
        // Negative/documentation control: base-class virtual/abstract
        // contracts are NOT interfaces, so CollectInterfaceMethodEdges (like
        // its pre-existing property counterpart) does not create any edge for
        // them - only the override's own tainted body is promoted.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("open func Get() string;", printed);
        Assert.Contains("override func Get() string? -> nil", printed);
    }

    [Fact]
    public void TupleReturningInterfaceMethod_IsNotSyncedByThisFix()
    {
        // Negative/documentation control: tuple-return promotion is a
        // separate, per-declaration SYNTACTIC mechanism
        // (PromoteTupleReturnIfTainted) keyed off a method's OWN `return`
        // expressions; an interface method has no body to inspect, so its
        // tuple return can never be promoted by that mechanism regardless of
        // what an implementation's body does. This fix's taint-graph sync
        // does not bridge that gap (out of scope - see class remarks).
        string printed = TranslateOblivious(@"
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
            return (a, ""x"");
        }
    }
}");

        Assert.Contains("func Get() (string, string);", printed);
        Assert.Contains("func Get() (string?, string)", printed);
    }

    [Fact]
    public void GenuinelyNonNullImplementation_InterfaceAndImplementationStayNonNull()
    {
        // Control: with no taint source anywhere, neither endpoint is
        // promoted - the fix must not spuriously widen untainted contracts.
        string printed = TranslateOblivious(@"
using System.Threading.Tasks;

namespace Demo
{
    public interface IFoo
    {
        Task<string> Get();
    }

    public class C : IFoo
    {
        public async Task<string> Get() => ""x"";
    }
}");

        Assert.Contains("func Get() Task[string];", printed);
        Assert.Contains("async func Get() string ->", printed);
        Assert.DoesNotContain("Task[string?]", printed);
        Assert.DoesNotContain("Task[string]?", printed);
    }

    [Fact]
    public void ValueTypedAsyncTaskReturn_IsNeverPromoted()
    {
        // Negative control: a value-typed awaited result (Task<int>) must
        // never be promoted through this reference-only mechanism, on either
        // the interface or the implementation side, matching the existing
        // #2421 async guard.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("func Get() Task[int32];", printed);
        Assert.Contains("async func Get() int32 -> 1", printed);
    }

    [Fact]
    public void NullableEnabledCompilation_IsUnaffected()
    {
        // The oblivious taint analysis is gated to nullable-DISABLED
        // compilations (issue #2113); a nullable-enabled compilation must be
        // byte-identical to its own (correct, compiler-checked) annotations,
        // matching the precedent set by Issue2285's equivalent control.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
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
}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("func Get() Task[string];", printed);
        Assert.Contains("async func Get() string ->", printed);
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
