// <copyright file="Issue1919AsyncLambdaMlcEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Runtime.Loader
import Xunit

/// Regression tests for issue #1919: a delegate-typed local backing an async
/// lambda (e.g. `let twice async (int32) -> int32 = async (x int32) -> ...`)
/// compiled fine in gsc's default host mode, but ICEd with `GS9998:
/// NotSupportedException: Derived classes must provide an implementation.`
/// whenever gsc was driven with an explicit `/reference:` set (a
/// (cref:System.Reflection.MetadataLoadContext) compile — the mode the
/// cs2gs migration pipeline and the MSBuild task both use).
/// @remarks <b>Root cause:</b> (cref:Symbols.FunctionTypeSymbol)'s CLR
/// projection builds the delegate shape for a `func(...) R` type clause
/// by calling `typeof(System.Func<,>).MakeGenericType(...)` — the
/// host's live `Func<,>` definition — closed over the (possibly
/// (cref:System.Reflection.MetadataLoadContext)-projected) parameter
/// and return CLR types. When the return type was itself resolved through an
/// MLC (e.g. `Task[int32]` under `/reference:` mode),
/// `MakeGenericType` does not throw for this particular cross-context
/// mix; instead the CLR silently returns a
/// (cref:System.Reflection.Emit.TypeBuilderInstantiation) — an
/// intentionally-tolerated, only-partially-real (cref:Type) that this
/// codebase already special-cases in several places (see
/// `Binding/Conversion.cs`, `Binding/ClrOverloadResolution.cs`).
/// (cref:Lowering.Async.AsyncCaptureWalker) (and the sibling
/// `IteratorRewriter` / `AsyncIteratorRewriter` hoist walkers) read
/// `local.Type.ClrType.IsByRefLike` directly to skip stack-only locals
/// from being hoisted into the state-machine's fields — but
/// `TypeBuilderInstantiation.IsByRefLike` throws
/// (cref:NotSupportedException) ("Derived classes must provide an
/// implementation.") instead of returning `false`, which
/// escaped all the way up as the reported GS9998 ICE.
///
/// <b>Fix:</b> the three raw `.ClrType?.IsByRefLike` reads in
/// (cref:Lowering.Async.AsyncCaptureWalker),
/// `Lowering.Iterators.IteratorRewriter`, and
/// `Lowering.Iterators.AsyncIteratorRewriter` now go through the
/// existing metadata-load-safe (cref:TypeSymbol.IsByRefLike(TypeSymbol))
/// helper (backed by (cref:ClrTypeUtilities.IsMetadataLoadFailure),
/// which already tolerates (cref:NotSupportedException)), matching the
/// convention every other CLR-reflection call site in the binder already
/// follows.
open class Issue1919AsyncLambdaMlcEmitTests {
    @Fact
    func AsyncLambda_AllForms_Compile_And_Run_UnderMetadataLoadContext() {
        // The exact repro shape from issue #1919 (matching the un-quarantined
        // grid G10 SimpleLambdaExpression fixture): before the fix, this
        // threw GS9998 "NotSupportedException: Derived classes must provide
        // an implementation." only when compiled with a full `/reference:`
        // set (a MetadataLoadContext compile — the mode cs2gs's migration
        // pipeline and the MSBuild task both drive gsc through), never in
        // default host mode. Covers all three async-lambda shapes the issue
        // called out: expression-bodied single-arg, block-bodied multi-arg,
        // and zero-arg void-returning.
        let output = CompileAndRun("Issue1919AllForms", MetadataLoadContextResolver(), ProgramSource, FixtureSource)
        Assert.Contains("doubled=30", output)
        Assert.Contains("combined=42", output)
        Assert.Contains("zero-arg async lambda ran", output)
    }

