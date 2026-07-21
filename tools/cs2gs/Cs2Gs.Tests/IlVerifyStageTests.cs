// <copyright file="IlVerifyStageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Tests for stage 3 (ADR-0115 §C/§D): the <c>ilverify</c> output parser, the
/// <c>ilverify-failure</c> triage artifact shape and fingerprint, the documented
/// false-positive ignore bundle, and the L1-Console end-to-end gate (which must
/// pass IL verification cleanly). The L1 path is gated on the <c>gsc</c> artifact
/// and the <c>dotnet-ilverify</c> tool being present, returning early otherwise
/// like the other e2e tests.
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public class IlVerifyStageTests
{
    private const string SampleErrorLine =
        "[IL]: Error [StackUnexpected]: [/abs/App.dll : Program::Main(string[])]" +
        "[offset 0x00000001] Unexpected type on the stack.";

    /// <summary>
    /// The parser extracts the ilverify error code and the failing
    /// <c>Type::Method(sig)</c> skeleton from a canonical error line, and ignores
    /// non-error banner/summary lines.
    /// </summary>
    [Fact]
    public void ParseErrors_ExtractsCodeAndMethod_SkipsNoise()
    {
        string output = string.Join(
            "\n",
            "All Classes and Methods in /abs/App.dll Verified.",
            SampleErrorLine,
            "Error(s): 1");

        IReadOnlyList<IlVerifyError> errors = IlVerifyRunner.ParseErrors(output);

        IlVerifyError error = Assert.Single(errors);
        Assert.Equal("StackUnexpected", error.Code);
        Assert.Equal("Program::Main(string[])", error.Method);
        Assert.Contains("Unexpected type on the stack.", error.RawLine);
    }

    /// <summary>
    /// An <c>ilverify-failure</c> artifact built from a parsed error carries the
    /// stage/category, a non-empty diagnostic id parsed from the line, labels
    /// <c>Oats</c> + <c>cil-emit</c>, and a stable <c>sha256:</c> fingerprint.
    /// </summary>
    [Fact]
    public void IlVerifyFailureArtifact_HasShapeAndCilEmitLabel()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");
        IlVerifyError error = Assert.Single(IlVerifyRunner.ParseErrors(SampleErrorLine));

        TriageArtifact artifact = builder.IlVerifyFailure(error, "corpus_Sample/Sample.gs");
        string json = JsonSerializer.Serialize(artifact, TriageSerialization.Options);
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;

        Assert.Equal("ilverify", root.GetProperty("stage").GetString());
        Assert.Equal("ilverify-failure", root.GetProperty("category").GetString());
        Assert.Equal("StackUnexpected", root.GetProperty("diagnostic").GetProperty("id").GetString());
        Assert.Equal("error", root.GetProperty("diagnostic").GetProperty("severity").GetString());
        Assert.False(string.IsNullOrEmpty(root.GetProperty("diagnostic").GetProperty("message").GetString()));
        Assert.Equal(
            "Program::Main(string[])",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString());

        string[] labels = root.GetProperty("suggestedIssue").GetProperty("labels")
            .EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Contains("Oats", labels);
        Assert.Contains("cil-emit", labels);

        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// The fingerprint splits on distinct error code and on distinct failing
    /// method, so the pipeline produces one artifact per code + method skeleton.
    /// </summary>
    [Fact]
    public void IlVerifyFailure_Fingerprint_SplitsOnCodeAndMethod()
    {
        var builder = new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample");

        TriageArtifact a = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"));
        TriageArtifact sameAgain = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"));
        TriageArtifact differentCode = builder.IlVerifyFailure(
            new IlVerifyError("ReturnVoid", "Program::Main(string[])", "line a"));
        TriageArtifact differentMethod = builder.IlVerifyFailure(
            new IlVerifyError("StackUnexpected", "Program::Helper(int32)", "line a"));

        Assert.Equal(a.Fingerprint, sameAgain.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentCode.Fingerprint);
        Assert.NotEqual(a.Fingerprint, differentMethod.Fingerprint);
    }

    /// <summary>
    /// The documented ilverify 10.0.8 false positives — <c>ReturnPtrToStack</c>
    /// (by-value ref-struct returns) and the static-virtual
    /// <c>CallAbstract</c>/<c>Constrained</c> bundle (ADR-0089 / #755) — are
    /// declared in the ignore set and filtered out so they never yield artifacts,
    /// while a genuine error survives.
    /// </summary>
    [Fact]
    public void IgnoreBundle_FiltersKnownFalsePositives_KeepsRealErrors()
    {
        Assert.Contains("ReturnPtrToStack", IlVerifyRunner.KnownIlVerifyFalsePositives);
        Assert.Contains("CallAbstract", IlVerifyRunner.KnownIlVerifyFalsePositives);
        Assert.Contains("Constrained", IlVerifyRunner.KnownIlVerifyFalsePositives);

        var errors = new[]
        {
            new IlVerifyError("ReturnPtrToStack", "Acc::Add(Acc, int32)", "fp 1"),
            new IlVerifyError("Constrained", "P::Sum<T>(T[])", "fp 2"),
            new IlVerifyError("CallAbstract", "P::Sum<T>(T[])", "fp 3"),
            new IlVerifyError(
                "StackUnexpected",
                "CompiledAvaloniaXaml.XamlIlContext+Context`1::get_ParentProvider()",
                "fp 4"),
            new IlVerifyError(
                "DelegateCtor",
                "Oahu.Core.UI.Avalonia.Views.AboutView::!XamlIlPopulate(System.IServiceProvider, AboutView)",
                "csc emits the same Avalonia-generated delegate construction"),
            new IlVerifyError("StackUnexpected", "P::Main(string[])", "real"),
        };

        IReadOnlyList<IlVerifyError> filtered = IlVerifyRunner.FilterIgnored(errors);

        IlVerifyError surviving = Assert.Single(filtered);
        Assert.Equal("StackUnexpected", surviving.Code);
    }

    /// <summary>
    /// #2671: Avalonia XamlIl deliberately carries concrete controls in
    /// object-typed stack slots. Its generated XamlClosure Build methods run
    /// correctly, but ILVerify reports StackUnexpected just as it does for the
    /// existing generated XamlIlContext methods.
    /// </summary>
    [Fact]
    public void AvaloniaXamlClosureBuilds_FilterExactUiFingerprints_AndGeneralize()
    {
        const string BookLibrary =
            "Oahu.Core.UI.Avalonia.Views.BookLibraryView+XamlClosure_1::Build_1([System.ComponentModel]System.IServiceProvider)";
        const string Conversion =
            "Oahu.Core.UI.Avalonia.Views.ConversionView+XamlClosure_2::Build_1([System.ComponentModel]System.IServiceProvider)";
        var builder = new TriageBuilder("run_1", "2026-07-21T00:00:00Z", "0.3.0", "corpus/Oahu.UI");
        string bookLibraryError = AvaloniaObjectSlotError(BookLibrary, "[System.ComponentModel.Primitives]System.ComponentModel.ISupportInitialize");
        string conversionError = AvaloniaObjectSlotError(Conversion, "[System.ComponentModel.Primitives]System.ComponentModel.ISupportInitialize");

        Assert.Equal(
            "sha256:9d0322446fc5a1cc4b78e2a66d5d83354b6e527fcd49d9f907fe63ccbb034a53",
            builder.IlVerifyFailure(new IlVerifyError("StackUnexpected", BookLibrary, bookLibraryError)).Fingerprint);
        Assert.Equal(
            "sha256:94a053bb50ec2721c8600fe77dd02aa29a401f95bf174b39b459218f5dfea5a7",
            builder.IlVerifyFailure(new IlVerifyError("StackUnexpected", Conversion, conversionError)).Fingerprint);

        var errors = new[]
        {
            new IlVerifyError("StackUnexpected", BookLibrary, bookLibraryError),
            new IlVerifyError("StackUnexpected", Conversion, conversionError),
            new IlVerifyError(
                "StackUnexpected",
                "Demo.View+XamlClosure_17::Build_42([System.ComponentModel]System.IServiceProvider)",
                AvaloniaObjectSlotError(
                    "Demo.View+XamlClosure_17::Build_42([System.ComponentModel]System.IServiceProvider)",
                    "Demo.Control")),
            new IlVerifyError("StackUnexpected", "Demo.View+XamlClosure_1::CreateContext()", "real create"),
            new IlVerifyError("StackUnexpected", "Demo.View+Closure_1::Build_1()", "real closure"),
            new IlVerifyError("ReturnVoid", "Demo.View+XamlClosure_1::Build_1()", "real code"),
            new IlVerifyError("StackUnexpected", BookLibrary, "[found value 'int32'][expected ref 'object']"),
        };

        IReadOnlyList<IlVerifyError> filtered = IlVerifyRunner.FilterIgnored(errors);

        Assert.Equal(4, filtered.Count);
        Assert.Contains(filtered, e => e.Method!.EndsWith("::CreateContext()", StringComparison.Ordinal));
        Assert.Contains(filtered, e => e.Method!.Contains("+Closure_1::", StringComparison.Ordinal));
        Assert.Contains(filtered, e => e.Code == "ReturnVoid");
        Assert.Contains(filtered, e => e.RawLine!.Contains("found value 'int32'", StringComparison.Ordinal));
    }

    /// <summary>
    /// Emits the upstream XamlIl stack shape rather than merely feeding mocked
    /// diagnostics to the filter: an object-typed local contains a concrete
    /// ISupportInitialize implementation and is called without a cast. Real
    /// ILVerify reports both exact Oahu Build fingerprints, while the CLR runs
    /// both methods and observes BeginInit/EndInit.
    /// </summary>
    [Fact]
    public void AvaloniaXamlClosureBuilds_RealIlVerifyAndRuntimeProof()
    {
        if (!IlVerifyRunner.IsEnabled || !IlVerifyToolAvailable())
        {
            return;
        }

        string directory = NewOutputRoot("issue2671-xaml-closure");
        string assemblyPath = Path.Combine(directory, "Oahu.UI.dll");
        EmitAvaloniaXamlClosureFixture(assemblyPath);

        try
        {
            var result = new IlVerifyRunner().Verify(assemblyPath);
            Assert.True(result.Succeeded, result.Output);
            Assert.Empty(result.Errors);
            Assert.Contains("[StackUnexpected]", result.Output, StringComparison.Ordinal);
            Assert.Contains(
                "BookLibraryView+XamlClosure_1::Build_1",
                result.Output,
                StringComparison.Ordinal);
            Assert.Contains(
                "ConversionView+XamlClosure_2::Build_1",
                result.Output,
                StringComparison.Ordinal);

            var loadContext = new AssemblyLoadContext("issue2671-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            try
            {
                Assembly assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
                AssertClosureRan(assembly, "BookLibraryView+XamlClosure_1");
                AssertClosureRan(assembly, "ConversionView+XamlClosure_2");
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// #1747 regression: exit 0 is always Passed, regardless of stray parsed
    /// error lines (the <c>-g</c> ignore flags + <see cref="IlVerifyRunner.FilterIgnored"/>
    /// already handle known false positives upstream of this decision).
    /// </summary>
    [Fact]
    public void FromRun_ExitZero_IsPassed()
    {
        IlVerifyResult result = IlVerifyResult.FromRun(0, "All Classes and Methods Verified.", Array.Empty<IlVerifyError>());
        Assert.Equal(IlVerifyStatus.Passed, result.Status);
        Assert.True(result.Succeeded);
    }

    /// <summary>
    /// #1747 regression: exit non-zero with real parsed error lines is Failed
    /// (unchanged behavior).
    /// </summary>
    [Fact]
    public void FromRun_NonZeroExitWithErrors_IsFailed()
    {
        var errors = new[] { new IlVerifyError("StackUnexpected", "P::Main(string[])", SampleErrorLine) };
        IlVerifyResult result = IlVerifyResult.FromRun(1, SampleErrorLine, errors);
        Assert.Equal(IlVerifyStatus.Failed, result.Status);
        Assert.False(result.Succeeded);
    }

    /// <summary>
    /// #1747: this is the bug's core case — ilverify crashes (or its output
    /// format no longer matches <see cref="IlVerifyRunner.ParseErrors"/>) and
    /// exits non-zero with zero parseable error lines. Before the fix this
    /// silently returned Passed, permanently defeating the gate; it must now
    /// return Failed so <see cref="IlVerifyStage"/>'s synthetic-artifact
    /// fallback is reachable.
    /// </summary>
    [Fact]
    public void FromRun_NonZeroExitWithNoParseableErrors_IsFailed_NotSilentlyPassed()
    {
        IlVerifyResult result = IlVerifyResult.FromRun(134, "Segmentation fault (core dumped)", Array.Empty<IlVerifyError>());
        Assert.Equal(IlVerifyStatus.Failed, result.Status);
        Assert.False(result.Succeeded);
        Assert.Equal(134, result.ExitCode);
    }

    /// <summary>
    /// #1747: when <see cref="IlVerifyRunner.Verify"/> reports a tool-crash
    /// Failed result (non-zero exit, no parseable errors), the stage must not
    /// pass silently — it hits the synthetic-artifact fallback in
    /// <c>IlVerifyStage</c> (ExecuteAsync's <c>artifacts.Count == 0</c> branch)
    /// and reports <see cref="StageOutcome"/> failed with one synthetic
    /// <c>ilverify-failure</c> artifact.
    /// </summary>
    [Fact]
    public async Task ExecuteAsync_ToolCrash_FailsStage_WithSyntheticArtifact()
    {
        string outRoot = NewOutputRoot("ilverify-tool-crash");
        var runner = new CrashingIlVerifyRunner();
        var stage = new IlVerifyStage(runner);

        string fakeAssembly = Path.Combine(outRoot, "App.dll");
        File.WriteAllBytes(fakeAssembly, Array.Empty<byte>());

        var app = new CorpusApp("corpus/Fake", "/fake/Fake.csproj", TargetKind.Exe);
        var options = new PipelineOptions { GscPath = "/fake/gsc.dll", OutputRoot = outRoot };
        var context = new StageExecutionContext(
            app,
            options,
            new GscInvoker(options.GscPath),
            outRoot,
            new TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Fake"))
        {
            EmittedAssemblyPath = fakeAssembly,
        };

        StageOutcome outcome = await stage.ExecuteAsync(context);

        Assert.Equal(StageStatus.Failed, outcome.Status);
        TriageArtifact artifact = Assert.Single(outcome.Artifacts);
        Assert.Equal("ilverify-failure", artifact.Category);
    }

    private sealed class CrashingIlVerifyRunner : IlVerifyRunner
    {
        public override IlVerifyResult Verify(string assemblyPath, IReadOnlyList<string> additionalReferences = null) =>
            IlVerifyResult.FromRun(134, "Segmentation fault (core dumped)", Array.Empty<IlVerifyError>());
    }

    /// <summary>
    /// Running the pipeline over <c>corpus/L1-Console</c> passes stage 3
    /// (<c>ilverify</c>) cleanly with zero artifacts: all three stages green and
    /// the stage list now has three entries. Gated on the compiler artifact and
    /// the ilverify tool being present.
    /// </summary>
    [Fact]
    public async Task L1_StageThree_IsGreen_WithZeroArtifacts()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("l1-ilverify-green");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console");
        Assert.NotNull(l1);

        RunResult result = await pipeline.RunAsync(new[] { l1 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "L1 must migrate green through stage 3 (ilverify). Failure category: " +
                (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
        Assert.Empty(app.Artifacts);
        Assert.Equal(4, app.Stages.Count);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
        Assert.Equal("ilverify", app.Stages[2].Stage);
    }

    private static bool IlVerifyToolAvailable()
    {
        if (!IlVerifyRunner.IsEnabled)
        {
            // GSHARP_SKIP_ILVERIFY=1: the stage no-ops to PASS, so the green
            // assertion still holds.
            return true;
        }

        try
        {
            return new IlVerifyRunner().EnsureToolAvailable();
        }
        catch
        {
            return false;
        }
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static void EmitAvaloniaXamlClosureFixture(string path)
    {
        var assembly = new PersistedAssemblyBuilder(
            new AssemblyName("Oahu.UI." + Guid.NewGuid().ToString("N")),
            typeof(object).Assembly);
        ModuleBuilder module = assembly.DefineDynamicModule("Oahu.UI");

        TypeBuilder control = module.DefineType("Oahu.Core.UI.Avalonia.Views.GeneratedControl", TypeAttributes.Public);
        control.AddInterfaceImplementation(typeof(ISupportInitialize));
        FieldBuilder beginCalled = control.DefineField("BeginCalled", typeof(bool), FieldAttributes.Public);
        FieldBuilder endCalled = control.DefineField("EndCalled", typeof(bool), FieldAttributes.Public);
        ConstructorBuilder constructor = control.DefineDefaultConstructor(MethodAttributes.Public);
        DefineInitMethod(control, beginCalled, nameof(ISupportInitialize.BeginInit));
        DefineInitMethod(control, endCalled, nameof(ISupportInitialize.EndInit));

        DefineClosure(module, control, constructor, "BookLibraryView", "XamlClosure_1");
        DefineClosure(module, control, constructor, "ConversionView", "XamlClosure_2");
        control.CreateType();
        assembly.Save(path);
    }

    private static void DefineInitMethod(TypeBuilder control, FieldBuilder field, string name)
    {
        MethodBuilder method = control.DefineMethod(
            name,
            MethodAttributes.Public | MethodAttributes.Virtual,
            typeof(void),
            Type.EmptyTypes);
        ILGenerator il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Ldc_I4_1);
        il.Emit(OpCodes.Stfld, field);
        il.Emit(OpCodes.Ret);
        control.DefineMethodOverride(method, typeof(ISupportInitialize).GetMethod(name)!);
    }

    private static void DefineClosure(
        ModuleBuilder module,
        TypeBuilder control,
        ConstructorBuilder constructor,
        string viewName,
        string closureName)
    {
        TypeBuilder view = module.DefineType(
            "Oahu.Core.UI.Avalonia.Views." + viewName,
            TypeAttributes.Public);
        TypeBuilder closure = view.DefineNestedType(
            closureName,
            TypeAttributes.NestedPublic | TypeAttributes.Abstract | TypeAttributes.Sealed);
        MethodBuilder build = closure.DefineMethod(
            "Build_1",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(object),
            new[] { typeof(IServiceProvider) });
        ILGenerator il = build.GetILGenerator();
        LocalBuilder root = il.DeclareLocal(typeof(object));
        il.Emit(OpCodes.Newobj, constructor);
        il.Emit(OpCodes.Stloc, root);
        il.Emit(OpCodes.Ldloc, root);
        il.Emit(OpCodes.Callvirt, typeof(ISupportInitialize).GetMethod(nameof(ISupportInitialize.BeginInit))!);
        il.Emit(OpCodes.Ldloc, root);
        il.Emit(OpCodes.Callvirt, typeof(ISupportInitialize).GetMethod(nameof(ISupportInitialize.EndInit))!);
        il.Emit(OpCodes.Ldloc, root);
        il.Emit(OpCodes.Ret);
        closure.CreateType();
        view.CreateType();
    }

    private static void AssertClosureRan(Assembly assembly, string typeName)
    {
        Type closure = assembly.GetType("Oahu.Core.UI.Avalonia.Views." + typeName)!;
        object result = closure.GetMethod("Build_1")!.Invoke(null, new object[] { null })!;
        Assert.True((bool)result.GetType().GetField("BeginCalled")!.GetValue(result)!);
        Assert.True((bool)result.GetType().GetField("EndCalled")!.GetValue(result)!);
    }

    private static string AvaloniaObjectSlotError(string method, string expected) =>
        $"[IL]: Error [StackUnexpected]: [/proof/Oahu.UI.dll : {method}]" +
        $"[offset 0x0000001B][found ref 'object'][expected ref '{expected}'] Unexpected type on the stack.";

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}
