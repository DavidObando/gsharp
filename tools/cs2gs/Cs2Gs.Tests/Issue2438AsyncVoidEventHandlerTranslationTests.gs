// <copyright file="Issue2438AsyncVoidEventHandlerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Regression tests for issue #2438 (Oahu `AudibleClient.SettingsChangedSettings`
/// / `AudibleApi.AaxFileConversionProgressUpdate`): a genuine C# `async
/// void` handler (instance/static method, local function, or lambda)
/// subscribed via method group to `EventHandler`/`EventHandler<T>`/a
/// custom void delegate.
///
/// cs2gs translates the exact Roslyn `IsAsync && ReturnsVoid`
/// shape directly to G# `async func ... void`, preserving the original
/// callable identity and delegating timing, exception propagation, and
/// synchronization-context behavior to the CLR's
/// `AsyncVoidMethodBuilder`.
///
/// Ordinary Task-returning methods and lambdas remain Task-observable; the
/// negative controls confirm they are never treated as void callables.
open class Issue2438AsyncVoidEventHandlerTranslationTests {
    // ---------------------------------------------------------------
    // Structural translation tests
    // ---------------------------------------------------------------
    /// The exact Oahu `AudibleClient.SettingsChangedSettings` shape: a
    /// private, expression-bodied `async void` INSTANCE method subscribed
    /// to a plain `EventHandler` via method group in the constructor.
    @Fact
    func InstanceMethod_AudibleClientShape_TranslatesToNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class Authorize
    {
        public event EventHandler SettingsChanged;

        public Task WriteConfigurationAsync() => Task.CompletedTask;

        public void Raise() => SettingsChanged?.Invoke(this, EventArgs.Empty);
    }

    public sealed class AudibleClient
    {
        private readonly Authorize Authorize = new Authorize();

        public AudibleClient()
        {
            Authorize.SettingsChanged += SettingsChangedSettings;
        }

