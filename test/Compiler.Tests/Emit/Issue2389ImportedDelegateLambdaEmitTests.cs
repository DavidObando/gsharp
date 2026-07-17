// <copyright file="Issue2389ImportedDelegateLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2389 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for target-typing an UNTYPED arrow lambda
/// (<c>(count) -&gt; ...</c>, no parameter type clauses) used with
/// <c>+=</c>/<c>-=</c> against a genuinely IMPORTED (separately Roslyn-
/// compiled, real-assembly) CLR delegate/event. Before the fix,
/// <c>ExpressionBinder.BindEventSubscriptionHandler</c>'s fallback path
/// bound the handler syntax through the untargeted
/// <c>BindExpression(handlerSyntax)</c>, which for an arrow lambda dispatches
/// to <c>LambdaBinder.BindLambdaExpression</c> with NO target function type
/// — so an omitted parameter type clause always failed with GS0304, even
/// though the event's declared delegate type fully determines the expected
/// parameter/return shape. A TYPED lambda (<c>(count int32) -&gt; ...</c>) or
/// a SOURCE-defined delegate shape (<c>event E (args) -&gt; ret</c>, ADR-0076)
/// never hit this gap because their parameter types either don't need
/// inference or are threaded through a different, already target-typed
/// binder path.
///
/// The fix reuses the same <c>MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol</c>
/// helper already used by target-typed local declarations
/// (<c>StatementBinder.Narrowing.cs</c>) and call-argument inference
/// (<c>OverloadResolver.*</c>) to convert the event's delegate type into its
/// structural <c>FunctionTypeSymbol</c> shape before binding the lambda, so
/// omitted parameter types are filled in from the delegate's own signature.
///
/// These tests exercise the full, corrected pipeline end to end against a
/// REAL, separately-compiled C# sibling assembly ("genuinely imported",
/// exactly like a NuGet package or Oahu.* reference) exposing both instance
/// and static events of a custom delegate shape (0/1/3 parameters, and a
/// non-void return for inferred-return-type coverage) as well as the
/// standard BCL <c>EventHandler</c> shape.
/// </summary>
public class Issue2389ImportedDelegateLambdaEmitTests
{
    [Fact]
    public void InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Ticked += (count) -> System.Console.WriteLine("tick ${count}")
                t.FireTicked(5)
            }
            """,
            nameof(InstanceEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies));

        Assert.Equal("tick 5\n", output);
    }

    [Fact]
    public void InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Changed += (sender, e) -> System.Console.WriteLine("changed")
                t.FireChanged()
            }
            """,
            nameof(InstanceEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies));

        Assert.Equal("changed\n", output);
    }

    [Fact]
    public void InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Pulsed += () -> System.Console.WriteLine("pulsed")
                t.FirePulsed()
            }
            """,
            nameof(InstanceEvent_ZeroParamDelegate_UntypedLambda_RunsAndVerifies));

        Assert.Equal("pulsed\n", output);
    }

    [Fact]
    public void InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Combined += (a, b, c) -> System.Console.WriteLine("combined ${a} ${b} ${c}")
                t.FireCombined(1, 2, 3)
            }
            """,
            nameof(InstanceEvent_ThreeParamDelegate_UntypedLambda_RunsAndVerifies));

        Assert.Equal("combined 1 2 3\n", output);
    }

    [Fact]
    public void InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Transforming += (x) -> x * 2
                let r = t.FireTransforming(10)
                System.Console.WriteLine("transform ${r}")
            }
            """,
            nameof(InstanceEvent_NonVoidDelegate_UntypedLambda_InfersReturnType_RunsAndVerifies));

        Assert.Equal("transform 20\n", output);
    }

    [Fact]
    public void StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                Ticker.StaticTicked += (count) -> System.Console.WriteLine("static tick ${count}")
                Ticker.FireStaticTicked(9)
            }
            """,
            nameof(StaticEvent_CustomOneParamDelegate_UntypedLambda_RunsAndVerifies));

        Assert.Equal("static tick 9\n", output);
    }

    [Fact]
    public void StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies()
    {
        var libraryPath = EmitCSharpLibrary(nameof(StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                Ticker.StaticChanged += (sender, e) -> System.Console.WriteLine("static changed")
                Ticker.FireStaticChanged()
            }
            """,
            nameof(StaticEvent_EventHandlerShape_UntypedLambda_RunsAndVerifies));

        Assert.Equal("static changed\n", output);
    }

    [Fact]
    public void InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies()
    {
        // Issue #2389 add/remove symmetry: the fix lives in the single
        // BindEventSubscriptionHandler helper shared by both `+=` (isAdd:
        // true) and `-=` (isAdd: false) — mirroring the established
        // symmetry-test convention (see Issue1473FunctionTypeEventEmitTests),
        // this proves the SAME untyped-lambda inference gap that `+=` hit is
        // also closed for `-=`, end to end (compile, IL-verify, run).
        var libraryPath = EmitCSharpLibrary(nameof(InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies));

        var output = CompileAndRun(
            libraryPath,
            """
            package App
            import System
            import Lib2389

            func Main() {
                let t = Ticker()
                t.Ticked += (count) -> System.Console.WriteLine("added ${count}")
                t.FireTicked(1)
                t.Ticked -= (count) -> System.Console.WriteLine("added ${count}")
                System.Console.WriteLine("removed-ok")
            }
            """,
            nameof(InstanceEvent_UntypedLambda_AddThenRemove_SymmetricallyBindsAndVerifies));

        Assert.Equal("added 1\nremoved-ok\n", output);
    }

    private static string EmitCSharpLibrary(string caseName)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib2389.dll");

        const string csharpSource = """
            using System;

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
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        // ilverify resolves `-r` references by the reference FILE's simple
        // name (sans extension), not by the assembly's embedded metadata
        // identity — so the emitted assembly's declared Name must match its
        // file name ("Lib2389") even though each test case's copy lives in
        // its own per-case subdirectory to avoid cross-test collisions.
        var compilation = CSharpCompilation.Create(
            "Lib2389",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }

    private static string CompileAndRun(string libraryPath, string gsharpSource, string caseName)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var assemblyName = "Issue2389Emit.Consumer." + caseName;
        var consumerPath = Path.Combine(LibraryDirectory(), assemblyName + ".dll");
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(gsharpSource)));

        using (var peStream = File.Create(consumerPath))
        {
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: assemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var loadContext = new AssemblyLoadContext(assemblyName, isCollectible: true);
        try
        {
            var libraryLoadContext = new AssemblyLoadContext(assemblyName + "-Lib", isCollectible: true);
            try
            {
                libraryLoadContext.LoadFromAssemblyPath(libraryPath);
                var libraryAssemblyName = Path.GetFileNameWithoutExtension(libraryPath);
                loadContext.Resolving += (ctx, name) => string.Equals(name.Name, libraryAssemblyName, StringComparison.Ordinal)
                    ? libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                    : null;

                var asm = loadContext.LoadFromAssemblyPath(consumerPath);
                var entry = asm.EntryPoint;
                Assert.NotNull(entry);

                var stdout = Console.Out;
                var captured = new StringWriter();
                Console.SetOut(captured);
                try
                {
                    entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                }
                finally
                {
                    Console.SetOut(stdout);
                }

                return captured.ToString().Replace("\r\n", "\n");
            }
            finally
            {
                libraryLoadContext.Unload();
            }
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2389Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }
}
