// <copyright file="Adr0227BodyLocalDeltaTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Threading
import Xunit

/// ADR-0227 D4 (issue #6128): the body-local check of the diagnostic-delta gate gives the delta of the
/// full check. Each test computes both and compares Removed, Added, Persisting and AddedSyntax as sorted
/// multisets of document, ID, severity, span and message, and the flags.
open class Adr0227BodyLocalDeltaTests {
    // The programs of the ADR-0227 fix tests.
    private let FixCorpus[]string = []string{
        "package P\n\nfunc F() string? {\n    // a\n    return /* b */ null // c\n}\n",
        "package P\n\nfunc F() string? {\n    // a\n    return /* b */ nil // c\n}\n",
        "package P\n\nfunc F() string? -> null\n",
        "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0 -> \"zero\" // z\n        default: \"other\"\n    }\n}\n",
        "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0: \"zero\" // z\n        default: \"other\"\n    }\n}\n",
        "package P\n\nimport System.Text\n\nfunc F() string {\n    let sb = new StringBuilder() // keep\n    return sb.ToString()\n}\n",
        "package P\n\nimport System.Text\n\nfunc F() string {\n    let sb = StringBuilder() // keep\n    return sb.ToString()\n}\n",
        "package P\n\nclass C { }\n\nfunc F() C {\n    return new C()\n}\n",
        "package P\n\nclass C { }\n\nfunc F() C {\n    return C()\n}\n",
        "package P\n\nfunc F(chars []char) string {\n    return new string(chars)\n}\n",
        "package P\n\nfunc F(chars []char) string {\n    return string(chars)\n}\n",
        "package P\n\nstruct S { var X int32 }\n\nfunc F() S {\n    return new S(1)\n}\n",
        "package P\n\nclass C { }\n\nfunc Make() C -> C()\n\nfunc F() C {\n    return new Make()\n}\n",
        "package P\n\nfunc F() int32 {\n    let /* k */ x = 1\n    x = 2\n    return x\n}\n",
        "package P\n\nfunc F() int32 {\n    var /* k */ x = 1\n    x = 2\n    return x\n}\n",
        "package P\n\nfunc F() int32 {\n    let x = 1\n    x += 2\n    return x\n}\n",
        "package P\n\nfunc F() int32 {\n    var x = 1\n    x += 2\n    return x\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a or b // x\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a || b // x\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a and b\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a && b\n}\n",
        "package P\n\nfunc F(a bool) bool {\n    if not a {\n        return false\n    }\n    return true\n}\n",
        "package P\n\nfunc F(a bool) bool {\n    if !a {\n        return false\n    }\n    return true\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    if not (a and b) {\n        return false\n    }\n    return true\n}\n",
        "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32 {\n    return c.N\n}\n",
        "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32 {\n    return c?.N\n}\n",
        "package P\n\nfunc Use(s string) int32 -> s.Length\n\nfunc F(t string?) int32 {\n    return Use(t)\n}\n",
        "package P\n\nclass C {\n    let N int32 = 0\n}\n\nfunc F() {\n    let c = C()\n    c.N = 1\n}\n",
        "package P\n\nclass C {\n    let c int32 = 0\n}\n\nfunc F() {\n    let c = C()\n    c.c = 1\n}\n",
        "package P\n\nfunc F(y int32?) int32 {\n    var x int32? = nil\n    return x = y\n}\n",
        "package P\n\nfunc F(a bool) bool {\n    return not !a\n}\n",
        "package P\n\nclass C { }\n\nfunc F(make () -> C) C {\n    return new make()\n}\n",
        "package P\n\nclass C { }\n\ntype D = C\n\nfunc F() C {\n    return new D()\n}\n",
        "package P\n\nfunc F(x uint8?) uint8 -> x\n",
        "package P\n\nfunc F() bool {\n    return or\n}\n",
        "package P\n\nfunc G(x bool) bool -> x\n\nfunc F() bool {\n    return G(or)\n}\n",
        "package P\n\nfunc F(a bool) bool {\n    return a and\n}\n",
        "package P\n\nfunc F(a int32?, b int32?) int32 {\n    return a + b\n}\n",
        "package P\n\nfunc F(n int64) int32 {\n    let m int32 = n // keep\n    return m\n}\n",
        "package P\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32](n)) // keep\n    return m\n}\n",
        "package P\n\nclass C {\n    let N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n",
        "package P\n\nclass C {\n    var N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n",
        "package P\n\nfunc F(y int64) int32 {\n    var x int32 = 100\n    x /= y\n    return x\n}\n",
        "package P\n\nfunc F(n int32) {\n    let values = [](int32, uint8){(1, n)}\n}\n",
        "package P\n\nfunc F(y int64) int32 {\n    var x int64 = 0\n    return x = y\n}\n",
        "package P\n\nfunc F(y int64) int32 {\n    var x int32 = 100\n    x &^= y\n    return x\n}\n",
        "package P\n\nconst Big int64 = 300\n\nfunc F() int8 {\n    let a int8 = Big\n    return a\n}\n",
        "package P\n\nfunc F(n nint) int32 {\n    let m int32 = n\n    return m\n}\n",
        "package P\n\nfunc F(n nint) int32 {\n    let m int32 = checked(cast[int32](n))\n    return m\n}\n",
        "package P\n\nfunc int32(n int64) int32 -> 0\n\nfunc F(n int64) int32 {\n    let m int32 = n\n    return m\n}\n",
        "package P\n\nfunc int32(n int64) int32 -> 0\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32](n))\n    return m\n}\n",
        "package P\n\nfunc F(n int64) int32 {\n    let m int32 = (n)\n    return m\n}\n",
        "package P\n\nfunc F(n int64) int32 {\n    let m int32 = checked(cast[int32]((n)))\n    return m\n}\n",
        "package P\n\ninline struct S {\n    shared {\n        let Count int32 = 0\n\n        func Set() {\n            Count = 2\n        }\n    }\n}\n",
        "package P\n\ninline struct S {\n    shared {\n        var Count int32 = 0\n\n        func Set() {\n            Count = 2\n        }\n    }\n}\n",
        "package P\n\ninline struct S {\n    let N int32 = 1\n\n    func Set() {\n        N = 2\n    }\n}\n",
        "package P\n\npartial class C {\n    func Set() {\n        N = 2\n    }\n}\n",
        "package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return missing\n}\n",
        "package P\n\nfunc F() string? {\n    // keep\n    return missing\n}\n",
        "package P\n\nfunc F() string? {\n    // keep\n    return nil\n}\n",
        "package P\n\nstruct S { var field int32 }\n\nfunc F(p *S) int32 -> p->field\n",
        "package P\n\nfunc F() string? {\n    // a\n    return null\n}\n\nfunc G() string? -> null\n",
        "package P\n\nfunc F() string? {\n    // a\n    return nil\n}\n\nfunc G() string? -> nil\n",
        "package P\n\nfunc Use(a string?, b string?) int32 -> 0\n\nfunc F() int32 -> Use(null,null)\n",
        "package P\n\nfunc A() string? -> null\n",
        "package P\n\nfunc B() string? -> null\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    let x = new System.Text.StringBuilder()\n    return a or b\n}\n",
        "package P\n\nfunc B() int32 -> 1\n",
        "package P\n\nfunc F() string? -> null\n\nfunc G() int32 -> missing\n",
        "package P\n\nfunc F() string? -> null\n\nlet g string? = null\n",
        "package P\n\nfunc F() int32 -> 1\n",
        "package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return x\n}\n\nfunc G() int32 -> missing\n",
        "package P\n\nfunc F() string? {\n    return null\n}\n\nfunc G() int32 {\n    return missing\n}\n",
        "package P\n\nfunc F() int32 {\n    return 1 +\n}\n",
        "package P\n\nfunc Helper() int32 -> 1\n",
        "package P\n\nfunc User() int32 -> Helper()\n",
        "package P\n\nfunc F(n int32) string {\n    return switch n {\n        case 0 -> \"zero\"\n        default: \"other\"\n    }\n}\n",
        "package P\n\n@SuppressDiagnostic(\"GS0302\")\nfunc F(n int32) string {\n    return switch n {\n        case 0: \"zero\"\n        default: \"other\"\n    }\n}\n\nfunc G() string? -> null\n",
        "package P\n\nfunc F(n int32) string {\n    return 1 +\n}\n",
        "package P\n\nfunc F() string? {\n    let foo = 1\n    return null\n}\n",
        "package P\n\nclass C { }\n\nfunc F() C {\n    return new C() // keep\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a or b\n}\n",
        "package P\n\nfunc F(a bool, b bool) bool {\n    return a or\n        b\n}\n",
        "package P\n\nclass C {\n    var N int32\n}\n\nfunc F(c C?) int32? {\n    return c.N\n}\n",
        "package P\n\nclass C {\n    var M int32\n}\n\nfunc F(c C) int32 {\n    return c.N\n}\n",
        "package P\n\nfunc F() int32 -> missing\n",
        "package P\n\nfunc F() int32 {\n    return missing\n}\n",
        "package P\n\nimport System\n\nclass C { }\n\nfunc F(make Func[C]) C {\n    return new make()\n}\n",
        "package P\n\nclass C { }\n\nfunc F(c C) int32 {\n    let N = 1\n    return c.N\n}\n",
        "package P\n\nclass C { }\n\nfunc F(make () -> C?) C? {\n    return new make()\n}\n",
        "package P\n\nclass C { }\n\nfunc F(c C) int32 {\n    let B = 1\n    return c.B.N\n}\n"
    }

