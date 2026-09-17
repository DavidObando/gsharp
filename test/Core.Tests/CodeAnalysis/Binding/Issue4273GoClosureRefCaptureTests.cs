// <copyright file="Issue4273GoClosureRefCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Copilot review of PR #4273 (issue #4271): a <c>go</c> statement's operand
/// is wrapped into a display-class closure by
/// <c>Emit.ClosureEmitter.SynthesizeGoClosures</c> entirely at EMIT time —
/// bypassing <see cref="LambdaBinder"/>'s capture-legality checks completely,
/// a third closure-synthesis path (alongside the two <c>LambdaBinder</c> call
/// sites <see cref="Issue4259RefParameterCaptureEscapeTests"/> and
/// <see cref="Issue4271RefLocalAliasCaptureEscapeTests"/> cover) that neither
/// PR #4270 (#4259, GS9010) nor the rest of PR #4273 (#4271, GS9011)
/// originally reached. A goroutine capturing a <c>ref</c>/<c>var ref</c>
/// LOCAL alias or a <c>ref</c>/<c>out</c>/<c>in</c> PARAMETER compiled
/// cleanly and silently lost the mutation, exactly like the lambda/local-
/// function cases — the synthesized display class stores only
/// <c>captured.Type</c> (a by-value snapshot), not a live reference.
/// <para>
/// Fix: <c>StatementBinder.BindGoStatement</c> now runs the same capture set
/// (<see cref="GoCapturedVariableCollector"/>, moved out of
/// <c>Emit.SlotPlanner</c> so bind time and emit time share one
/// implementation and can never disagree) through the same
/// <see cref="ClosureCaptureLegalityChecker"/> that <see cref="LambdaBinder"/>
/// itself now calls at its own two capture-check sites — a single shared
/// validator, per the review's own suggestion.
/// </para>
/// <para>
/// Unlike issue #4222's per-suspension-point liveness check (which only
/// matters because a synchronous return before the first <c>await</c> can
/// keep a ref-alias local's lifetime entirely within one segment), a
/// goroutine body always runs concurrently with — and may outlive — the
/// launching statement, whether or not it is wrapped in a <c>scope</c> (which
/// only joins the goroutine later; it never runs it synchronously inline).
/// So this capture is unconditionally an escape: no confinement carve-out
/// applies here, and none is added.
/// </para>
/// </summary>
public class Issue4273GoClosureRefCaptureTests
{
    [Fact]
    public void RefLocalAlias_CapturedInScopedGoStatement_Reports_GS9011()
    {
        // Copilot's own repro, verbatim (this repo's actual `go`/`scope` syntax).
        var source = """
            package P

            func Mutate(ref x int32) {
                x = x + 1
            }

            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                scope {
                    go Mutate(ref alias)
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefLocalAlias_CapturedInGoStatement_WithoutScope_Reports_GS9011()
    {
        // Same capture, without the `scope` wrapper — confirms the check does
        // not depend on (and is not accidentally gated by) a `scope` block.
        var source = """
            package P

            func Mutate(ref x int32) {
                x = x + 1
            }

            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                go Mutate(ref alias)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefParameter_CapturedInGoStatement_Reports_GS9010()
    {
        // The GS9010 sibling gap: a `ref` PARAMETER of the enclosing function
        // captured by a `go` closure has the identical bug (and, pre-fix, the
        // identical silent gap) as the ref-alias LOCAL case above.
        var source = """
            package P

            func Mutate(ref x int32) {
                x = x + 1
            }

            func Foo(ref y int32) {
                scope {
                    go Mutate(ref y)
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void OutParameter_CapturedInGoStatement_Reports_GS9010()
    {
        var source = """
            package P

            func Mutate(ref x int32) {
                x = x + 1
            }

            func Foo(out y int32) {
                y = 0
                scope {
                    go Mutate(ref y)
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void InParameter_CapturedInGoStatement_Reports_GS9010()
    {
        var source = """
            package P

            func Read(x int32) int32 {
                return x
            }

            func Consume(v int32) {
            }

            func Foo(in y int32) {
                scope {
                    go Consume(Read(y))
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void OrdinaryLocal_CapturedInGoStatement_IsLegal()
    {
        // No over-rejection: an ordinary (non-ref) captured local — a
        // goroutine capturing a plain variable is a common, legitimate
        // pattern — must remain unaffected.
        var source = """
            package P

            func Mutate(x int32) {
            }

            func Foo() {
                var n = 5
                scope {
                    go Mutate(n)
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefLocalAlias_CapturedInInlineGoLiteral_Reports_GS9011()
    {
        // `go func() { ... }()` binds the literal through LambdaBinder FIRST
        // (which already reports GS9011 at the literal itself), and then
        // GoCapturedVariableCollector folds the literal's own
        // CapturedVariables into the go-wrapper's capture set (issue #3323),
        // so this new check reports GS9011 a second time at the go
        // expression's location. Both reports are accurate — the lambda
        // closure and the go-wrapper closure each independently snapshot
        // `alias` — so this is an expected, not a spurious, duplicate; pinned
        // here so a future change to either check's ordering is visible.
        var source = """
            package P

            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                scope {
                    go func() { alias = alias + 1 }()
                }
            }
            """;

        var diagnostics = Bind(source);

        // Pin the count, not just presence: proves the go-wrapper check
        // actually fires for the inline-literal shape (one report from
        // LambdaBinder on the literal itself, one from this fix on the
        // go-wrapper) rather than merely re-observing LambdaBinder's own,
        // already-covered report.
        Assert.Equal(2, diagnostics.Count(d => d.Id == "GS9011"));
    }

    [Fact]
    public void RefLocalAlias_CapturedInAsyncLet_Reports_GS9011()
    {
        // `async let` (ADR-0174 D15) synthesizes its own BoundGoStatement
        // directly in StatementBinder.Narrowing.cs, bypassing
        // BindGoStatement entirely — a fourth closure-synthesis path with the
        // identical gap as the plain `go` statement case above.
        var source = """
            package P

            func Mutate(ref x int32) int32 {
                x = x + 1
                return x
            }

            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                scope {
                    async let r = Mutate(ref alias)
                    let n = await r
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefParameter_CapturedInAsyncLet_Reports_GS9010()
    {
        var source = """
            package P

            func Mutate(ref x int32) int32 {
                x = x + 1
                return x
            }

            func Foo(ref y int32) {
                scope {
                    async let r = Mutate(ref y)
                    let n = await r
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void OrdinaryLocal_CapturedInAsyncLet_IsLegal()
    {
        // No over-rejection: an ordinary (non-ref) captured local in an
        // `async let` initializer is a common, legitimate pattern.
        var source = """
            package P

            func Compute(x int32) int32 {
                return x + 1
            }

            func Foo() {
                var n = 5
                scope {
                    async let r = Compute(n)
                    let result = await r
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefLocalAlias_DirectlyMutated_NotViaGo_IsLegal()
    {
        // Control case (mirrors the issue's own): direct, non-closure
        // mutation through the alias is unaffected by this check.
        var source = """
            package P

            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                alias = alias + 1
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
