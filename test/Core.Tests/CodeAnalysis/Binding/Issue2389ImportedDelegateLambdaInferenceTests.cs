// <copyright file="Issue2389ImportedDelegateLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2389: an untyped arrow-lambda handler (<c>Event += (s, e) -&gt;
/// ...</c>) used against an IMPORTED CLR delegate/event failed target-type
/// inference (GS0304 "cannot infer the type of lambda parameter") because
/// <see cref="ExpressionBinder"/>'s shared <c>BindEventSubscriptionHandler</c>
/// helper (for <c>+=</c>/<c>-=</c>) and <c>BindAssignmentRhs</c> helper (for
/// simple <c>=</c> re-assignment) bound the lambda syntax with
/// <c>BindExpression(handlerSyntax)</c> — no target type at all — before
/// falling back to a post-bind conversion that only reshapes an
/// ALREADY-typed literal. A typed lambda (<c>(s object, e EventArgs) -&gt;
/// ...</c>) or a declaration initializer (<c>var f EventHandler = (s, e)
/// -&gt; ...</c>, which threads the target type through a different path)
/// masked the gap. Both helpers now resolve the omitted parameter (and,
/// where the body doesn't already pin one down, return) types from the
/// target delegate/function-type shape via the shared
/// <see cref="MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol"/>
/// resolver (issue #889) — covering native G# function types, user-declared
/// named delegates, and imported CLR delegates/events uniformly. See
/// <c>Issue2389ImportedDelegateLambdaEmitTests</c> for the compile/run/
/// ILVerify coverage against a sibling CLR assembly.
/// </summary>
public class Issue2389ImportedDelegateLambdaInferenceTests
{
    [Fact]
    public void InstanceImportedClrEvent_UntypedLambda_AddAssign_Binds()
    {
        const string source = """
            package p
            import System

            var domain = AppDomain.CurrentDomain
            domain.ProcessExit += (sender, e) -> {
                var x = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InstanceImportedClrEvent_UntypedLambda_AddThenRemove_Binds()
    {
        // Add/remove symmetry: both operators must resolve the same
        // target-typed inference against the event's declared delegate.
        const string source = """
            package p
            import System

            var domain = AppDomain.CurrentDomain
            domain.ProcessExit += (sender, e) -> {
                var x = sender
            }
            domain.ProcessExit -= (sender, e) -> {
                var y = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StaticImportedClrEvent_UntypedLambda_TwoParamCustomDelegate_Binds()
    {
        // Console.CancelKeyPress is a STATIC imported CLR event whose
        // delegate (ConsoleCancelEventHandler) is a custom (non-EventHandler)
        // named delegate — covers the "custom delegate" + "static" cells of
        // the matrix at the binder level.
        const string source = """
            package p
            import System

            Console.CancelKeyPress += (sender, e) -> {
                var x = sender
            }
            Console.CancelKeyPress -= (sender, e) -> {
                var y = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InstanceImportedClrEvent_ZeroParamLambda_Binds()
    {
        // Zero-parameter cell of the matrix: System.Threading.ThreadStart is
        // a zero-arg imported CLR delegate; exercised here as a plain
        // (non-event) re-assignment target since the BCL has no zero-arg
        // *event* in common use — the shared resolver does not care whether
        // the target is an event or a plain variable/field slot.
        const string source = """
            package p
            import System.Threading

            var t ThreadStart
            t = () -> {
                var x = 1
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SourceDefinedFunctionTypeEvent_UntypedLambda_Binds()
    {
        // The same helper drives source-defined (non-CLR) function-type
        // events too — this guards the SHARED root, not just the
        // imported-CLR repro.
        const string source = """
            package p

            class Inner {
                event Changed (int32, string) -> void
            }

            var i = Inner()
            i.Changed += (a, b) -> {
                var x = a
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UserDeclaredNamedClrEventType_UntypedLambda_Binds()
    {
        // A user-declared event whose TYPE is an imported CLR named delegate
        // (System.EventHandler) rather than a native G# function type or the
        // event living on an imported class — the middle ground between
        // "imported CLR event" and "source-defined delegate shape".
        const string source = """
            package p
            import System

            class Inner {
                public event Changed EventHandler
            }

            var i = Inner()
            i.Changed += (sender, e) -> {
                var x = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InterfaceTypedReceiver_ImportedNamedDelegateEvent_UntypedLambda_Binds()
    {
        const string source = """
            package p
            import System

            interface IHub {
                event Msg EventHandler
            }

            class Hub : IHub {
                public event Msg EventHandler
            }

            func Use(h IHub) {
                h.Msg += (sender, e) -> {
                    var x = sender
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PlainReassignment_ImportedClrDelegateTypedVariable_UntypedLambda_Binds()
    {
        // Simple `=` re-assignment (not an event `+=`/`-=`) of a
        // previously-declared imported-CLR-delegate-typed variable. This is
        // the second call site routed through the same shared helper
        // (`BindAssignmentRhs`) — the declaration initializer already
        // threaded the target type through a different path, which is
        // exactly why the gap on RE-assignment was masked.
        const string source = """
            package p
            import System

            var f EventHandler
            f = (sender, e) -> {
                var x = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InstanceFieldReassignment_ImportedClrDelegateTypedField_UntypedLambda_Binds()
    {
        const string source = """
            package p
            import System

            class Holder {
                var Handler EventHandler
            }

            var h = Holder()
            h.Handler = (sender, e) -> {
                var x = sender
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InferredParameterAndReturnType_GenericImportedClrDelegate_UntypedLambda_Binds()
    {
        // System.Predicate<T> is a generic imported CLR delegate with a
        // single inferred parameter type AND a non-void inferred return
        // type (bool) — covers "inferred parameter and return types where
        // applicable" for a plain (non-event) assignment target.
        const string source = """
            package p
            import System

            var p Predicate[int32]
            p = (x) -> {
                return x > 0
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultiParamInferredReturnType_ImportedClrDelegate_UntypedLambda_Binds()
    {
        // System.Comparison<T> is a two-parameter imported CLR delegate with
        // a non-void (int32) inferred return type.
        const string source = """
            package p
            import System

            var c Comparison[int32]
            c = (a, b) -> {
                return a - b
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TypedLambdaAndMethodGroupHandlers_StillBindAlongsideUntypedFix()
    {
        // Regression guard: the pre-existing typed-lambda and method-group
        // handler shapes (the ones that already "worked" per the issue
        // description) must keep binding cleanly once the untyped path is
        // fixed.
        const string source = """
            package p
            import System

            func OnExit(sender object, e EventArgs) { }

            var domain = AppDomain.CurrentDomain
            domain.ProcessExit += (sender object, e EventArgs) -> {
                var x = sender
            }
            domain.ProcessExit += OnExit
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ArityMismatch_ImportedClrEvent_UntypedLambda_ReportsGS0304NotCrash()
    {
        // Negative/invalid-signature control: an untyped lambda whose arity
        // does not match the target delegate's must still fail cleanly with
        // the existing "cannot infer" diagnostic (and the standard
        // conversion-failure diagnostic), not crash or silently mis-bind.
        const string source = """
            package p
            import System

            var domain = AppDomain.CurrentDomain
            domain.ProcessExit += (onlyOneParam) -> {
                var x = onlyOneParam
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0304");
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void ArityMismatch_PlainReassignment_UntypedLambda_ReportsGS0304NotCrash()
    {
        const string source = """
            package p
            import System

            var f EventHandler
            f = (onlyOneParam) -> {
                var x = onlyOneParam
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0304");
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void AmbiguousZeroArityLambda_AgainstTwoParamEvent_ReportsGS0304NotCrash()
    {
        // A zero-parameter lambda against a two-parameter delegate is an
        // equally invalid (not merely "ambiguous") shape; confirm it still
        // reports cleanly rather than binding an incorrect arity.
        const string source = """
            package p
            import System

            Console.CancelKeyPress += () -> {
                var x = 1
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
