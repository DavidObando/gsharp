// <copyright file="Issue2438AsyncVoidEventHandlerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2438 (Oahu <c>AudibleClient.SettingsChangedSettings</c>
/// / <c>AudibleApi.AaxFileConversionProgressUpdate</c>): a genuine C# <c>async
/// void</c> handler (instance/static method, local function, or lambda)
/// subscribed via method group to <c>EventHandler</c>/<c>EventHandler&lt;T&gt;</c>/a
/// custom void delegate.
/// <para>
/// cs2gs translates the exact Roslyn <c>IsAsync &amp;&amp; ReturnsVoid</c>
/// shape directly to G# <c>async func ... void</c>, preserving the original
/// callable identity and delegating timing, exception propagation, and
/// synchronization-context behavior to the CLR's
/// <c>AsyncVoidMethodBuilder</c>.
/// </para>
/// <para>
/// Ordinary Task-returning methods and lambdas remain Task-observable; the
/// negative controls confirm they are never treated as void callables.
/// </para>
/// </summary>
public class Issue2438AsyncVoidEventHandlerTranslationTests
{
    // ---------------------------------------------------------------
    // Structural translation tests
    // ---------------------------------------------------------------

    /// <summary>
    /// The exact Oahu <c>AudibleClient.SettingsChangedSettings</c> shape: a
    /// private, expression-bodied <c>async void</c> INSTANCE method subscribed
    /// to a plain <c>EventHandler</c> via method group in the constructor.
    /// </summary>
    [Fact]
    public void InstanceMethod_AudibleClientShape_TranslatesToNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func SettingsChangedSettings", printed, StringComparison.Ordinal);
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__asyncVoid_", printed, StringComparison.Ordinal);