    // The fix corpus inside methods of a class and across files.
    private let WrappedCorpus[][]string = [][]string{
        []string{
            "package P\n\nclass C {\n    var N int32 = 0\n\n    func F() string? {\n        return null\n    }\n\n    func G(a bool, b bool) bool {\n        return a or b\n    }\n\n    shared {\n        func H() int32 {\n            let x = 1\n            x = 2\n            return x\n        }\n    }\n}\n"
        },
        []string{
            "package P\n\nclass C {\n    func F(n int64) int32 {\n        let m int32 = n\n        return m\n    }\n\n    func Use() int32 -> F(1)\n}\n",
            "package P\n\nfunc Caller(c C) int32 {\n    return c.F(2) + missing\n}\n"
        },
        []string{
            "package P\n\nfunc Helper(a bool) bool {\n    if not a {\n        return false\n    }\n    return true\n}\n",
            "package P\n\n/// Doc.\nfunc User() bool -> Helper(true)\n\n/// Floating.\n\nfunc Other() int32 {\n    return 1\n}\n"
        },
        []string{
            "package P\n\nimport System.Text\n\nclass B {\n    func Build() string {\n        let sb = new StringBuilder()\n        return sb.ToString()\n    }\n}\n\nfunc Later() int32 {\n    return missing\n}\n",
            "package P\n\nfunc Uses(b B) string -> b.Build()\n"
        }
    }

