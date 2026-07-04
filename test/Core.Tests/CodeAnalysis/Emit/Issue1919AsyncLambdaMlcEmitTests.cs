// <copyright file="Issue1919AsyncLambdaMlcEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression tests for issue #1919: a delegate-typed local backing an async
/// lambda (e.g. <c>let twice async (int32) -> int32 = async (x int32) -> ...</c>)
/// compiled fine in gsc's default host mode, but ICEd with <c>GS9998:
/// NotSupportedException: Derived classes must provide an implementation.</c>
/// whenever gsc was driven with an explicit <c>/reference:</c> set (a
/// <see cref="System.Reflection.MetadataLoadContext"/> compile — the mode the
/// cs2gs migration pipeline and the MSBuild task both use).
/// </summary>
/// <remarks>
/// <para><b>Root cause:</b> <see cref="Symbols.FunctionTypeSymbol"/>'s CLR
/// projection builds the delegate shape for a <c>func(...)  R</c> type clause
/// by calling <c>typeof(System.Func&lt;,&gt;).MakeGenericType(...)</c> — the
/// host's live <c>Func&lt;,&gt;</c> definition — closed over the (possibly
/// <see cref="System.Reflection.MetadataLoadContext"/>-projected) parameter
/// and return CLR types. When the return type was itself resolved through an
/// MLC (e.g. <c>Task[int32]</c> under <c>/reference:</c> mode),
/// <c>MakeGenericType</c> does not throw for this particular cross-context
/// mix; instead the CLR silently returns a
/// <see cref="System.Reflection.Emit.TypeBuilderInstantiation"/> — an
/// intentionally-tolerated, only-partially-real <see cref="Type"/> that this
/// codebase already special-cases in several places (see
/// <c>Binding/Conversion.cs</c>, <c>Binding/OverloadResolution.cs</c>).
/// <see cref="Lowering.Async.AsyncCaptureWalker"/> (and the sibling
/// <c>IteratorRewriter</c> / <c>AsyncIteratorRewriter</c> hoist walkers) read
/// <c>local.Type.ClrType.IsByRefLike</c> directly to skip stack-only locals
/// from being hoisted into the state-machine's fields — but
/// <c>TypeBuilderInstantiation.IsByRefLike</c> throws
/// <see cref="NotSupportedException"/> ("Derived classes must provide an
/// implementation.") instead of returning <see langword="false"/>, which
/// escaped all the way up as the reported GS9998 ICE.</para>
/// <para><b>Fix:</b> the three raw <c>.ClrType?.IsByRefLike</c> reads in
/// <see cref="Lowering.Async.AsyncCaptureWalker"/>,
/// <c>Lowering.Iterators.IteratorRewriter</c>, and
/// <c>Lowering.Iterators.AsyncIteratorRewriter</c> now go through the
/// existing metadata-load-safe <see cref="TypeSymbol.IsByRefLike(TypeSymbol)"/>
/// helper (backed by <see cref="ClrTypeUtilities.IsMetadataLoadFailure"/>,
/// which already tolerates <see cref="NotSupportedException"/>), matching the
/// convention every other CLR-reflection call site in the binder already
/// follows.</para>
/// </remarks>
public class Issue1919AsyncLambdaMlcEmitTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies. Supplying explicit paths forces gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path —
    /// the same path the cs2gs migration pipeline and the MSBuild task drive
    /// gsc through via <c>/reference:</c> — reproducing the cross-reflection-
    /// context scenario inside the unit-test process.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        // Issue #1919 repro note: a narrow reference set (just object/Task/
        // Console) does NOT reproduce the bug — some BCL types still resolve
        // through the live host context when the reference set is sparse.
        // The cs2gs pipeline (and the original repro) pass gsc the FULL
        // shared-framework assembly set via /reference:, which is what
        // forces every BCL type — including System.Threading.Tasks.Task`1 —
        // through the MetadataLoadContext. Mirror that here for a faithful
        // regression guard.
        var runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var paths = Directory.GetFiles(runtimeDir, "*.dll");
        return ReferenceResolver.WithReferences(paths);
    }

    /// <summary>
    /// Compiles and emits one or more <paramref name="sources"/> under the
    /// supplied <paramref name="references"/>, loads the resulting PE,
    /// invokes its entry point, and returns captured console output. Passing
    /// an MLC-backed resolver exercises the exact emit path (lowering + IL
    /// generation) the original bug report hit — not merely binding.
    /// </summary>
    /// <remarks>
    /// The original repro only reproduces when the async lambda lives inside
    /// a <c>class { shared { async func ... } }</c> member invoked from a
    /// *separate* file's top-level statements — a single top-level-statement
    /// file (or a single-file compile) does not trigger it. This mirrors the
    /// exact shape cs2gs emits for the G10 grid corpus (a
    /// <c>Program.gs</c> entry point invoking a fixture class defined in
    /// another translated file), so multi-tree compiles are required here to
    /// genuinely regression-guard the reported bug.
    /// </remarks>
    private static string CompileAndRun(string contextName, ReferenceResolver references, params string[] sources)
    {
        using var peStream = new MemoryStream();
        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToArray();
        var compilation = new Compilation(references, trees);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    // Mirrors cs2gs's actual translation shape for the G10 grid corpus's
    // (previously quarantined) SimpleLambdaExpression fixture: the async
    // lambda lives in a class member, invoked from a separate top-level-
    // statements file. This exact two-file, class-member shape is required
    // to reproduce the bug (a single top-level-statements file does not
    // trigger it) — verified by bisecting the real cs2gs migrate output.
    private const string FixtureSource = """
        package Corpus.Grid10.Constructs

        import System
        import System.Threading.Tasks

        class SimpleLambdaExpressionFixture {
            shared {
                async func RunAsync() {
                    let twice async (int32) -> int32 = async (x int32) -> await Task.FromResult(x * 2)
                    let doubled = await twice(15)
                    Console.WriteLine("SimpleLambdaExpression: doubled=$doubled")
                    let combine async (int32, int32) -> int32 = async (a int32, b int32) -> {
                        let left = await Task.FromResult(a)
                        let right = await Task.FromResult(b)
                        return left + right
                    }
                    let combined = await combine(19, 23)
                    Console.WriteLine("SimpleLambdaExpression: combined=$combined")
                    let announce async () -> void = async () -> {
                        await Task.CompletedTask
                        Console.WriteLine("SimpleLambdaExpression: zero-arg async lambda ran")
                    }
                    await announce()
                }
            }
        }
        """;

    private const string ProgramSource = """
        package Corpus.Grid10

        import System
        import System.Threading.Tasks
        import Corpus.Grid10.Constructs

        private async func RunAllAsync() {
            await SimpleLambdaExpressionFixture.RunAsync()
        }

        RunAllAsync().GetAwaiter().GetResult()
        """;

    [Fact]
    public void AsyncLambda_AllForms_Compile_And_Run_UnderMetadataLoadContext()
    {
        // The exact repro shape from issue #1919 (matching the un-quarantined
        // grid G10 SimpleLambdaExpression fixture): before the fix, this
        // threw GS9998 "NotSupportedException: Derived classes must provide
        // an implementation." only when compiled with a full `/reference:`
        // set (a MetadataLoadContext compile — the mode cs2gs's migration
        // pipeline and the MSBuild task both drive gsc through), never in
        // default host mode. Covers all three async-lambda shapes the issue
        // called out: expression-bodied single-arg, block-bodied multi-arg,
        // and zero-arg void-returning.
        var output = CompileAndRun(
            "Issue1919AllForms",
            MetadataLoadContextResolver(),
            ProgramSource,
            FixtureSource);

        Assert.Contains("doubled=30", output);
        Assert.Contains("combined=42", output);
        Assert.Contains("zero-arg async lambda ran", output);
    }

    [Fact]
    public void AsyncLambda_AllForms_Compile_And_Run_ControlCase_DefaultResolver()
    {
        // Control case: the identical two-file source must already succeed
        // under the default (non-MLC, single reflection context) resolver,
        // confirming the fix does not regress the common host-mode compile
        // path.
        var output = CompileAndRun(
            "Issue1919AllFormsDefault",
            ReferenceResolver.Default(),
            ProgramSource,
            FixtureSource);

        Assert.Contains("doubled=30", output);
        Assert.Contains("combined=42", output);
        Assert.Contains("zero-arg async lambda ran", output);
    }

    [Fact]
    public void AsyncLambda_SingleArgForm_Compiles_UnderMetadataLoadContext()
    {
        // Narrower repro closest to the issue's literal one-line example
        // (`let twice async (int32) -> int32 = async (x int32) -> ...`),
        // kept as its own test so a future narrowing regression is easy to
        // pinpoint independently of the other lambda shapes.
        const string Fixture = """
            package Corpus.Grid10.Constructs

            import System
            import System.Threading.Tasks

            class SingleArgLambdaFixture {
                shared {
                    async func RunAsync() {
                        let twice async (int32) -> int32 = async (x int32) -> await Task.FromResult(x * 2)
                        let doubled = await twice(21)
                        Console.WriteLine("SingleArgLambda: doubled=$doubled")
                    }
                }
            }
            """;
        const string Program = """
            package Corpus.Grid10

            import System
            import System.Threading.Tasks
            import Corpus.Grid10.Constructs

            private async func RunAllAsync() {
                await SingleArgLambdaFixture.RunAsync()
            }

            RunAllAsync().GetAwaiter().GetResult()
            """;

        var output = CompileAndRun("Issue1919SingleArg", MetadataLoadContextResolver(), Program, Fixture);
        Assert.Contains("doubled=42", output);
    }
}