        private async void SettingsChangedSettings(object sender, EventArgs e) => await Authorize.WriteConfigurationAsync();
    }
}`)
        Assert.Contains("async func SettingsChangedSettings", printed, StringComparison.Ordinal)
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__asyncVoid_", printed, StringComparison.Ordinal)
        // `+=` still subscribes by the SAME method name — identity preserved.
        Assert.Contains("SettingsChanged += SettingsChangedSettings", printed, StringComparison.Ordinal)
    }

    @Fact
    func GenericInstanceMethod_PreservesTypeParametersOnNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System.Threading.Tasks;

namespace Demo
{
    public sealed class Handler
    {
        public async void Handle<T>(T value)
        {
            await Task.Yield();
        }
    }
}`)
        Assert.Contains("async func Handle[T](value T) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__asyncVoid_", printed, StringComparison.Ordinal)
    }

    /// The exact Oahu `AudibleApi.AaxFileConversionProgressUpdate` shape: a
    /// block-bodied `async void` LOCAL FUNCTION subscribed to a generic
    /// `EventHandler<T>` via method group.
    @Fact
    func LocalFunction_AaxFileConversionProgressUpdateShape_TranslatesToNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class ConversionProgressEventArgs : EventArgs
    {
        public int Percent { get; set; }
    }

    public sealed class Converter
    {
        public event EventHandler<ConversionProgressEventArgs> Progress;

        public Task ReportAsync(int percent) => Task.CompletedTask;

        public void Raise(int percent) => Progress?.Invoke(this, new ConversionProgressEventArgs { Percent = percent });
    }

    public sealed class AudibleApi
    {
        public void ConvertFile(Converter converter)
        {
            async void AaxFileConversionProgressUpdate(object sender, ConversionProgressEventArgs e)
            {
                await converter.ReportAsync(e.Percent);
            }

            converter.Progress += AaxFileConversionProgressUpdate;
            converter.Progress -= AaxFileConversionProgressUpdate;
        }
    }
}`)
        Assert.Contains("let AaxFileConversionProgressUpdate = async func", printed, StringComparison.Ordinal)
        Assert.Contains("ConversionProgressEventArgs) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
        // Both `+=` and `-=` reference the exact same identifier — the SAME
        // `let`-bound function value, so unsubscription is delegate-equal to
        // the earlier subscription.
        Assert.Contains("Progress += AaxFileConversionProgressUpdate", printed, StringComparison.Ordinal)
        Assert.Contains("Progress -= AaxFileConversionProgressUpdate", printed, StringComparison.Ordinal)
    }

    /// An async lambda assigned DIRECTLY to a plain `EventHandler`-typed
    /// field/variable is Roslyn's async-void shape for a LAMBDA (its inferred
    /// `IMethodSymbol.ReturnsVoid` comes from the converted `EventHandler
    /// .Invoke` target, not from a `Task` of its own) and needs the same
    /// rewrite.
    @Fact
    func Lambda_AsyncVoidTargetingEventHandler_TranslatesToNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public EventHandler Handler = async (sender, e) => await Task.Delay(1);
    }
}`)
        Assert.Contains("async func (sender", printed, StringComparison.Ordinal)
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
    }

    /// An async lambda targeting a CUSTOM void delegate type (not one of the
    /// BCL `EventHandler` family) must be rewritten identically — the
    /// predicate is purely `IsAsync && ReturnsVoid`, independent of the
    /// specific delegate type.
    @Fact
    func Lambda_AsyncVoidTargetingCustomVoidDelegate_TranslatesToNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public delegate void Notify(int code);

    public sealed class C
    {
        public Notify OnNotify = async code =>
        {
            await Task.Delay(1);
        };
    }
}`)
        Assert.Contains("async func (code int32) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
    }

    /// A STATIC `async void` method subscribed via method group must be
    /// rewritten identically to an instance method.
    @Fact
    func StaticMethod_AsyncVoid_TranslatesToNativeAsyncVoid() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public event EventHandler Changed;

        public void Subscribe() => Changed += OnChanged;

        private static async void OnChanged(object sender, EventArgs e)
        {
            await Task.Delay(1);
        }
    }
}`)
        Assert.Contains("async func OnChanged", printed, StringComparison.Ordinal)
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
    }

    /// A LAMBDA capturing an outer local (issue's "captures" scenario) must
    /// preserve the capture in the native async-void function literal.
    @Fact
    func Lambda_CapturingOuterLocal_PreservesCapture() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public void Wire(int seed)
        {
            EventHandler h = async (sender, e) =>
            {
                await Task.Delay(1);
                Console.WriteLine(seed);
            };
        }
    }
}`)
        Assert.Contains("async func (sender", printed, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(seed)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal)
    }

    // ---------------------------------------------------------------
    // Negative controls: cs2gs must NOT globally loosen Task -> void
    // ---------------------------------------------------------------
    /// An ordinary `async Task` instance method (NOT `async void`) is
    /// untouched: it keeps its Task-observable `async func` shape.
    @Fact
    func NegativeControl_AsyncTaskMethod_TranslationUnaffected() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task Handle(object sender, EventArgs e)
        {
            await Task.Delay(1);
        }
    }
}`)
        Assert.Contains("async func Handle", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoidBody", printed, StringComparison.Ordinal)
    }

    /// An async lambda targeting `Func<Task>` (an ordinary awaited
    /// async value, not a void delegate) is untouched.
    @Fact
    func NegativeControl_AsyncLambdaTargetingFuncOfTask_TranslationUnaffected() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public Func<Task> Work = async () => await Task.Delay(1);
    }
}`)
        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__gsAsyncVoidBody", printed, StringComparison.Ordinal)
    }

    @Fact
    func AsyncExpressionLambda_WithVoidAwait_UsesStatementBody() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class WorkItem
    {
        public WorkItem(Func<ValueTask> body) { }
    }

    public sealed class C
    {
        public WorkItem Build() => new WorkItem(async () => await Task.Yield());
    }
}`)
        Assert.Contains("await Task.Yield()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("return await Task.Yield()", printed, StringComparison.Ordinal)
    }

    /// A direct Task-returning method-group VALUE (assigned to a
    /// `Func<object, EventArgs, Task>`-shaped variable, never a void
    /// delegate) must remain an ordinary async method-group reference —
    /// confirms the rewrite is keyed on the DECLARATION's own
    /// `IsAsync && ReturnsVoid`, not on how a caller happens to use it.
    @Fact
    func NegativeControl_AsyncTaskMethodGroupValue_TranslationUnaffected() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task Handle(object sender, EventArgs e)
        {
            await Task.Delay(1);
        }

        public Func<object, EventArgs, Task> Capture() => Handle;
    }
}`)
        Assert.Contains("async func Handle", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal)
        Assert.Contains("-> Handle", printed, StringComparison.Ordinal)
    }

    /// The critical negative control the issue calls out explicitly: an
    /// ordinary async G# method with no explicit return type
    /// (`async func Handle(...) { ... }`) is still Task-observable and
    /// must fail to compile when subscribed to a void event delegate. Native
    /// async void requires the explicit `void` return clause. This is
    /// deliberately raw G# (bypassing cs2gs
    /// entirely, since real C# has no valid source that would even reach
    /// cs2gs with this shape: `EventHandler h = anAsyncTaskMethod;` is
    /// already a C# CS0407 error before translation) — it locks in that gsc
    /// itself never globally discards an arbitrary Task to make this
    /// conversion succeed.
    @Fact
    func NegativeControl_AsyncFuncMethodGroupToVoidDelegate_StillFailsGsc() {
        const source = `package Demo

import System
import System.Threading.Tasks

class C {
    event Changed (object?, EventArgs) -> void

    func Subscribe() {
        Changed += Handle
    }

    async func Handle(sender object, e EventArgs) {
        await Task.Delay(1)
    }
}
`
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-negctrl", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Snippet.gs")
        let dllPath = Path.Combine(workDir, "Snippet.dll")
        File.WriteAllText(gsPath, source)
        let (exit, output) = RunDotnet("\"$compiler\" /target:library /out:\"$dllPath\" \"$gsPath\"")
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0155", output, StringComparison.Ordinal)
    }

    // ---------------------------------------------------------------
    // Full compile+run behavioral tests
    // ---------------------------------------------------------------
    /// The exact Oahu `AudibleClient` shape end-to-end: subscribes,
    /// fires, and lets the non-faulting async body run to completion. Proves
    /// (a) the native async-void handler compiles and (b) the call returns
    /// synchronously (proving fire-and-forget dispatch) while the awaited
    /// continuation still completes normally (proving no swallowed/broken
    /// await).
    @Fact
    func E2e_AudibleClientShape_FiresAndCompletesWithoutError() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class Authorize
    {
        public event EventHandler SettingsChanged;
        private readonly TaskCompletionSource<bool> completion = new TaskCompletionSource<bool>();

        public async Task WriteConfigurationAsync()
        {
            await completion.Task;
            Console.WriteLine("wrote-configuration");
        }

        public void Raise() => SettingsChanged?.Invoke(this, EventArgs.Empty);
        public void Complete() => completion.SetResult(true);
    }

    public sealed class AudibleClient
    {
        public readonly Authorize Authorize = new Authorize();

        public AudibleClient()
        {
            Authorize.SettingsChanged += SettingsChangedSettings;
        }

        private async void SettingsChangedSettings(object sender, EventArgs e) => await Authorize.WriteConfigurationAsync();

        public void Fire()
        {
            Authorize.Raise();
            Console.WriteLine("fire-returned");
            Authorize.Complete();
            Thread.Sleep(300);
        }
    }
}`)
        let stdout = CompileAndRun(printed, "AudibleClient().Fire()")
        let lines = stdout.Trim().Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
        )
        // `Fire` returns (and prints "fire-returned") BEFORE the awaited
        // continuation inside the handler completes (proves the handler call
        // itself is synchronous/void, matching real async-void dispatch).
        Assert.Equal("fire-returned", lines[0])
        Assert.Contains("wrote-configuration", lines)
    }

    /// Attaches a recording (cref:SynchronizationContext) before firing
    /// a faulting async-void handler: the unhandled exception must be posted
    /// through THAT context (and only observed once the posted callback is
    /// actually pumped) rather than crashing the process or being silently
    /// dropped.
    /// @remarks The recording (cref:SynchronizationContext) subclass is compiled
    /// as a SEPARATE, ordinary C# helper assembly ((cref:CompileSupportAssembly))
    /// and referenced by the translated snippet, rather than being defined
    /// inline in the C# source under translation. G# has no support for
    /// overriding a virtual method of an EXTERNAL (BCL/metadata) base class
    /// (confirmed independently: `structSymbol.BaseClass` is only
    /// populated for G#-authored base types, so overriding e.g.
    /// `SynchronizationContext.Post` directly in G#/cs2gs-translated
    /// source silently drops the `override` modifier and produces a
    /// non-virtual SHADOWING method — calls through a base-typed reference then
    /// dispatch to the BCL base implementation instead, which is an unrelated,
    /// pre-existing gsc/Core limitation, not a defect in this issue's fix). Using
    /// a pre-compiled reference assembly for the subclass sidesteps that gap
    /// entirely (exactly how real Oahu code would consume a helper type from
    /// another already-compiled assembly) while still exercising the actual
    /// translated `OnTick` handler end-to-end against a real captured
    /// (cref:SynchronizationContext).
    @Fact
    func E2e_FaultingHandler_WithSynchronizationContext_PostsExceptionInsteadOfCrashing() {
        // NOTE: `Post` only RECORDS — it does not invoke the callback. A real
        // ambient `SynchronizationContext` is normally serviced by a message
        // pump (WinForms/WPF/ASP.NET classic) that keeps invoking posted work
        // as it arrives; the .NET async/await machinery ITSELF posts through
        // the very same context to resume any `await`ed continuation, so a
        // naive "invoke each posted callback with a `null` state" pump breaks
        // as soon as the framework (not just our own fault-continuation) also
        // posts through this context. `PumpAndCaptureFirstException` below
        // pairs each callback with its OWN captured state and drains the list
        // (including entries added DURING pumping, e.g. the exception-post
        // that only happens once the delay's resume-post above is pumped).
        let supportDll = CompileSupportAssembly(`