    @Fact
    func FixCorpus_BodyLocalDeltaEqualsTheFullDelta() {
        var checks = 0
        var local = 0
        for source in FixCorpus {
            let (c, l) = CompareFixes(ImmutableArray.Create(source))
            checks += c
            local += l
        }
        for sources in WrappedCorpus {
            let (c, l) = CompareFixes(sources.ToImmutableArray())
            checks += c
            local += l
        }
        Assert.True(checks > 50, "checks: ${checks}")
        Assert.True(local > 20, "body-local checks: ${local} of ${checks}")
    }

    @Fact
    func BodyEdits_OverTheFixCorpus_BodyLocalDeltaEqualsTheFullDelta() {
        var local = 0
        for source in FixCorpus {
            local += CompareBodyEdits(ImmutableArray.Create(source), maxBodies: 8)
        }
        for sources in WrappedCorpus {
            local += CompareBodyEdits(sources.ToImmutableArray(), maxBodies: 8)
        }
        Assert.True(local > 100, "body-local checks: ${local}")
    }

    @Fact
    func BodyEdits_OverTheSamples_BodyLocalDeltaEqualsTheFullDelta() {
        var local = 0
        for file in SampleFiles() {
            local += CompareBodyEdits(ImmutableArray.Create(File.ReadAllText(file)), maxBodies: 3)
        }
        Assert.True(local > 50, "body-local checks: ${local}")
    }