        // `+=` still subscribes by the SAME method name — identity preserved.
        Assert.Contains("SettingsChanged += SettingsChangedSettings", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericInstanceMethod_PreservesTypeParametersOnNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func Handle[T](value T) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__asyncVoid_", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The exact Oahu <c>AudibleApi.AaxFileConversionProgressUpdate</c> shape: a
    /// block-bodied <c>async void</c> LOCAL FUNCTION subscribed to a generic
    /// <c>EventHandler&lt;T&gt;</c> via method group.
    /// </summary>
    [Fact]
    public void LocalFunction_AaxFileConversionProgressUpdateShape_TranslatesToNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("let AaxFileConversionProgressUpdate = async func", printed, StringComparison.Ordinal);
        Assert.Contains("ConversionProgressEventArgs) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);

        // Both `+=` and `-=` reference the exact same identifier — the SAME
        // `let`-bound function value, so unsubscription is delegate-equal to
        // the earlier subscription.
        Assert.Contains("Progress += AaxFileConversionProgressUpdate", printed, StringComparison.Ordinal);
        Assert.Contains("Progress -= AaxFileConversionProgressUpdate", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An async lambda assigned DIRECTLY to a plain <c>EventHandler</c>-typed
    /// field/variable is Roslyn's async-void shape for a LAMBDA (its inferred
    /// <c>IMethodSymbol.ReturnsVoid</c> comes from the converted <c>EventHandler
    /// .Invoke</c> target, not from a <c>Task</c> of its own) and needs the same
    /// rewrite.
    /// </summary>
    [Fact]
    public void Lambda_AsyncVoidTargetingEventHandler_TranslatesToNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public EventHandler Handler = async (sender, e) => await Task.Delay(1);
    }
}");

        Assert.Contains("async func (sender", printed, StringComparison.Ordinal);
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An async lambda targeting a CUSTOM void delegate type (not one of the
    /// BCL <c>EventHandler</c> family) must be rewritten identically — the
    /// predicate is purely <c>IsAsync &amp;&amp; ReturnsVoid</c>, independent of the
    /// specific delegate type.
    /// </summary>
    [Fact]
    public void Lambda_AsyncVoidTargetingCustomVoidDelegate_TranslatesToNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func (code int32) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A STATIC <c>async void</c> method subscribed via method group must be
    /// rewritten identically to an instance method.
    /// </summary>
    [Fact]
    public void StaticMethod_AsyncVoid_TranslatesToNativeAsyncVoid()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func OnChanged", printed, StringComparison.Ordinal);
        Assert.Contains("EventArgs) void", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A LAMBDA capturing an outer local (issue's "captures" scenario) must
    /// preserve the capture in the native async-void function literal.
    /// </summary>
    [Fact]
    public void Lambda_CapturingOuterLocal_PreservesCapture()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func (sender", printed, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(seed)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoid", printed, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------
    // Negative controls: cs2gs must NOT globally loosen Task -> void
    // ---------------------------------------------------------------

    /// <summary>
    /// An ordinary <c>async Task</c> instance method (NOT <c>async void</c>) is
    /// untouched: it keeps its Task-observable <c>async func</c> shape.
    /// </summary>
    [Fact]
    public void NegativeControl_AsyncTaskMethod_TranslationUnaffected()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func Handle", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoidBody", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An async lambda targeting <c>Func&lt;Task&gt;</c> (an ordinary awaited
    /// async value, not a void delegate) is untouched.
    /// </summary>
    [Fact]
    public void NegativeControl_AsyncLambdaTargetingFuncOfTask_TranslationUnaffected()
    {
        string printed = TranslateAndValidate(@"
using System;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public Func<Task> Work = async () => await Task.Delay(1);
    }
}");

        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__gsAsyncVoidBody", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A direct Task-returning method-group VALUE (assigned to a
    /// <c>Func&lt;object, EventArgs, Task&gt;</c>-shaped variable, never a void
    /// delegate) must remain an ordinary async method-group reference —
    /// confirms the rewrite is keyed on the DECLARATION's own
    /// <c>IsAsync &amp;&amp; ReturnsVoid</c>, not on how a caller happens to use it.
    /// </summary>
    [Fact]
    public void NegativeControl_AsyncTaskMethodGroupValue_TranslationUnaffected()
    {
        string printed = TranslateAndValidate(@"
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
}");

        Assert.Contains("async func Handle", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ContinueWith", printed, StringComparison.Ordinal);
        Assert.Contains("-> Handle", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The critical negative control the issue calls out explicitly: an
    /// ordinary async G# method with no explicit return type
    /// (<c>async func Handle(...) { ... }</c>) is still Task-observable and
    /// must fail to compile when subscribed to a void event delegate. Native
    /// async void requires the explicit <c>void</c> return clause. This is
    /// deliberately raw G# (bypassing cs2gs
    /// entirely, since real C# has no valid source that would even reach
    /// cs2gs with this shape: `EventHandler h = anAsyncTaskMethod;` is
    /// already a C# CS0407 error before translation) — it locks in that gsc
    /// itself never globally discards an arbitrary Task to make this
    /// conversion succeed.
    /// </summary>
    [Fact]
    public void NegativeControl_AsyncFuncMethodGroupToVoidDelegate_StillFailsGsc()
    {
        const string source = @"package Demo

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
";

        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-negctrl", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, source);

        (int exit, string output) = RunDotnet($"\"{compiler}\" /target:library /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0155", output, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------
    // Full compile+run behavioral tests
    // ---------------------------------------------------------------

    /// <summary>
    /// The exact Oahu <c>AudibleClient</c> shape end-to-end: subscribes,
    /// fires, and lets the non-faulting async body run to completion. Proves
    /// (a) the native async-void handler compiles and (b) the call returns
    /// synchronously (proving fire-and-forget dispatch) while the awaited
    /// continuation still completes normally (proving no swallowed/broken
    /// await).
    /// </summary>
    [Fact]
    public void E2e_AudibleClientShape_FiresAndCompletesWithoutError()
    {
        string printed = TranslateAndValidate(@"
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
            Console.WriteLine(""wrote-configuration"");
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
            Console.WriteLine(""fire-returned"");
            Authorize.Complete();
            Thread.Sleep(300);
        }
    }
}");

        string stdout = CompileAndRun(printed, "AudibleClient().Fire()");
        string[] lines = stdout.Trim().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        // `Fire` returns (and prints "fire-returned") BEFORE the awaited
        // continuation inside the handler completes (proves the handler call
        // itself is synchronous/void, matching real async-void dispatch).
        Assert.Equal("fire-returned", lines[0]);
        Assert.Contains("wrote-configuration", lines);
    }

    /// <summary>
    /// Attaches a recording <see cref="SynchronizationContext"/> before firing
    /// a faulting async-void handler: the unhandled exception must be posted
    /// through THAT context (and only observed once the posted callback is
    /// actually pumped) rather than crashing the process or being silently
    /// dropped.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The recording <see cref="SynchronizationContext"/> subclass is compiled
    /// as a SEPARATE, ordinary C# helper assembly (<see cref="CompileSupportAssembly"/>)
    /// and referenced by the translated snippet, rather than being defined
    /// inline in the C# source under translation. G# has no support for
    /// overriding a virtual method of an EXTERNAL (BCL/metadata) base class
    /// (confirmed independently: <c>structSymbol.BaseClass</c> is only
    /// populated for G#-authored base types, so overriding e.g.
    /// <c>SynchronizationContext.Post</c> directly in G#/cs2gs-translated
    /// source silently drops the <c>override</c> modifier and produces a
    /// non-virtual SHADOWING method — calls through a base-typed reference then
    /// dispatch to the BCL base implementation instead, which is an unrelated,
    /// pre-existing gsc/Core limitation, not a defect in this issue's fix). Using
    /// a pre-compiled reference assembly for the subclass sidesteps that gap
    /// entirely (exactly how real Oahu code would consume a helper type from
    /// another already-compiled assembly) while still exercising the actual
    /// translated <c>OnTick</c> handler end-to-end against a real captured
    /// <see cref="SynchronizationContext"/>.
    /// </para>
    /// </remarks>
    [Fact]
    public void E2e_FaultingHandler_WithSynchronizationContext_PostsExceptionInsteadOfCrashing()
    {
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
        string supportDll = CompileSupportAssembly(
            @"
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
}",
            "Issue2438Support");

        string printed = TranslateAndValidate(
            @"
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
            throw new InvalidOperationException(""boom"");
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

            Console.WriteLine(""posted:"" + ctx.PostedCount);
            string caught = ctx.PumpAndCaptureFirstException();
            if (caught != null)
            {
                Console.WriteLine(""caught:"" + caught);
            }
        }
    }
}",
            new[] { MetadataReference.CreateFromFile(supportDll) });

        string stdout = CompileAndRun(printed, "Driver.Run()", new[] { supportDll });
        Assert.Contains("posted:1", stdout);
        Assert.Contains("caught:boom", stdout);
    }

    /// <summary>
    /// With NO ambient <see cref="SynchronizationContext"/> (the common
    /// console-app default), the same faulting handler must still surface its
    /// exception rather than swallow it — matching real C# async-void, which
    /// crashes the process on an unhandled exception with no context to post
    /// to.
    /// </summary>
    [Fact]
    public void E2e_FaultingHandler_WithoutSynchronizationContext_CrashesInsteadOfSwallowing()
    {
        string printed = TranslateAndValidate(@"
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
            throw new InvalidOperationException(""boom"");
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
            Console.WriteLine(""fire-returned"");
            Thread.Sleep(500);
            Console.WriteLine(""should-not-reach-here"");
        }
    }
}");

        (string stdout, int exitCode) = CompileAndRunAllowFailure(printed, "Driver.Run()");
        Assert.Contains("fire-returned", stdout);
        Assert.NotEqual(0, exitCode);
        Assert.DoesNotContain("should-not-reach-here", stdout);
    }

    /// <summary>
    /// Two handlers subscribed to the same event, then ONE unsubscribed by
    /// name via <c>-=</c>: only the still-subscribed handler must fire on the
    /// second raise — proves the native method preserves delegate identity
    /// across <c>+=</c>/<c>-=</c> (the local-function/lambda `let` binding and
    /// the method-group name both resolve to the identical function value each
    /// time they're referenced).
    /// </summary>
    [Fact]
    public void E2e_MultipleSubscribeThenUnsubscribeByName_OnlyRemainingHandlerFires()
    {
        string printed = TranslateAndValidate(@"
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
            Console.WriteLine(""first"");
        }

        private static async void Second(object sender, EventArgs e)
        {
            await Task.Delay(1);
            Console.WriteLine(""second"");
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
}");

        string stdout = CompileAndRun(printed, "Driver.Run()");
        int firstCount = System.Text.RegularExpressions.Regex.Matches(stdout, "first").Count;
        int secondCount = System.Text.RegularExpressions.Regex.Matches(stdout, "second").Count;

        // `First` fired only on the FIRST raise (before it was unsubscribed);
        // `Second` fired on both raises.
        Assert.Equal(1, firstCount);
        Assert.Equal(2, secondCount);
    }

    // ---------------------------------------------------------------
    // Shared helpers (pattern established by Issue1732LoopLoweringTranslationTests
    // / Issue2434DelegateNullableInterfaceWideningTranslationTests)
    // ---------------------------------------------------------------

    private static string TranslateAndValidate(string source, IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? null
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) }, references);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = extraReferences is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Consumer fixture omits the referenced support assembly from emitted G#; CompileAndRun binds it below.");
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="source"/> as an ordinary (non-translated) C#
    /// class-library assembly using Roslyn directly, so its members retain
    /// REAL CLR override/virtual-dispatch semantics. Used by tests that need a
    /// helper type (e.g. a <see cref="SynchronizationContext"/> subclass) which
    /// itself is NOT the thing under test — see the remarks on
    /// <see cref="E2e_FaultingHandler_WithSynchronizationContext_PostsExceptionInsteadOfCrashing"/>
    /// for why such helper types must be pre-compiled rather than routed
    /// through cs2gs/gsc.
    /// </summary>
    private static string CompileSupportAssembly(string source, string assemblyName)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Support.cs", source) },
            references: null,
            assemblyName: assemblyName,
            outputKind: OutputKind.DynamicallyLinkedLibrary);
        Assert.True(
            project.BoundWithoutErrors,
            "Support assembly should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string dllPath = Path.Combine(workDir, assemblyName + ".dll");
        using (FileStream stream = File.Create(dllPath))
        {
            Microsoft.CodeAnalysis.Emit.EmitResult emitResult = project.Compilation.Emit(stream);
            Assert.True(
                emitResult.Success,
                "Support assembly must emit with zero errors: " +
                    string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return dllPath;
    }

    private static string CompileAndRun(string printed, string callExpression, IReadOnlyList<string> extraReferenceDlls = null)
    {
        (string stdout, int exitCode) = CompileAndRunAllowFailure(printed, callExpression, extraReferenceDlls);
        Assert.True(exitCode == 0, "Translated snippet must run successfully. Output:\n" + stdout);
        return stdout;
    }

    private static (string Stdout, int ExitCode) CompileAndRunAllowFailure(
        string printed,
        string callExpression,
        IReadOnlyList<string> extraReferenceDlls = null)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2438-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        var referenceArgs = new StringBuilder();
        if (extraReferenceDlls is not null)
        {
            foreach (string referenceDll in extraReferenceDlls)
            {
                // The compiled snippet is later invoked as a standalone
                // process (`dotnet Snippet.dll`); the CLR probes for
                // references next to the entry assembly, so any referenced
                // helper assembly must be copied alongside it.
                string copiedPath = Path.Combine(workDir, Path.GetFileName(referenceDll));
                File.Copy(referenceDll, copiedPath, overwrite: true);
                referenceArgs.Append(" /r:\"").Append(referenceDll).Append('"');
            }
        }

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"{referenceArgs}");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        return (stdout, runExit);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

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
}
