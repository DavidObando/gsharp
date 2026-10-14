// <copyright file="IlVerifyStageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.ComponentModel
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.Loader
import System.Text.Json
import System.Threading.Tasks
import Xunit

/// Tests for stage 3 (ADR-0115 §C/§D): the `ilverify` output parser, the
/// `ilverify-failure` triage artifact shape and fingerprint, the documented
/// false-positive ignore bundle, and the L1-Console end-to-end gate (which must
/// pass IL verification cleanly). The L1 path is gated on the `gsc` artifact
/// and the `dotnet-ilverify` tool being present, returning early otherwise
/// like the other e2e tests.
@Collection("IlVerifyPipeline")
open class IlVerifyStageTests {
    /// The parser extracts the ilverify error code and the failing
    /// `Type::Method(sig)` skeleton from a canonical error line, and ignores
    /// non-error banner/summary lines.
    @Fact
    func ParseErrors_ExtractsCodeAndMethod_SkipsNoise() {
        let output = string.Join(
            "\n",
            "All Classes and Methods in /abs/App.dll Verified.",
            SampleErrorLine,
            "Error(s): 1"
        )
        let errors = IlVerifyRunner.ParseErrors(output)
        let error = Assert.Single(errors)
        Assert.Equal("StackUnexpected", error.Code)
        Assert.Equal("Program::Main(string[])", error.Method)
        Assert.Contains("Unexpected type on the stack.", error.RawLine)
    }