    @Fact
    func EditThatChangesTheCallEffectOfAMethod_FallsBack() {
        // Use narrows N across a call of Touch. A write of N in Touch makes the narrowing unsafe in Use.
        const source = "package P\n\nclass C {\n    var N string? = nil\n\n    func Touch() {\n        let x = 1\n    }\n\n    func Use() int32 {\n        if N != nil {\n            Touch()\n            return N.Length\n        }\n        return 0\n    }\n}\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "        let x = 1\n", "        N = nil\n")
        Assert.False(local.BodyLocal)
        Assert.Equal("the edit changes the call-effect summary of the member", local.BodyLocalFallbackReason)
        AssertSameDelta(full, local, "call effect")
    }

    @Fact
    func EditThatCallsASuspendingFunction_FallsBack() {
        const source = "package P\n\nsuspend func S() int32 -> 1\n\nfunc F() int32 {\n    return 1\n}\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "    return 1\n", "    return S()\n")
        Assert.False(local.BodyLocal)
        Assert.Equal("a body names a suspending function", local.BodyLocalFallbackReason)
        AssertSameDelta(full, local, "suspending call")
    }

    @Fact
    func EditInAProgramWithASuspendingFunction_ThatTheBodyDoesNotName_IsBodyLocal() {
        const source = "package P\n\nsuspend func S() int32 -> 1\n\nfunc F() int32 {\n    return 1\n}\n\nfunc G() int32 -> missing\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "    return 1\n", "    let a = 2\n    return a\n")
        Assert.True(local.BodyLocal, local.BodyLocalFallbackReason)
        AssertSameDelta(full, local, "suspending program")
    }

    @Fact
    func EditThatTakesAReferenceToAMember_FallsBack() {
        // The narrowing of N in Use reads every body of C for a reference to N.
        const source = "package P\n\nimport System.Threading\n\nclass C {\n    var N int32 = 0\n    var S string? = nil\n\n    func Touch() {\n        N = 1\n    }\n\n    func Use() int32 {\n        if S != nil {\n            Touch()\n            return S.Length + N\n        }\n        return N\n    }\n}\n"
        let (full, local) = Both(
            ImmutableArray.Create(source),
            0,
            "        N = 1\n",
            "        Interlocked.Increment(ref N)\n"
        )
        Assert.False(local.BodyLocal)
        let reason = local.BodyLocalFallbackReason ?? ""
        Assert.True(
            reason == "the edit changes a reference to the member 'N'" ||
                reason == "the edit changes the call-effect summary of the member",
            reason
        )
        AssertSameDelta(full, local, "member reference")
    }

    @Fact
    func EditOfASignature_FallsBack() {
        const source = "package P\n\nfunc F(a int32) int32 {\n    return a\n}\n\nfunc G() int32 -> F(1)\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "F(a int32)", "F(a int64)")
        Assert.False(local.BodyLocal)
        Assert.Equal("the edit is not confined to one function body", local.BodyLocalFallbackReason)
        AssertSameDelta(full, local, "signature")
    }

    @Fact
    func EditThatAddsAnIterator_FallsBack() {
        const source = "package P\n\nimport System.Collections.Generic\n\nfunc F() IEnumerable[int32] {\n    return List[int32]()\n}\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "    return List[int32]()\n", "    yield 1\n")
        Assert.False(local.BodyLocal)
        AssertSameDelta(full, local, "iterator")
    }

    @Fact
    func EditWithAnAnonymousObject_FallsBack() {
        const source = "package P\n\nfunc F() int32 {\n    return 1\n}\n"
        let (full, local) = Both(
            ImmutableArray.Create(source),
            0,
            "    return 1\n",
            "    let o = new { A = 1 }\n    return o.A\n"
        )
        Assert.False(local.BodyLocal)
        AssertSameDelta(full, local, "anonymous object")
    }

    @Fact
    func EditWithADeferredLinqCall_FallsBack() {
        const source = "package P\n\nimport System.Linq\n\nfunc F(xs []int32) int32 {\n    return xs.Length\n}\n"
        let (full, local) = Both(
            ImmutableArray.Create(source),
            0,
            "    return xs.Length\n",
            "    return xs.Select((x int32) -> x).Count()\n"
        )
        Assert.False(local.BodyLocal)
        AssertSameDelta(full, local, "deferred LINQ")
    }