    @Fact
    func AsyncLambda_AllForms_Compile_And_Run_ControlCase_DefaultResolver() {
        // Control case: the identical two-file source must already succeed
        // under the default (non-MLC, single reflection context) resolver,
        // confirming the fix does not regress the common host-mode compile
        // path.
        let output = CompileAndRun(
            "Issue1919AllFormsDefault",
            ReferenceResolver.Default(),
            ProgramSource,
            FixtureSource
        )
        Assert.Contains("doubled=30", output)
        Assert.Contains("combined=42", output)
        Assert.Contains("zero-arg async lambda ran", output)
    }

    @Fact
    func AsyncLambda_SingleArgForm_Compiles_UnderMetadataLoadContext() {
        // Narrower repro closest to the issue's literal one-line example
        // (`let twice async (int32) -> int32 = async (x int32) -> ...`),
        // kept as its own test so a future narrowing regression is easy to
        // pinpoint independently of the other lambda shapes.
        const Fixture = `package Corpus.Grid10.Constructs

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
}`
        const Program = `package Corpus.Grid10

import System
import System.Threading.Tasks
import Corpus.Grid10.Constructs

private async func RunAllAsync() {
    await SingleArgLambdaFixture.RunAsync()
}

RunAllAsync().GetAwaiter().GetResult()`
        let output = CompileAndRun("Issue1919SingleArg", MetadataLoadContextResolver(), Program, Fixture)
        Assert.Contains("doubled=42", output)
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies. Supplying explicit paths forces gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path —
        /// the same path the cs2gs migration pipeline and the MSBuild task drive
        /// gsc through via `/reference:` — reproducing the cross-reflection-
        /// context scenario inside the unit-test process.
        private func MetadataLoadContextResolver() ReferenceResolver {
            // Issue #1919 repro note: a narrow reference set (just object/Task/
            // Console) does NOT reproduce the bug — some BCL types still resolve
            // through the live host context when the reference set is sparse.
            // The cs2gs pipeline (and the original repro) pass gsc the FULL
            // shared-framework assembly set via /reference:, which is what
            // forces every BCL type — including System.Threading.Tasks.Task`1 —
            // through the MetadataLoadContext. Mirror that here for a faithful
            // regression guard.
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let paths = Directory.GetFiles(runtimeDir, "*.dll")
            return ReferenceResolver.WithReferences(paths)
        }

        /// Compiles and emits one or more [`sources`](paramref) under the
        /// supplied [`references`](paramref), loads the resulting PE,
        /// invokes its entry point, and returns captured console output. Passing
        /// an MLC-backed resolver exercises the exact emit path (lowering + IL
        /// generation) the original bug report hit — not merely binding.
        /// @remarks The original repro only reproduces when the async lambda lives inside
        /// a `class { shared { async func ... } }` member invoked from a
        /// *separate* file's top-level statements — a single top-level-statement
        /// file (or a single-file compile) does not trigger it. This mirrors the
        /// exact shape cs2gs emits for the G10 grid corpus (a
        /// `Program.gs` entry point invoking a fixture class defined in
        /// another translated file), so multi-tree compiles are required here to
        /// genuinely regression-guard the reported bug.
        private func CompileAndRun(contextName string, references ReferenceResolver, sources ...string) string {
            using let peStream = MemoryStream()
            let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToArray()
            let compilation = Compilation(references, trees)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        // Mirrors cs2gs's actual translation shape for the G10 grid corpus's
        // (previously quarantined) SimpleLambdaExpression fixture: the async
        // lambda lives in a class member, invoked from a separate top-level-
        // statements file. This exact two-file, class-member shape is required
        // to reproduce the bug (a single top-level-statements file does not
        // trigger it) — verified by bisecting the real cs2gs migrate output.
        private const FixtureSource string = `package Corpus.Grid10.Constructs

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
}`

        private const ProgramSource string = `package Corpus.Grid10

import System
import System.Threading.Tasks
import Corpus.Grid10.Constructs

private async func RunAllAsync() {
    await SimpleLambdaExpressionFixture.RunAsync()
}

RunAllAsync().GetAwaiter().GetResult()`
    }
}