    /// An `ilverify-failure` artifact built from a parsed error carries the
    /// stage/category, a non-empty diagnostic id parsed from the line, labels
    /// `Oats` + `cil-emit`, and a stable `sha256:` fingerprint.
    @Fact
    func IlVerifyFailureArtifact_HasShapeAndCilEmitLabel() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let error = Assert.Single(IlVerifyRunner.ParseErrors(SampleErrorLine))
        let artifact = builder.IlVerifyFailure(error, "corpus_Sample/Sample.gs")
        let json = JsonSerializer.Serialize(artifact, TriageSerialization.Options)
        using let doc = JsonDocument.Parse(json)
        let root = doc.RootElement
        Assert.Equal("ilverify", root.GetProperty("stage").GetString())
        Assert.Equal("ilverify-failure", root.GetProperty("category").GetString())
        Assert.Equal("StackUnexpected", root.GetProperty("diagnostic").GetProperty("id").GetString())
        Assert.Equal("error", root.GetProperty("diagnostic").GetProperty("severity").GetString())
        Assert.False(string.IsNullOrEmpty(root.GetProperty("diagnostic").GetProperty("message").GetString()))
        Assert.Equal(
            "Program::Main(string[])",
            root.GetProperty("offendingCSharpConstruct").GetProperty("kind").GetString()
        )
        let labels = root
            .GetProperty("suggestedIssue")
            .GetProperty("labels")
            .EnumerateArray()
            .Select((e JsonElement) -> e.GetString()!!)
            .ToArray()
        Assert.Contains("Oats", labels)
        Assert.Contains("cil-emit", labels)
        Assert.StartsWith("sha256:", root.GetProperty("fingerprint").GetString(), StringComparison.Ordinal)
    }

    /// The fingerprint splits on distinct error code and on distinct failing
    /// method, so the pipeline produces one artifact per code + method skeleton.
    @Fact
    func IlVerifyFailure_Fingerprint_SplitsOnCodeAndMethod() {
        let builder = TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Sample")
        let a = builder.IlVerifyFailure(IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"))
        let sameAgain = builder.IlVerifyFailure(IlVerifyError("StackUnexpected", "Program::Main(string[])", "line a"))
        let differentCode = builder.IlVerifyFailure(IlVerifyError("ReturnVoid", "Program::Main(string[])", "line a"))
        let differentMethod = builder.IlVerifyFailure(
            IlVerifyError("StackUnexpected", "Program::Helper(int32)", "line a")
        )
        Assert.Equal(a.Fingerprint, sameAgain.Fingerprint)
        Assert.NotEqual(a.Fingerprint, differentCode.Fingerprint)
        Assert.NotEqual(a.Fingerprint, differentMethod.Fingerprint)
    }

    /// The documented ilverify 10.0.8 false positives — `ReturnPtrToStack`
    /// (by-value ref-struct returns) and the static-virtual
    /// `CallAbstract`/`Constrained` bundle (ADR-0089 / #755) — are
    /// declared in the ignore set and filtered out so they never yield artifacts,
    /// while a genuine error survives.
    @Fact
    func IgnoreBundle_FiltersKnownFalsePositives_KeepsRealErrors() {
        Assert.Contains("ReturnPtrToStack", IlVerifyRunner.KnownIlVerifyFalsePositives)
        Assert.Contains("CallAbstract", IlVerifyRunner.KnownIlVerifyFalsePositives)
        Assert.Contains("Constrained", IlVerifyRunner.KnownIlVerifyFalsePositives)
        let errors = []IlVerifyError{
            IlVerifyError("ReturnPtrToStack", "Acc::Add(Acc, int32)", "fp 1"),
            IlVerifyError("Constrained", "P::Sum<T>(T[])", "fp 2"),
            IlVerifyError("CallAbstract", "P::Sum<T>(T[])", "fp 3"),
            IlVerifyError(
                "StackUnexpected",
                "CompiledAvaloniaXaml.XamlIlContext+Context`1::get_ParentProvider()",
                "fp 4"
            ),
            IlVerifyError(
                "DelegateCtor",
                "Oahu.Core.UI.Avalonia.Views.AboutView::!XamlIlPopulate(System.IServiceProvider, AboutView)",
                "csc emits the same Avalonia-generated delegate construction"
            ),
            IlVerifyError("StackUnexpected", "P::Main(string[])", "real")
        }
        let filtered = IlVerifyRunner.FilterIgnored(errors)
        let surviving = Assert.Single(filtered)
        Assert.Equal("StackUnexpected", surviving.Code)
    }

    /// #2671: Avalonia XamlIl deliberately carries concrete controls in
    /// object-typed stack slots. Its generated XamlClosure Build methods run
    /// correctly, but ILVerify reports StackUnexpected just as it does for the
    /// existing generated XamlIlContext methods.
    @Fact
    func AvaloniaXamlClosureBuilds_FilterExactUiFingerprints_AndGeneralize() {
        const BookLibrary = "Oahu.Core.UI.Avalonia.Views.BookLibraryView+XamlClosure_1::Build_1([System.ComponentModel]System.IServiceProvider)"
        const Conversion = "Oahu.Core.UI.Avalonia.Views.ConversionView+XamlClosure_2::Build_1([System.ComponentModel]System.IServiceProvider)"
        let builder = TriageBuilder("run_1", "2026-07-21T00:00:00Z", "0.3.0", "corpus/Oahu.UI")
        let bookLibraryError = AvaloniaObjectSlotError(
            BookLibrary,
            "[System.ComponentModel.Primitives]System.ComponentModel.ISupportInitialize"
        )
        let conversionError = AvaloniaObjectSlotError(
            Conversion,
            "[System.ComponentModel.Primitives]System.ComponentModel.ISupportInitialize"
        )
        Assert.Equal(
            "sha256:9d0322446fc5a1cc4b78e2a66d5d83354b6e527fcd49d9f907fe63ccbb034a53",
            builder.IlVerifyFailure(IlVerifyError("StackUnexpected", BookLibrary, bookLibraryError)).Fingerprint
        )
        Assert.Equal(
            "sha256:94a053bb50ec2721c8600fe77dd02aa29a401f95bf174b39b459218f5dfea5a7",
            builder.IlVerifyFailure(IlVerifyError("StackUnexpected", Conversion, conversionError)).Fingerprint
        )
        let errors = []IlVerifyError{
            IlVerifyError("StackUnexpected", BookLibrary, bookLibraryError),
            IlVerifyError("StackUnexpected", Conversion, conversionError),
            IlVerifyError(
                "StackUnexpected",
                "Demo.View+XamlClosure_17::Build_42([System.ComponentModel]System.IServiceProvider)",
                AvaloniaObjectSlotError(
                    "Demo.View+XamlClosure_17::Build_42([System.ComponentModel]System.IServiceProvider)",
                    "Demo.Control"
                )
            ),
            IlVerifyError("StackUnexpected", "Demo.View+XamlClosure_1::CreateContext()", "real create"),
            IlVerifyError("StackUnexpected", "Demo.View+Closure_1::Build_1()", "real closure"),
            IlVerifyError("ReturnVoid", "Demo.View+XamlClosure_1::Build_1()", "real code"),
            IlVerifyError("StackUnexpected", BookLibrary, "[found value 'int32'][expected ref 'object']")
        }
        let filtered = IlVerifyRunner.FilterIgnored(errors)
        Assert.Equal(4, filtered.Count)
        Assert.Contains(
            filtered,
            (e IlVerifyError) -> e.Method!!.EndsWith("::CreateContext()", StringComparison.Ordinal)
        )
        Assert.Contains(filtered, (e IlVerifyError) -> e.Method!!.Contains("+Closure_1::", StringComparison.Ordinal))
        Assert.Contains(filtered, (e IlVerifyError) -> e.Code == "ReturnVoid")
        Assert.Contains(
            filtered,
            (e IlVerifyError) -> e.RawLine.Contains("found value 'int32'", StringComparison.Ordinal)
        )
    }

    /// Emits the upstream XamlIl stack shape rather than merely feeding mocked
    /// diagnostics to the filter: an object-typed local contains a concrete
    /// ISupportInitialize implementation and is called without a cast. Real
    /// ILVerify reports both exact Oahu Build fingerprints, while the CLR runs
    /// both methods and observes BeginInit/EndInit.
    @Fact
    func AvaloniaXamlClosureBuilds_RealIlVerifyAndRuntimeProof() {
        if !IlVerifyRunner.IsEnabled || !IlVerifyToolAvailable() {
            return
        }
        let directory = NewOutputRoot("issue2671-xaml-closure")
        let assemblyPath = Path.Combine(directory, "Oahu.UI.dll")
        EmitAvaloniaXamlClosureFixture(assemblyPath)
        try {
            let result = IlVerifyRunner().Verify(assemblyPath)
            Assert.True(result.Succeeded, result.Output)
            Assert.Empty(result.Errors)
            Assert.Contains("[StackUnexpected]", result.Output, StringComparison.Ordinal)
            Assert.Contains("BookLibraryView+XamlClosure_1::Build_1", result.Output, StringComparison.Ordinal)
            Assert.Contains("ConversionView+XamlClosure_2::Build_1", result.Output, StringComparison.Ordinal)
            let loadContext = AssemblyLoadContext("issue2671-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(assemblyPath)
                AssertClosureRan(assembly, "BookLibraryView+XamlClosure_1")
                AssertClosureRan(assembly, "ConversionView+XamlClosure_2")
            } finally {
                loadContext.Unload()
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// #1747 regression: exit 0 is always Passed, regardless of stray parsed
    /// error lines (the `-g` ignore flags + (cref:IlVerifyRunner.FilterIgnored)
    /// already handle known false positives upstream of this decision).
    @Fact
    func FromRun_ExitZero_IsPassed() {
        let result = IlVerifyResult.FromRun(0, "All Classes and Methods Verified.", Array.Empty[IlVerifyError]())
        Assert.Equal(IlVerifyStatus.Passed, result.Status)
        Assert.True(result.Succeeded)
    }

    /// #1747 regression: exit non-zero with real parsed error lines is Failed
    /// (unchanged behavior).
    @Fact
    func FromRun_NonZeroExitWithErrors_IsFailed() {
        let errors = []IlVerifyError{IlVerifyError("StackUnexpected", "P::Main(string[])", SampleErrorLine)}
        let result = IlVerifyResult.FromRun(2, SampleErrorLine, errors)
        Assert.Equal(IlVerifyStatus.Failed, result.Status)
        Assert.False(result.Succeeded)
    }

    /// #1747/#2748: a non-verifier exit is explicitly incomplete, never passed
    /// or treated as an ordinary verifier failure.
    @Fact
    func FromRun_NonZeroExitWithNoParseableErrors_IsIncomplete() {
        let result = IlVerifyResult.FromRun(134, "Segmentation fault (core dumped)", Array.Empty[IlVerifyError]())
        Assert.Equal(IlVerifyStatus.Incomplete, result.Status)
        Assert.False(result.Succeeded)
        Assert.Equal(134, result.ExitCode)
    }

    /// #2748: a crash before any finding is retried with the crashing member
    /// excluded, recovering findings from methods that follow it.
    @Fact
    func Verify_CrashBeforeFindings_RecoversPostCrashFinding() {
        let runner = ScriptedIlVerifyRunner(
            func (attempt int32, arguments IReadOnlyList[string])(Exit int32, Output string) {
                if attempt == 1 {
                    return (1, "Verifying [App]Program.Crash\nSystem.IndexOutOfRangeException")
                }
                Assert.Contains("--exclude", arguments)
                return (2, ErrorLine("PostCrash"))
            }
        )
        let assembly = FakeAssembly("crash-before-findings")
        let result = runner.Verify(assembly)
        Assert.Equal(IlVerifyStatus.Incomplete, result.Status)
        Assert.Equal("Program::PostCrash()", Assert.Single(result.Errors).Method)
        Assert.Equal("[App]Program.Crash", Assert.Single(result.IncompleteMembers))
        Assert.Equal(2, runner.Attempts)
        File.Delete(assembly)
    }

    /// #2748: findings printed before a crash and findings recovered after it
    /// are both retained without duplicating pre-crash output from the retry.
    @Fact
    func Verify_CrashAfterFinding_ReportsPreAndPostCrashFindings() {
        let runner = ScriptedIlVerifyRunner(
            func (attempt int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                let pre = ErrorLine("PreCrash")
                return if attempt == 1 {
                    (1, pre + `
Verifying [App]Program.Crash
System.IndexOutOfRangeException`)
                } else {
                    (2, pre + "\n" + ErrorLine("PostCrash"))
                }
            }
        )
        let assembly = FakeAssembly("crash-after-finding")
        let result = runner.Verify(assembly)
        Assert.Equal(IlVerifyStatus.Incomplete, result.Status)
        Assert.Equal(
            []string{"Program::PostCrash()", "Program::PreCrash()"},
            result.Errors.Select((e IlVerifyError) -> e.Method!!).OrderBy((method string) -> method).ToArray()
        )
        Assert.Contains("Verification incomplete", result.Output, StringComparison.Ordinal)
        File.Delete(assembly)
    }

    /// A zero-output abnormal exit remains explicitly incomplete.
    @Fact
    func Verify_ZeroOutputCrash_IsIncompleteWithoutInventedFinding() {
        let runner = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (134, string.Empty)
            }
        )
        let assembly = FakeAssembly("zero-output-crash")
        let result = runner.Verify(assembly)
        Assert.Equal(IlVerifyStatus.Incomplete, result.Status)
        Assert.Empty(result.Errors)
        Assert.Empty(result.IncompleteMembers)
        Assert.Equal(1, runner.Attempts)
        File.Delete(assembly)
    }

    /// An ordinary ilverify error exit remains a normal failure.
    @Fact
    func Verify_NormalVerifierFailure_IsFailedWithoutRecovery() {
        let runner = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (2, ErrorLine("Bad"))
            }
        )
        let assembly = FakeAssembly("normal-failure")
        let result = runner.Verify(assembly)
        Assert.Equal(IlVerifyStatus.Failed, result.Status)
        Assert.Single(result.Errors)
        Assert.Equal(1, runner.Attempts)
        File.Delete(assembly)
    }

    /// A clean ilverify exit remains passed.
    @Fact
    func Verify_NormalVerifierPass_IsPassedWithoutRecovery() {
        let runner = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (0, "All Classes and Methods Verified.")
            }
        )
        let assembly = FakeAssembly("normal-pass")
        let result = runner.Verify(assembly)
        Assert.Equal(IlVerifyStatus.Passed, result.Status)
        Assert.True(result.Succeeded)
        Assert.Equal(1, runner.Attempts)
        File.Delete(assembly)
    }

    /// #4489 review: exit 2 with every PARSED finding filtered passes only when
    /// the parsed lines account for ilverify's own "N Error(s)" summary. An
    /// unrecognized error line (here a metadata error) must keep the run red.
    @Fact
    func Verify_FilteredFindingPlusUnparseableError_IsNotPassed() {
        let filtered = "[IL]: Error [DelegateCtor]: [/abs/App.dll : Demo.View::!XamlIlPopulate(System.IServiceProvider, View)]" +
            "[offset 0x00000010] Delegate ctor."
        let assembly = FakeAssembly("unparseable-error")
        let complete = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (2, filtered + "\n1 Error(s) Verifying /abs/App.dll")
            }
        )
        Assert.Equal(IlVerifyStatus.Passed, complete.Verify(assembly).Status)
        let withUnparsed = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (2, filtered + `
[MD]: Error: Unrecognized metadata problem.
2 Error(s) Verifying /abs/App.dll`)
            }
        )
        let result = withUnparsed.Verify(assembly)
        Assert.False(result.Succeeded)
        let noSummary = ScriptedIlVerifyRunner(
            func (_ int32, _ IReadOnlyList[string])(Exit int32, Output string) {
                return (2, filtered)
            }
        )
        Assert.False(noSummary.Verify(assembly).Succeeded)
        File.Delete(assembly)
    }

    /// The stage emits recovered findings and a separate incompleteness
    /// artifact, so neither signal can hide the other.
    @Fact
    async func ExecuteAsync_ToolCrash_FailsStage_WithRecoveredAndIncompleteArtifacts() {
        let outRoot = NewOutputRoot("ilverify-tool-crash")
        let runner = IncompleteIlVerifyRunner()
        let stage = IlVerifyStage(runner)
        let fakeAssembly = Path.Combine(outRoot, "App.dll")
        File.WriteAllBytes(fakeAssembly, Array.Empty[uint8]())
        let app = CorpusApp("corpus/Fake", "/fake/Fake.csproj", TargetKind.Exe)
        let options = PipelineOptions{GscPath: "/fake/gsc.dll", OutputRoot: outRoot}
        let context = StageExecutionContext(
            app,
            options,
            GscInvoker(options.GscPath!!),
            outRoot,
            TriageBuilder("run_1", "2026-06-21T20:00:00Z", "0.2.0+abc", "corpus/Fake")
        ){EmittedAssemblyPath = fakeAssembly}
        let outcome = await stage.ExecuteAsync(context)
        Assert.Equal(StageStatus.Failed, outcome.Status)
        Assert.Equal(2, outcome.Artifacts.Count)
        Assert.Contains(outcome.Artifacts, (artifact TriageArtifact) -> artifact.Diagnostic!!.Id == "StackUnexpected")
        let incomplete = Assert.Single(
            outcome.Artifacts,
            (artifact TriageArtifact) -> artifact.Diagnostic!!.Id == "IlVerifyIncomplete"
        )
        Assert.Contains("Verification incomplete", incomplete.Diagnostic!!.Message, StringComparison.Ordinal)
        Assert.Contains("[App]Program.Crash", incomplete.Diagnostic!!.Message, StringComparison.Ordinal)
    }

    private class IncompleteIlVerifyRunner : IlVerifyRunner {
        override func Verify(
            assemblyPath string,
            additionalReferences IReadOnlyList[string]? = nil
        ) IlVerifyResult -> IlVerifyResult
            .Incomplete(
            1,
            "System.IndexOutOfRangeException",
            []IlVerifyError{
                IlVerifyError("StackUnexpected", "Program::Recovered()", IlVerifyStageTests.ErrorLine("Recovered"))
            },
            []string{"[App]Program.Crash"}
        )
    }

    private class ScriptedIlVerifyRunner : IlVerifyRunner {
        private let run(int32, IReadOnlyList[string]) -> (Exit int32, Output string)

        init(run(int32, IReadOnlyList[string]) -> (Exit int32, Output string)) {
            this.run = run
        }

        prop Attempts int32 {
            get;
            private set;
        }

        override func EnsureToolAvailable() bool -> true

        protected override func RunDotnet(arguments IReadOnlyList[string])(Exit int32, Output string) {
            this.Attempts++
            return this.run(this.Attempts, arguments)
        }
    }

    /// Running the pipeline over `corpus/L1-Console` passes stage 3
    /// (`ilverify`) cleanly with zero artifacts: all three stages green and
    /// the stage list now has three entries. Gated on the compiler artifact and
    /// the ilverify tool being present.
    @Fact
    async func L1_StageThree_IsGreen_WithZeroArtifacts() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("l1-ilverify-green")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let l1 = CorpusDiscovery.FindById(corpus, "corpus/L1-Console")!!
        Assert.NotNull(l1)
        let result = await pipeline.RunAsync([]CorpusApp{l1})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "L1 must migrate green through stage 3 (ilverify). Failure category: " +
                (app.FailureCategory ?? "<none>") +
                "; artifacts: " +
                string.Join(", ", app.Artifacts)
        )
        Assert.Empty(app.Artifacts)
        Assert.Equal(4, app.Stages.Count)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
        Assert.Equal("ilverify", app.Stages[2].Stage)
    }

    shared {
        private const SampleErrorLine string = "[IL]: Error [StackUnexpected]: [/abs/App.dll : Program::Main(string[])]" +
            "[offset 0x00000001] Unexpected type on the stack."

        private func IlVerifyToolAvailable() bool {
            if !IlVerifyRunner.IsEnabled {
                // GSHARP_SKIP_ILVERIFY=1: the stage no-ops to PASS, so the green
                // assertion still holds.
                return true
            }
            try {
                return IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FakeAssembly(label string) string {
            let path = Path.Combine(NewOutputRoot(label), "App.dll")
            File.WriteAllBytes(path, Array.Empty[uint8]())
            return path
        }

        private func ErrorLine(method string) string -> "[IL]: Error [StackUnexpected]: [/abs/App.dll : Program::" +
            method +
            "()][offset 0x00000001] Unexpected type on the stack."

        private func EmitAvaloniaXamlClosureFixture(path string) {
            let assembly = PersistedAssemblyBuilder(
                AssemblyName("Oahu.UI." + Guid.NewGuid().ToString("N")),
                typeof(object).Assembly
            )
            let module = assembly.DefineDynamicModule("Oahu.UI")
            let control = module.DefineType("Oahu.Core.UI.Avalonia.Views.GeneratedControl", TypeAttributes.Public)
            control.AddInterfaceImplementation(typeof(ISupportInitialize))
            let beginCalled = control.DefineField("BeginCalled", typeof(bool), FieldAttributes.Public)
            let endCalled = control.DefineField("EndCalled", typeof(bool), FieldAttributes.Public)
            let constructor = control.DefineDefaultConstructor(MethodAttributes.Public)
            DefineInitMethod(control, beginCalled, "BeginInit")
            DefineInitMethod(control, endCalled, "EndInit")
            DefineClosure(module, control, constructor, "BookLibraryView", "XamlClosure_1")
            DefineClosure(module, control, constructor, "ConversionView", "XamlClosure_2")
            control.CreateType()
            assembly.Save(path)
        }

        private func DefineInitMethod(control TypeBuilder, field FieldBuilder, name string) {
            let method = control.DefineMethod(
                name,
                MethodAttributes.Public | MethodAttributes.Virtual,
                typeof(Void),
                Type.EmptyTypes
            )
            let il = method.GetILGenerator()
            il.Emit(OpCodes.Ldarg_0)
            il.Emit(OpCodes.Ldc_I4_1)
            il.Emit(OpCodes.Stfld, field)
            il.Emit(OpCodes.Ret)
            control.DefineMethodOverride(method, typeof(ISupportInitialize).GetMethod(name)!!)
        }

        private func DefineClosure(
            module ModuleBuilder,
            control TypeBuilder,
            constructor ConstructorBuilder,
            viewName string,
            closureName string
        ) {
            let view = module.DefineType("Oahu.Core.UI.Avalonia.Views." + viewName, TypeAttributes.Public)
            let closure = view.DefineNestedType(
                closureName,
                TypeAttributes.NestedPublic | TypeAttributes.Abstract | TypeAttributes.Sealed
            )
            let build = closure.DefineMethod(
                "Build_1",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(object),
                []Type{typeof(IServiceProvider)}
            )
            let il = build.GetILGenerator()
            let root = il.DeclareLocal(typeof(object))
            il.Emit(OpCodes.Newobj, constructor)
            il.Emit(OpCodes.Stloc, root)
            il.Emit(OpCodes.Ldloc, root)
            il.Emit(OpCodes.Callvirt, typeof(ISupportInitialize).GetMethod("BeginInit")!!)
            il.Emit(OpCodes.Ldloc, root)
            il.Emit(OpCodes.Callvirt, typeof(ISupportInitialize).GetMethod("EndInit")!!)
            il.Emit(OpCodes.Ldloc, root)
            il.Emit(OpCodes.Ret)
            closure.CreateType()
            view.CreateType()
        }

        private func AssertClosureRan(assembly Assembly, typeName string) {
            let closure = assembly.GetType("Oahu.Core.UI.Avalonia.Views." + typeName)!!
            let result = closure.GetMethod("Build_1")!!.Invoke(nil, []object? {nil})!!
            Assert.True(bool(result.GetType().GetField("BeginCalled")!!.GetValue(result)!!))
            Assert.True(bool(result.GetType().GetField("EndCalled")!!.GetValue(result)!!))
        }

        private func AvaloniaObjectSlotError(
            method string,
            expected string
        ) string -> "[IL]: Error [StackUnexpected]: [/proof/Oahu.UI.dll : $method]" +
            "[offset 0x0000001B][found ref 'object'][expected ref '$expected'] Unexpected type on the stack."

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        private func ResolveCorpusDir() string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
    }
}