using System;
using System.Collections.Generic;
using System.Threading;

namespace Issue2438Support
{
    public sealed class RecordingSyncContext : SynchronizationContext
    {
        private readonly List<(SendOrPostCallback Callback, object State)> posted =
            new List<(SendOrPostCallback, object)>();

        public int PostedCount => posted.Count;

        public override void Post(SendOrPostCallback d, object state)
        {
            posted.Add((d, state));
        }

        public string PumpAndCaptureFirstException()
        {
            string firstMessage = null;
            for (int i = 0; i < posted.Count; i++)
            {
                (SendOrPostCallback callback, object state) = posted[i];
                try
                {
                    callback(state);
                }
                catch (Exception ex)
                {
                    firstMessage ??= ex.Message;
                }
            }

            return firstMessage;
        }
    }
}`, "Issue2438Support")
        let printed = TranslateAndValidate(`
using System;
using System.Threading;
using System.Threading.Tasks;
using Issue2438Support;

namespace Demo
{
    public sealed class Worker
    {
        public event EventHandler Done;

        private async void OnTick(object sender, EventArgs e)
        {
            await Task.Delay(1);
            throw new InvalidOperationException("boom");
        }

        public void Fire()
        {
            Done += OnTick;
            Done(this, EventArgs.Empty);
        }
    }

