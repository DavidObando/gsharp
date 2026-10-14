// <copyright file="Issue2389ImportedDelegateLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2389 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for target-typing an UNTYPED arrow lambda
/// (`(count) -> ...`, no parameter type clauses) used with
/// `+=`/`-=` against a genuinely IMPORTED (separately Roslyn-
/// compiled, real-assembly) CLR delegate/event. Before the fix,
/// `ExpressionBinder.BindEventSubscriptionHandler`'s fallback path
/// bound the handler syntax through the untargeted
/// `BindExpression(handlerSyntax)`, which for an arrow lambda dispatches
/// to `LambdaBinder.BindLambdaExpression` with NO target function type
/// — so an omitted parameter type clause always failed with GS0304, even
/// though the event's declared delegate type fully determines the expected
/// parameter/return shape. A TYPED lambda (`(count int32) -> ...`) or
/// a SOURCE-defined delegate shape (`event E (args) -> ret`, ADR-0076)
/// never hit this gap because their parameter types either don't need
/// inference or are threaded through a different, already target-typed
/// binder path.
///
/// The fix reuses the same `MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol`
/// helper already used by target-typed local declarations
/// (`StatementBinder.Narrowing.cs`) and call-argument inference
/// (`OverloadResolver.*`) to convert the event's delegate type into its
/// structural `FunctionTypeSymbol` shape before binding the lambda, so
/// omitted parameter types are filled in from the delegate's own signature.
///
/// These tests exercise the full, corrected pipeline end to end against a
/// REAL, separately-compiled C# sibling assembly ("genuinely imported",
/// exactly like a NuGet package or Oahu.* reference) exposing both instance
/// and static events of a custom delegate shape (0/1/3 parameters, and a
/// non-void return for inferred-return-type coverage) as well as the
/// standard BCL `EventHandler` shape.
open class Issue2389ImportedDelegateLambdaEmitTests {
    @Fact
    func InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Ticked += (count) -> System.Console.WriteLine("tick ${count}")
    t.FireTicked(5)
}`, "InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies")
        Assert.Equal("tick 5${Environment.NewLine}", output)
    }

    @Fact
    func InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Changed += (sender, e) -> System.Console.WriteLine("changed")
    t.FireChanged()
}`, "InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies")
        Assert.Equal("changed${Environment.NewLine}", output)
    }

    @Fact
    func InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Pulsed += () -> System.Console.WriteLine("pulsed")
    t.FirePulsed()
}`, "InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies")
        Assert.Equal("pulsed${Environment.NewLine}", output)
    }

    @Fact
    func InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Combined += (a, b, c) -> System.Console.WriteLine("combined ${a} ${b} ${c}")
    t.FireCombined(1, 2, 3)
}`, "InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies")
        Assert.Equal("combined 1 2 3${Environment.NewLine}", output)
    }

    @Fact
    func InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary(
            "InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies"
        )
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Transforming += (x) -> x * 2
    let r = t.FireTransforming(10)
    System.Console.WriteLine("transform ${r}")
}`, "InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies")
        Assert.Equal("transform 20${Environment.NewLine}", output)
    }

    @Fact
    func StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    Ticker.StaticTicked += (count) -> System.Console.WriteLine("static tick ${count}")
    Ticker.FireStaticTicked(9)
}`, "StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies")
        Assert.Equal("static tick 9${Environment.NewLine}", output)
    }

    @Fact
    func StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies() {
        let libraryPath = EmitCSharpLibrary("StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    Ticker.StaticChanged += (sender, e) -> System.Console.WriteLine("static changed")
    Ticker.FireStaticChanged()
}`, "StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies")
        Assert.Equal("static changed${Environment.NewLine}", output)
    }

    @Fact
    func InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies() {
        // Issue #2389 add/remove symmetry: the fix lives in the single
        // BindEventSubscriptionHandler helper shared by both `+=` (isAdd:
        // true) and `-=` (isAdd: false) — mirroring the established
        // symmetry-test convention (see Issue1473FunctionTypeEventEmitTests),
        // this proves the SAME untyped-lambda inference gap that `+=` hit is
        // also closed for `-=`, end to end (compile, IL-verify, run).
        let libraryPath = EmitCSharpLibrary("InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies")
        let output = CompileAndRun(libraryPath, `package App
import System
import Lib2389

func Main() {
    let t = Ticker()
    t.Ticked += (count) -> System.Console.WriteLine("added ${count}")
    t.FireTicked(1)
    t.Ticked -= (count) -> System.Console.WriteLine("added ${count}")
    System.Console.WriteLine("removed-ok")
}`, "InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies")
        Assert.Equal("added 1${Environment.NewLine}removed-ok${Environment.NewLine}", output)
    }

    shared {
        private func EmitCSharpLibrary(caseName string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib2389.dll")
            const csharpSource = `using System;

namespace Lib2389
{
    public delegate void TickHandler(int count);
    public delegate int Transformer(int x);
    public delegate void Combiner(int a, int b, int c);
    public delegate void Pulse();

    public class Ticker
    {
        public event TickHandler Ticked;
        public event EventHandler Changed;
        public event Transformer Transforming;
        public event Combiner Combined;
        public event Pulse Pulsed;
        public static event TickHandler StaticTicked;
        public static event EventHandler StaticChanged;

        public void FireTicked(int count) => Ticked?.Invoke(count);

        public void FireChanged() => Changed?.Invoke(this, EventArgs.Empty);

        public int FireTransforming(int x) => Transforming != null ? Transforming(x) : -1;

        public void FireCombined(int a, int b, int c) => Combined?.Invoke(a, b, c);

        public void FirePulsed() => Pulsed?.Invoke();

        public static void FireStaticTicked(int count) => StaticTicked?.Invoke(count);

        public static void FireStaticChanged() => StaticChanged?.Invoke(null, EventArgs.Empty);
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
            // ilverify resolves `-r` references by the reference FILE's simple
            // name (sans extension), not by the assembly's embedded metadata
            // identity — so the emitted assembly's declared Name must match its
            // file name ("Lib2389") even though each test case's copy lives in
            // its own per-case subdirectory to avoid cross-test collisions.
            let compilation = CSharpCompilation.Create(
                "Lib2389",
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

        private func CompileAndRun(libraryPath string, gsharpSource string, caseName string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let assemblyName = "Issue2389Emit.Consumer." + caseName
            let consumerPath = Path.Combine(LibraryDirectory(), assemblyName + ".dll")
            let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(gsharpSource)))
            {
                using let peStream = File.Create(consumerPath)
                let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            let loadContext = AssemblyLoadContext(assemblyName, isCollectible: true)
            try {
                let libraryLoadContext = AssemblyLoadContext(assemblyName + "-Lib", isCollectible: true)
                try {
                    libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                    let libraryAssemblyName = Path.GetFileNameWithoutExtension(libraryPath)
                    loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                        name.Name,
                        libraryAssemblyName,
                        StringComparison.Ordinal
                    ) {
                        libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                    } else {
                        default(Assembly?)
                    }
                    let asm = loadContext.LoadFromAssemblyPath(consumerPath)
                    let entry MethodInfo? = asm.EntryPoint
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
                    } finally {
                        Console.SetOut(stdout)
                    }
                    return captured.ToString().ReplaceLineEndings(Environment.NewLine)
                } finally {
                    libraryLoadContext.Unload()
                }
            } finally {
                loadContext.Unload()
            }
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2389Emit")
            Directory.CreateDirectory(dir)
            return dir
        }
    }
}