    @Fact
    func EditThatRemovesTheLastError_AddsTheDocumentationDiagnostics_BodyLocally() {
        // The floating doc comment is reported only when no error is left.
        const source = "package P\n\n/// Floating.\n\nfunc F() int32 {\n    return missing\n}\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "missing", "1")
        Assert.True(local.BodyLocal, local.BodyLocalFallbackReason)
        Assert.Contains(local.Added, (d Diagnostic) -> d.Id == "GS0227")
        AssertSameDelta(full, local, "documentation")
    }

    @Fact
    func EditThatAddsTheFirstError_RemovesTheDocumentationDiagnostics_BodyLocally() {
        const source = "package P\n\n/// Floating.\n\nfunc F() int32 {\n    return 1\n}\n"
        let (full, local) = Both(ImmutableArray.Create(source), 0, "return 1", "return missing")
        Assert.True(local.BodyLocal, local.BodyLocalFallbackReason)
        Assert.Contains(local.Removed, (d Diagnostic) -> d.Id == "GS0227")
        AssertSameDelta(full, local, "documentation")
    }

    @Fact
    func EditAfterOtherMembers_MovesTheirDiagnostics_AndKeepsSuppressions() {
        const source = "package P\n\nfunc F() int32 {\n    return 1\n}\n\nfunc G() int32 {\n    return missing\n}\n\n@SuppressDiagnostic(\"GS0302\")\nfunc H(n int32) string {\n    return switch n {\n        case 0 -> \"zero\"\n        default: \"other\"\n    }\n}\n"
        let (full, local) = Both(
            ImmutableArray.Create(source),
            0,
            "    return 1\n",
            "    let a = 1\n    let b = 2\n    return a + b\n"
        )
        Assert.True(local.BodyLocal, local.BodyLocalFallbackReason)
        Assert.NotEmpty(local.Persisting)
        AssertSameDelta(full, local, "shift")
    }

    @Fact
    func EditThatRemovesTheNonNilReturnProof_FallsBack() {
        // A caller's narrowing reads the callee's body for a proof that it returns a non-nil value.
        let (full, local) = Both(
            ImmutableArray.Create(
                "package P\n\nfunc F[T class?](v T) T {\n    return 1\n}\n",
                "package P\n\nfunc Caller[T class?](v T) object {\n    let x = F[T](v)\n    return x\n}\n"
            ),
            0,
            "return 1",
            "return v"
        )
        Assert.Contains(full.Added, (d Diagnostic) -> d.Location.FileName == "f1.gs")
        Assert.False(local.BodyLocal)
        AssertSameDelta(full, local, "non-nil return proof")
    }

    @Fact
    func EditThatWritesTheNameOfACallableField_FallsBack() {
        // The call-effect summary of `Touch` reads the initializer of the callable field `Clear` while no
        // tree writes the name `Clear`, so `Run` keeps the narrowing of `a` across the call.
        const source = "package P\n\nclass C {\n    var Value int32 = 1\n}\n\nclass H {\n    var Clear () -> void = func() { }\n\n    func Touch() {\n        Clear()\n    }\n}\n\nfunc Run(ref a C?, h H) int32 {\n    if a == nil {\n        return 0\n    }\n    h.Touch()\n    return a.Value\n}\n\nfunc Other() int32 {\n    var x = 1\n    x = 2\n    return x\n}\n"
        let (full, local) = Both(
            ImmutableArray.Create(source),
            0,
            "    var x = 1\n    x = 2\n    return x\n",
            "    var Clear = 1\n    Clear = 2\n    return Clear\n"
        )
        Assert.Contains(full.Added, (d Diagnostic) -> d.Id == "GS0158")
        Assert.False(local.BodyLocal)
        AssertSameDelta(full, local, "callable field write")
    }

    @Fact
    func EditBeforeASuppressedMissingDocumentation_KeepsItSuppressed_BodyLocally() {
        const source = "package Lib\n\n/// Documented.\nfunc F() int32 {\n    return 1\n}\n\n@SuppressDiagnostic(\"GS0228\")\nfunc Quiet() {}\n\nfunc Loud() {}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree){IsLibrary = true, WarnOnMissingDocumentation = true}
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0228")
        let (full, local) = BothOn(compilation, tree, "    return 1\n", "    let a = 1\n    return a\n")
        Assert.True(local.BodyLocal, local.BodyLocalFallbackReason)
        Assert.Empty(local.Added)
        AssertSameDelta(full, local, "documentation suppression")
    }

