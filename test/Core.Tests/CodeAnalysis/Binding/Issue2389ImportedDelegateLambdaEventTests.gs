// <copyright file="Issue2389ImportedDelegateLambdaEventTests.cs" company="GSharp">
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

/// Issue #2389: an UNTYPED arrow lambda (`(count) -> ...`, no
/// parameter type clauses) used with `+=`/`-=` against a genuinely
/// IMPORTED (separately-compiled, real-assembly) CLR delegate/event failed
/// target-type inference with GS0304, even though the event's declared
/// delegate type fully determines the expected parameter/return shape. A
/// TYPED lambda or a source-defined delegate shape (ADR-0076 `event E
/// (args) -> ret`) never hit the gap.
///
/// `ExpressionBinder.BindEventSubscriptionHandler` is the single shared
/// helper behind every `+=`/`-=` subscription form (bare
/// implicit-`this` event, chained/instance receiver, interface event,
/// and the raw imported-CLR-event path), so fixing it there covers every one
/// of those contexts uniformly. The fix reuses the same
/// `MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol` conversion
/// already used by target-typed local declarations
/// (`StatementBinder.Narrowing.cs`) and call-argument inference
/// (`OverloadResolver.*`) to fill in the lambda's omitted parameter
/// types from the event's delegate signature before binding.
///
/// These binder-level tests use a REAL, separately Roslyn-compiled C# sibling
/// assembly exposing both instance and static events across a range of
/// custom-delegate shapes (0/1/3 parameters, non-void return) plus the
/// standard `EventHandler` shape, and assert on the resulting
/// (cref:GSharp.Core.CodeAnalysis.Diagnostic) set — including negative
/// signature/ambiguity controls proving the fix does not silently accept
/// mismatched shapes.
open class Issue2389ImportedDelegateLambdaEventTests {
    @Fact
    func InstanceEvent_CustomOneParamDelegate_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Ticked += (count) -> { }
}`))
    }

    @Fact
    func InstanceEvent_EventHandlerShape_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Changed += (sender, e) -> { }
}`))
    }

    @Fact
    func InstanceEvent_ZeroParamDelegate_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Pulsed += () -> { }
}`))
    }

    @Fact
    func InstanceEvent_ThreeParamDelegate_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Combined += (a, b, c) -> { }
}`))
    }

    @Fact
    func InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Transforming += (x) -> x * 2
}`))
    }

    @Fact
    func StaticEvent_CustomOneParamDelegate_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    Ticker.StaticTicked += (count) -> { }
}`))
    }

    @Fact
    func StaticEvent_EventHandlerShape_UntypedLambda_Binds() {
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    Ticker.StaticChanged += (sender, e) -> { }
}`))
    }

    @Fact
    func InstanceEvent_UntypedLambda_AddAndRemove_BothBind() {
        // Add/remove symmetry: BindEventSubscriptionHandler is the SAME
        // helper for both `+=` (isAdd: true) and `-=` (isAdd: false) — this
        // proves the fix applies to both operators, not just `+=`.
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Ticked += (count) -> { }
    t.Ticked -= (count) -> { }
}`))
    }

    @Fact
    func TypedLambda_StillBinds_RegressionControl() {
        // Baseline control: a fully-typed lambda against the same imported
        // custom delegate must keep working exactly as before the fix.
        Assert.Empty(Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Ticked += (count int32) -> { }
}`))
    }

    @Fact
    func SourceDefinedDelegateShape_UntypedLambda_StillBinds() {
        // Source-language coverage: an event declared with an ADR-0076
        // function-type shape (`event E (args) -> ret`) hits the exact same
        // `BindEventSubscriptionHandler` fallback as an imported CLR
        // delegate — `targetDelegateType` here is already a
        // `FunctionTypeSymbol`, which `TryGetLambdaTargetFunctionTypeFromSymbol`
        // returns as-is. This proves the fix is not special-cased to CLR
        // reflection lookups; it uniformly threads the target type through
        // for every delegate-shaped event regardless of where the shape
        // originates.
        Assert.Empty(Bind(`package App
class Clock {
    event Ticked (int32) -> void
}
func Main() {
    let c = Clock()
    c.Ticked += (count) -> { }
}`))
    }

    @Fact
    func ArityMismatch_UntypedLambda_ReportsDiagnostic() {
        // Negative signature control: a 2-parameter untyped lambda against a
        // 1-parameter delegate must still be rejected — target-typing fills
        // in parameter TYPES from the delegate's slots, it must not paper
        // over a genuine arity mismatch. Since the lambda's arity does not
        // match the target delegate, the target-typing fix does not apply
        // per-parameter types (the same as it would for a source-defined
        // delegate mismatch), so the parameters fall back to natural
        // inference (GS0304) and the overall handler still fails the final
        // delegate-conversion check (GS0155). What matters here is that the
        // mismatch is still definitively rejected rather than silently
        // accepted.
        let diagnostics = Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Ticked += (a, b) -> { }
}`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func ReturnTypeMismatch_UntypedLambda_ReportsDiagnostic() {
        // Negative signature control: the delegate's non-void return type
        // (int32) is still enforced — a body producing an incompatible type
        // (string) must be rejected, not silently widened/accepted.
        let diagnostics = Bind(`package App
import Lib2389B

func Main() {
    let t = Ticker()
    t.Transforming += (x) -> "not an int"
}`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func AmbiguousMethodGroupHandler_ReportsDiagnostic_UnaffectedByFix() {
        // Negative ambiguity control: two overloads that are each only
        // implicitly (never exactly) convertible to the target delegate's
        // `int64` parameter must still be rejected as ambiguous — this path
        // never touches the untyped-lambda fix (it's a method-group
        // conversion, not a LambdaExpressionSyntax), so it's a sibling-audit
        // regression guard proving the fix didn't disturb method-group
        // handler resolution.
        let diagnostics = Bind(`package App
import Lib2389B

func Handle(x int32) { }
func Handle(x int16) { }

func Main() {
    let t = Ticker()
    t.Widened += Handle
}`)
        Assert.NotEmpty(diagnostics)
    }

    shared {
        private let LibraryPath string = EmitCSharpLibrary()

        private func Bind(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(resolver, tree)
            // The imported library is loaded reflection-only via a
            // MetadataLoadContext (see ReferenceResolver.WithReferences), so its
            // types cannot actually be instantiated/invoked — these tests bind
            // (and lower) the program to surface every diagnostic, including
            // ones raised while binding function BODIES (BoundProgram.Diagnostics
            // — GlobalScope.Diagnostics alone only covers declaration-level
            // binding), without going through Compilation.Evaluate, which would
            // try to actually execute the reflection-only Ticker calls.
            let parseDiagnostics = tree.Diagnostics
            return parseDiagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }

        private func EmitCSharpLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2389Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib2389B.dll")
            const csharpSource = `using System;

namespace Lib2389B
{
    public delegate void TickHandler(int count);
    public delegate int Transformer(int x);
    public delegate void Combiner(int a, int b, int c);
    public delegate void Pulse();
    public delegate void Wide(long v);

    public class Ticker
    {
        public event TickHandler Ticked;
        public event EventHandler Changed;
        public event Transformer Transforming;
        public event Combiner Combined;
        public event Pulse Pulsed;
        public event Wide Widened;
        public static event TickHandler StaticTicked;
        public static event EventHandler StaticChanged;
    }
}`
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
                "Lib2389B",
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