    public static class Driver
    {
        public static void Run()
        {
            var ctx = new RecordingSyncContext();
            SynchronizationContext.SetSynchronizationContext(ctx);

            new Worker().Fire();
            Thread.Sleep(300);

            Console.WriteLine("posted:" + ctx.PostedCount);
            string caught = ctx.PumpAndCaptureFirstException();
            if (caught != null)
            {
                Console.WriteLine("caught:" + caught);
            }
        }
    }
}`, []PortableExecutableReference{MetadataReference.CreateFromFile(supportDll)})
        let stdout = CompileAndRun(printed, "Driver.Run()", []string{supportDll})
        Assert.Contains("posted:1", stdout)
        Assert.Contains("caught:boom", stdout)
    }

    /// With NO ambient (cref:SynchronizationContext) (the common
    /// console-app default), the same faulting handler must still surface its
    /// exception rather than swallow it — matching real C# async-void, which
    /// crashes the process on an unhandled exception with no context to post
    /// to.
    @Fact
    func E2e_FaultingHandler_WithoutSynchronizationContext_CrashesInsteadOfSwallowing() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class Worker
    {
        public event EventHandler Done;

        private async void OnTick(object sender, EventArgs e)
        {
            await Task.Delay(1);
            throw new InvalidOperationException("boom");
        }

        public void Fire()
        {
            Done += OnTick;
            Done(this, EventArgs.Empty);
        }
    }

    public static class Driver
    {
        public static void Run()
        {
            new Worker().Fire();
            Console.WriteLine("fire-returned");
            Thread.Sleep(500);
            Console.WriteLine("should-not-reach-here");
        }
    }
}`)
        let (stdout, exitCode) = CompileAndRunAllowFailure(printed, "Driver.Run()")
        Assert.Contains("fire-returned", stdout)
        Assert.NotEqual(0, exitCode)
        Assert.DoesNotContain("should-not-reach-here", stdout)
    }

    /// Two handlers subscribed to the same event, then ONE unsubscribed by
    /// name via `-=`: only the still-subscribed handler must fire on the
    /// second raise — proves the native method preserves delegate identity
    /// across `+=`/`-=` (the local-function/lambda `let` binding and
    /// the method-group name both resolve to the identical function value each
    /// time they're referenced).
    @Fact
    func E2e_MultipleSubscribeThenUnsubscribeByName_OnlyRemainingHandlerFires() {
        let printed = TranslateAndValidate(`
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class Publisher
    {
        public event EventHandler Ping;

        public void Raise() => Ping?.Invoke(this, EventArgs.Empty);
    }

    public static class Driver
    {
        private static async void First(object sender, EventArgs e)
        {
            await Task.Delay(1);
            Console.WriteLine("first");
        }

        private static async void Second(object sender, EventArgs e)
        {
            await Task.Delay(1);
            Console.WriteLine("second");
        }

        public static void Run()
        {
            var publisher = new Publisher();
            publisher.Ping += First;
            publisher.Ping += Second;

            publisher.Raise();
            Thread.Sleep(200);

            publisher.Ping -= First;
            publisher.Raise();
            Thread.Sleep(200);
        }
    }
}`)
        let stdout = CompileAndRun(printed, "Driver.Run()")
        let firstCount = Regex.Matches(stdout, "first").Count
        let secondCount = Regex.Matches(stdout, "second").Count
        // `First` fired only on the FIRST raise (before it was unsubscribed);
        // `Second` fired on both raises.
        Assert.Equal(1, firstCount)
        Assert.Equal(2, secondCount)
    }

    shared {
        // ---------------------------------------------------------------
        // Shared helpers (pattern established by Issue1732LoopLoweringTranslationTests
        // / Issue2434DelegateNullableInterfaceWideningTranslationTests)
        // ---------------------------------------------------------------
        private func TranslateAndValidate(
            source string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) string {
            let references IReadOnlyList[MetadataReference]? = if extraReferences == nil {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if extraReferences == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(
                    printed,
                    "Consumer fixture omits the referenced support assembly from emitted G#; CompileAndRun binds it below."
                )
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Compiles [`source`](paramref) as an ordinary (non-translated) C#
        /// class-library assembly using Roslyn directly, so its members retain
        /// REAL CLR override/virtual-dispatch semantics. Used by tests that need a
        /// helper type (e.g. a (cref:SynchronizationContext) subclass) which
        /// itself is NOT the thing under test — see the remarks on
        /// (cref:E2e_FaultingHandler_WithSynchronizationContext_PostsExceptionInsteadOfCrashing)
        /// for why such helper types must be pre-compiled rather than routed
        /// through cs2gs/gsc.
        private func CompileSupportAssembly(source string, assemblyName string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Support.cs", source)},
                references: nil,
                assemblyName: assemblyName,
                outputKind: OutputKind.DynamicallyLinkedLibrary
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Support assembly should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let dllPath = Path.Combine(workDir, assemblyName + ".dll")
            {
                using let stream = File.Create(dllPath)
                let emitResult = project.Compilation.Emit(stream)
                Assert.True(
                    emitResult.Success,
                    "Support assembly must emit with zero errors: " + string.Join(
                        Environment.NewLine,
                        emitResult.Diagnostics
                    )
                )
            }
            return dllPath
        }

        private func CompileAndRun(
            printed string,
            callExpression string,
            extraReferenceDlls IReadOnlyList[string]? = nil
        ) string {
            let (stdout, exitCode) = CompileAndRunAllowFailure(printed, callExpression, extraReferenceDlls)
            Assert.True(exitCode == 0, "Translated snippet must run successfully. Output:\n" + stdout)
            return stdout
        }

        private func CompileAndRunAllowFailure(
            printed string,
            callExpression string,
            extraReferenceDlls IReadOnlyList[string]? = nil
        )(Stdout string, ExitCode int32) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let referenceArgs = StringBuilder()
            if extraReferenceDlls != nil {
                for referenceDll in extraReferenceDlls {
                    // The compiled snippet is later invoked as a standalone
                    // process (`dotnet Snippet.dll`); the CLR probes for
                    // references next to the entry assembly, so any referenced
                    // helper assembly must be copied alongside it.
                    let copiedPath = Path.Combine(workDir, Path.GetFileName(referenceDll))
                    File.Copy(referenceDll, copiedPath, overwrite: true)
                    referenceArgs.Append(" /r:\"").Append(referenceDll).Append('"')
                }
            }
            let (compileExit, compileOut) = RunDotnet(
                "\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"$referenceArgs"
            )
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            return (stdout, runExit)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

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
    }
}