    @Fact
    func SnapshotOfACompilationWithoutReferences_UsesItsResolver_AndAnEditThatChangesNothingHasAnEmptyDelta() {
        // A default resolver depends on what the process has loaded when it is made. The snapshot of the
        // gate binds against the resolver of the compilation before the edit, so it compares like with like.
        const source = "package P\n\nimport System.Text\n\nlet n int32 = missing\n\nfunc F() string {\n    return StringBuilder().ToString()\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        Assert.Null(compilation.References)
        Assert.NotEmpty(compilation.GetDiagnostics())
        let snapshot = compilation.WithReplacedSyntaxTree(tree, SyntaxTree.Parse(SourceText.From(source, "a.gs")))
        Assert.Same(compilation.GlobalScope.References, snapshot.References)
        // The same text outside any body: the full check.
        for options in[]DeltaOptions{DeltaOptions{BodyLocalBind: false}, DeltaOptions()} {
            let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
                DeltaBaseline.Create(compilation, options),
                Changes(tree, "missing", "missing"),
                ImmutableArray[Diagnostic].Empty
            )
            Assert.False(delta.ParseOnly)
            Assert.Empty(delta.Removed)
            Assert.Empty(delta.Added)
        }
    }

    @Fact
    func Analyzers_FallBack() {
        const source = "package P\n\nfunc F() int32 {\n    return 1\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree)
        let options = DeltaOptions{Analyzers: ImmutableArray.Create[GSharpDiagnosticAnalyzer](NoAnalyzer())}
        let changes = Changes(tree, "return 1", "return 2")
        let delta = CodeFixService(CodeFixRegistry()).ComputeDelta(
            DeltaBaseline.Create(compilation, options),
            changes,
            ImmutableArray[Diagnostic].Empty
        )
        Assert.False(delta.BodyLocal)
        Assert.Null(delta.BodyLocalFallbackReason)
    }

    @Fact
    func BodyLocalChecks_LeaveTheHostAndItsSuccessorsAsAFreshCompilationWouldBe() {
        const source = "package P\n\nclass C {\n    var N string? = nil\n\n    func Touch() {\n        let x = 1\n    }\n\n    func Use() int32 {\n        if N != nil {\n            Touch()\n            return N.Length\n        }\n        return missing\n    }\n}\n\nfunc F(a bool, b bool) bool {\n    return a or b\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let compilation = Compilation(tree){IncrementalBodyReuse = true}
        let before = Keys(compilation.GetDiagnostics())
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let baseline = DeltaBaseline.Create(compilation)
        var local = 0
        let edits = [][]string{
            []string{"        let x = 1\n", "        let y = 2\n        Touch()\n"},
            []string{"return a or b", "return a || b"},
            []string{"return missing", "return N!!.Length"},
            []string{"        let x = 1\n", "        let s = \"x\"\n        let t = s.Length\n"}
        }
        for edit in edits {
            let delta = service.ComputeDelta(
                baseline,
                Changes(tree, edit[0], edit[1]),
                ImmutableArray[Diagnostic].Empty
            )
            if delta.BodyLocal {
                local++
            }
        }
        Assert.True(local >= 3, "body-local checks: ${local}")
        Assert.Equal(before, Keys(compilation.GetDiagnostics()))
        Assert.Equal(before, Keys(Compilation(tree).GetDiagnostics()))
        let edited = SyntaxTree.Parse(SourceText.From(source.Replace("return a or b", "return a || b"), "a.gs"))
        let successor = compilation.ReplaceSyntaxTree(tree, edited)
        Assert.Equal(Keys(Compilation(edited).GetDiagnostics()), Keys(successor.GetDiagnostics()))
    }

    private class NoAnalyzer : GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray[
            DiagnosticDescriptor
        ].Empty

        override func Initialize(context AnalysisContext) { }
    }

    // Computes the delta of every fix of every diagnostic both ways.
    private func CompareFixes(sources ImmutableArray[string])(int32, int32) {
        let trees = Parse(sources)
        let compilation = Compilation(trees.ToArray())
        let service = CodeFixService(CodeFixRegistry.CreateDefault())
        let full = DeltaBaseline.Create(compilation, DeltaOptions{BodyLocalBind: false})
        let local = DeltaBaseline.Create(compilation, DeltaOptions{StopOnNewSyntaxError: true})
        var checks = 0
        var bodyLocal = 0
        for diagnostic in compilation.GetDiagnostics() {
            for fix in service.GetFixes(compilation, diagnostic) {
                let fullDelta = service.ComputeDelta(full, fix)
                let localDelta = service.ComputeDelta(local, fix)
                AssertSameDelta(fullDelta, localDelta, "${fix.EquivalenceKey} in ${sources[0]}")
                checks++
                if localDelta.BodyLocal {
                    bodyLocal++
                }
            }
        }
        return (checks, bodyLocal)
    }

    // Edits the first bodies of the program four ways and computes each delta both ways.
    private func CompareBodyEdits(sources ImmutableArray[string], maxBodies int32) int32 {
        let trees = Parse(sources)
        // A body cache, as in the language server, so the integrity check below covers a successor.
        let compilation = Compilation(trees.ToArray()){IncrementalBodyReuse = true}
        let service = CodeFixService(CodeFixRegistry())
        let full = DeltaBaseline.Create(compilation, DeltaOptions{BodyLocalBind: false, StopOnNewSyntaxError: false})
        let local = DeltaBaseline.Create(compilation, DeltaOptions{StopOnNewSyntaxError: false})
        var bodyLocal = 0
        for tree in trees {
            var bodies = 0
            for node in tree.Root.DescendantNodes() {
                if bodies >= maxBodies {
                    break
                }
                if node is not FunctionDeclarationSyntax declaration || declaration.Body == nil {
                    continue
                }
                let body = declaration.Body
                if body.OpenBraceToken.Span.Length == 0 || body.CloseBraceToken.Span.Length == 0 {
                    continue
                }
                bodies++
                let start = body.OpenBraceToken.Span.End
                let edits = List[TextChange]()
                edits.Add(TextChange(TextSpan(start, 0), "\n    let probe__ = 1\n"))
                edits.Add(TextChange(TextSpan(start, 0), "\n    undefinedName__\n"))
                let identifier = body.DescendantTokens().FirstOrDefault(
                    (t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken && !t.IsMissing && t.Span.Length > 0
                )
                if identifier != nil {
                    edits.Add(TextChange(identifier.Span, "undefinedName__"))
                }
                if body.Statements.Length > 0 {
                    edits.Add(TextChange(body.Statements[0].Span, ""))
                }
                for edit in edits {
                    let changes = FixChanges(
                        ImmutableArray.Create(
                            DocumentChanges(tree, ImmutableArray.Create(edit), ImmutableArray[TextSpan].Empty)
                        )
                    )
                    let fullDelta = service.ComputeDelta(full, changes, ImmutableArray[Diagnostic].Empty)
                    let localDelta = service.ComputeDelta(local, changes, ImmutableArray[Diagnostic].Empty)
                    AssertSameDelta(
                        fullDelta,
                        localDelta,
                        "edit '${edit.NewText}' at ${edit.Span.Start} of ${tree.Text.FileName}: ${tree.Text.ToString().Substring(0, Math.Min(200, tree.Text.Length))}"
                    )
                    if localDelta.BodyLocal {
                        bodyLocal++
                    }
                }
            }
        }
        // The body-local checks leave the compilation and its successors as a fresh compilation would be.
        Assert.Equal(Keys(Compilation(trees.ToArray()).GetDiagnostics()), Keys(compilation.GetDiagnostics()))
        let first = trees[0]
        let edited = SyntaxTree.Parse(SourceText.From(first.Text.ToString() + "\n", first.Text.FileName))
        let successor = compilation.ReplaceSyntaxTree(first, edited)
        let freshTrees = List[SyntaxTree](trees)
        freshTrees[0] = edited
        Assert.Equal(Keys(Compilation(freshTrees.ToArray()).GetDiagnostics()), Keys(successor.GetDiagnostics()))
        return bodyLocal
    }

    private func Both(sources ImmutableArray[string], treeIndex int32, oldText string, newText string)(
        DiagnosticDelta,
        DiagnosticDelta
    ) {
        let trees = Parse(sources)
        return BothOn(Compilation(trees.ToArray()), trees[treeIndex], oldText, newText)
    }

    private func BothOn(compilation Compilation, tree SyntaxTree, oldText string, newText string)(
        DiagnosticDelta,
        DiagnosticDelta
    ) {
        let service = CodeFixService(CodeFixRegistry())
        let changes = Changes(tree, oldText, newText)
        let full = service.ComputeDelta(
            DeltaBaseline.Create(compilation, DeltaOptions{BodyLocalBind: false, StopOnNewSyntaxError: false}),
            changes,
            ImmutableArray[Diagnostic].Empty
        )
        let local = service.ComputeDelta(
            DeltaBaseline.Create(compilation, DeltaOptions{StopOnNewSyntaxError: false}),
            changes,
            ImmutableArray[Diagnostic].Empty
        )
        return (full, local)
    }

    private func Changes(tree SyntaxTree, oldText string, newText string) FixChanges {
        let text = tree.Text.ToString()
        let index = text.IndexOf(oldText, StringComparison.Ordinal)
        Assert.True(index >= 0, oldText)
        return FixChanges(
            ImmutableArray.Create(
                DocumentChanges(
                    tree,
                    ImmutableArray.Create(TextChange(TextSpan(index, oldText.Length), newText)),
                    ImmutableArray[TextSpan].Empty
                )
            )
        )
    }

    private func Parse(sources ImmutableArray[string]) List[SyntaxTree] {
        let trees = List[SyntaxTree]()
        for var i = 0; i < sources.Length; i++ {
            trees.Add(SyntaxTree.Parse(SourceText.From(sources[i], "f${i}.gs")))
        }
        return trees
    }

    private func AssertSameDelta(full DiagnosticDelta, local DiagnosticDelta, what string) {
        Assert.False(full.BodyLocal)
        let context = "${what} (body-local: ${local.BodyLocal}, fallback: ${local.BodyLocalFallbackReason})"
        Assert.True(
            Keys(full.Removed) == Keys(local.Removed),
            "Removed differs for ${context}:\n${Keys(full.Removed)}\n---\n${Keys(local.Removed)}"
        )
        Assert.True(
            Keys(full.Added) == Keys(local.Added),
            "Added differs for ${context}:\n${Keys(full.Added)}\n---\n${Keys(local.Added)}"
        )
        Assert.True(
            Keys(full.Persisting) == Keys(local.Persisting),
            "Persisting differs for ${context}:\n${Keys(full.Persisting)}\n---\n${Keys(local.Persisting)}"
        )
        Assert.True(Keys(full.AddedSyntax) == Keys(local.AddedSyntax), "AddedSyntax differs for ${context}")
        Assert.True(full.TargetRemoved == local.TargetRemoved, "TargetRemoved differs for ${context}")
        Assert.True(full.TargetsAreSyntax == local.TargetsAreSyntax, "TargetsAreSyntax differs for ${context}")
        Assert.True(full.ParseOnly == local.ParseOnly, "ParseOnly differs for ${context}")
    }

    // The document is the file name, so the keys of the old and the new text of one file compare.
    private func Keys(diagnostics IEnumerable[Diagnostic]) string -> string.Join(
        "\n",
        diagnostics.Select(
            (
                d Diagnostic
            ) -> "${d.Location.Text?.FileName}|${d.Id}|${d.Severity}|${d.Location.Span.Start}|${d.Location.Span.Length}|${d.Message}|${d.AdditionalLocations.Length}|${string.Join(",", d.AdditionalLocations.Select((l TextLocation) -> "${l.Text?.FileName}:${l.Span.Start}:${l.Span.Length}"))}|${d.Suggestions.Length}"
        )
            .OrderBy((k string) -> k, StringComparer.Ordinal)
    )

    private func SampleFiles() List[string] {
        var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
            directory = directory.Parent
        }
        Assert.NotNull(directory)
        return Directory
            .GetFiles(Path.Combine(directory!!.FullName, "samples"), "*.gs")
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .ToList()
    }
}
