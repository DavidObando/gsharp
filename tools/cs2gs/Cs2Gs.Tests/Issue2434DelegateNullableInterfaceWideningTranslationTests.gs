// <copyright file="Issue2434DelegateNullableInterfaceWideningTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import Xunit

/// Translator-fidelity tests for issue #2434: an UNCONDITIONAL (no guard
/// dominating the use) forward of a same-project promoted-nullable
/// field/property/local/parameter/method as the ENTIRE (possibly
/// parenthesized) expression of a call-site ARGUMENT whose bound parameter is
/// a genuine non-null reference type cs2gs will not also promote. This is the
/// argument-position counterpart of #2432's return-preserving-body rule,
/// reusing the same `IsNullablePromotedValue`/guard-detection machinery
/// ((cref:Issue2432UnguardedForwardForgivenessTranslationTests)). The
/// canonical shape is the real `Oahu.Core` `BookLibrary.gs:490`
/// case: a same-project concrete `Conversion` local promoted to
/// `Conversion?` by unrelated constructor-parameter taint, forwarded as
/// the sole argument of a CONDITIONAL delegate invocation
/// (`callback?(tmp)`) whose delegate parameter type is the concrete
/// class's own interface `IConversion` — a fixed, external
/// (`System.Action<T>`-shaped) function-type parameter that can
/// NEVER itself be promoted to nullable the way an ordinary same-project
/// method parameter can. gsc's own `Conversion.Classify` already
/// composes an explicit nullable-unwrap (`!!`) with the implicit
/// reference/interface widening correctly (issue #1627's deliberate
/// `S? -> S`/`S? -> I` rejection without an explicit unwrap is
/// BY DESIGN and unrelated to this bug) — the gap is entirely on the cs2gs
/// side: it must actually EMIT the `!!` at this argument position.
open class Issue2434DelegateNullableInterfaceWideningTranslationTests {
    /// The exact real-world `BookLibrary.gs:490` shape: a nullable
    /// concrete class local forwarded, unguarded, as the sole argument of a
    /// CONDITIONAL delegate invocation whose parameter type is the concrete
    /// class's own interface. Must assert `!!` so gsc accepts the
    /// `Conversion? -> IConversion` widening.
    @Fact
    func ConditionalDelegateInvoke_NullableConcreteToInterfaceArg_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Action<IConversion> callback;

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            callback?.Invoke(tmp);
        }
    }
}`)
        Assert.Contains("callback?(tmp!!)", printed)
    }

    /// Same tainted-forward shape, but a DIRECT (non-conditional) delegate
    /// invocation (`callback.Invoke(tmp)` / G#'s `callback(tmp)`
    /// spelling). The delegate's `Invoke` parameter is exactly as fixed
    /// and external as the conditional form, so the same bridge applies.
    @Fact
    func DirectDelegateInvoke_NullableConcreteToInterfaceArg_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Action<IConversion> callback = c => { };

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            callback.Invoke(tmp);
        }
    }
}`)
        Assert.Contains("callback(tmp!!)", printed)
    }

    /// The same forward through a LOCAL lambda-typed variable rather than a
    /// field: local delegate-typed variables bind against the same fixed,
    /// external `Invoke` parameter, so this must assert too — the rule
    /// is scoped to the argument shape, not to fields specifically.
    @Fact
    func LambdaTypedLocal_NullableConcreteToInterfaceArg_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public void Process(int flag)
        {
            Action<IConversion> local = c => { };
            Conversion tmp = Conversion.Find(flag);
            local(tmp);
        }
    }
}`)
        Assert.Contains("local(tmp!!)", printed)
    }

    /// A GENERIC delegate (`Func<IConversion, string>`) invoked
    /// conditionally — confirms the fix is not limited to `Action`-typed
    /// delegates or a fixed non-generic BCL shape.
    @Fact
    func GenericDelegate_NullableConcreteToInterfaceArg_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Func<IConversion, string> callback;

        public string Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            return callback?.Invoke(tmp);
        }
    }
}`)
        Assert.Contains("callback?(tmp!!)", printed)
    }

    /// The forward target is `object` rather than a source-declared
    /// interface — confirms the rule covers the general `C? -> object`
    /// widening, not only `C? -> I` for a source/imported interface.
    @Fact
    func ObjectTarget_NullableConcreteToObjectArg_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public class Conversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Action<object> callback;

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            callback?.Invoke(tmp);
        }
    }
}`)
        Assert.Contains("callback?(tmp!!)", printed)
    }

    /// Contrast case: an ORDINARY same-project static method call
    /// (`Run(IConversion c)`). The whole-program oblivious taint
    /// fixpoint promotes `Run`'s OWN parameter to `IConversion?` in
    /// lockstep with the tainted argument (unlike a delegate's fixed external
    /// `Invoke` signature, an ordinary same-project parameter CAN be
    /// promoted), so the call already widens `T? -> T?` — asserting
    /// `!!` here would be superfluous. Confirms the new rule's
    /// "parameter declared in this compilation and itself promotable" carve-
    /// out correctly stays silent for the case the fixpoint already handles.
    @Fact
    func NormalMethodCall_CalleeParameterAlsoPromoted_DoesNotAssertNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public static void Run(IConversion c) { }

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            Run(tmp);
        }
    }
}`)
        Assert.Contains("func Run(c IConversion?)", printed)
        Assert.DoesNotContain("tmp!!", printed)
    }

    /// A local narrowed by a dominating textual null-check guard
    /// (`if (tmp != null) { callback?.Invoke(tmp); }`) needs no help at
    /// all from this rule: gsc's own Kotlin-style smart-cast already narrows
    /// a syntactically-guarded LOCAL read, so forcing `!!` here would be
    /// a redundant (if harmless) assertion — the rule must stay silent so the
    /// forgiveness is reserved for the genuinely unconditional forward.
    @Fact
    func GuardedLocal_ConditionalDelegateInvoke_DoesNotAssertNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Action<IConversion> callback;

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            if (tmp != null)
            {
                callback?.Invoke(tmp);
            }
        }
    }
}`)
        Assert.DoesNotContain("tmp!!", printed)
        Assert.Contains("callback?(tmp)", printed)
    }

    @Fact
    func TryGetOutLocal_PassedToNonNullMethod_AssertsNonNull() {
        let printed = TranslateNullableEnabled(`
#nullable enable
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Item { public string Name { get; set; } = ""; }

    public class Runner
    {
        private static bool TryGet([NotNullWhen(true)] out Item? item) { item = null; return false; }
        private static void Sink(Item item) { _ = item.Name; }

        public void Run()
        {
            while (TryGet(out var item))
            {
                Sink(item);
            }
        }
    }
}`)
        Assert.Contains("Sink(item!!)", printed)
    }

    @Fact
    func EarlyReturnNullGuard_LocalPassedToNonNullConstructor_UsesSmartCast() {
        let printed = TranslateNullableEnabled(`
#nullable enable
namespace Demo
{
    public class Item { public string Name { get; set; } = ""; }
    public class Holder { public Holder(Item item) { _ = item.Name; } }

    public class Runner
    {
        private static Item? Find() => null;

        public object? Run()
        {
            Item item = Find();
            if (item == null) return null;
            return new Holder(item);
        }
    }
}`)
        Assert.Contains("return Holder(item)", printed)
        Assert.DoesNotContain("item!!", printed)
    }

    @Fact
    func PreviouslyDereferencedNullableLocal_PassedToNonNullConstructor_AssertsNonNull() {
        let printed = TranslateNullableEnabled(`
#nullable enable
namespace Demo
{
    public class Item { public string Name { get; set; } = ""; }
    public class Holder { public Holder(Item item) { _ = item.Name; } }

    public class Runner
    {
        private static Item? Find() => null;

        public object Run()
        {
            Item? item = Find();
            _ = item!.Name;
            return new Holder(item);
        }
    }
}`)
        Assert.Contains("return Holder(item!!)", printed)
    }

    /// Negative control: the forwarded value is never null-tainted at all (no
    /// flow of `null` anywhere in the compilation), so
    /// `IsNullablePromotedValue` rejects it outright — no spurious
    /// `!!` on an already-non-nullable forward.
    @Fact
    func UnTaintedForward_DoesNotAssertNonNull() {
        let printed = TranslateOblivious(`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }
    }

    public class BookLibrary
    {
        public Action<IConversion> callback;

        public void Process()
        {
            Conversion tmp = new Conversion { Name = "x" };
            callback?.Invoke(tmp);
        }
    }
}`)
        Assert.DoesNotContain("tmp!!", printed)
    }

    /// Negative control: an UNRELATED, genuinely invalid conversion (a
    /// concrete class with no relationship to the delegate parameter's type)
    /// never reaches cs2gs at all — Roslyn itself rejects it as a C# compile
    /// error before (cref:Cs2Gs.ProjectLoading.LoadedCSharpProject.BoundWithoutErrors)
    /// would pass, so (cref:TranslateOblivious)'s own bind-assertion
    /// is the control here: this snippet must simply fail to bind, proving
    /// no cs2gs-side guard is needed for that case.
    @Fact
    func UnrelatedInvalidConversion_FailsToBind() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public interface IUnrelated { string Other { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }
    }

    public class BookLibrary
    {
        public Action<IUnrelated> callback;

        public void Process()
        {
            Conversion tmp = new Conversion { Name = "x" };
            callback?.Invoke(tmp);
        }
    }
}`)})
        Assert.False(project.BoundWithoutErrors, "An unrelated/invalid conversion must fail to bind in C# itself.")
    }

    /// Negative control: a GENUINELY nullable-enabled compilation
    /// (`NullableContextOptions.Enable`, project-wide).
    /// (cref:CSharpToGSharpTranslator.IsObliviousCompilation) gates
    /// this entire rule to oblivious compilations, so a nullable-enabled
    /// project's identical forwarding shape must stay byte-identical to
    /// pre-#2434 behavior (the real compiler's own nullable analysis already
    /// enforces the contract there; a genuine violation would be a C# error).
    @Fact
    func NullableEnabledCompilation_Forward_DoesNotAssertNonNull() {
        let source = `
#nullable enable
namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; } = "";
    }

    public class BookLibrary
    {
        public System.Action<IConversion>? callback;

        public void Process(Conversion tmp)
        {
            callback?.Invoke(tmp);
        }
    }
}`
        let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
        let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
        let compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2434.EnabledInMemory",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
                .WithAllowUnsafe(true)
        )
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument("Snippet.cs", tree, model)
        let context = TranslationContext(compilation, model, document.FilePath)
        let printed = PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain("tmp!!", printed)
    }

    /// Full compile/run proof: the exact `Oahu.Core`
    /// `BookLibrary.gs:490` shape, once translated, must actually
    /// compile with the real `gsc` (zero errors — the concrete assertion
    /// that GS0155 no longer reproduces) and RUN correctly, preserving the
    /// original C#'s runtime null behavior: a non-null converted value
    /// reaches the callback through the widened interface reference
    /// (verified by invoking a real interface member on it inside the
    /// callback), and a `null` callback field still safely
    /// no-ops the whole conditional invocation (never touching the `!!`
    /// asserted argument at all). Gated on the compiler artifact being
    /// present (built via `GSharp.sln`); the translation-level
    /// assertions in the other tests in this file still validate the fix
    /// when only the cs2gs test project itself is built.
    @Fact
    func ConditionalDelegateInvoke_BookLibraryShape_CompilesAndRunsWithGsc() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let printed = TranslateOblivious((`
using System;

namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = "x" };
        }
    }

    public class BookLibrary
    {
        public Action<IConversion> callback;

        public void Process(int flag)
        {
            Conversion tmp = Conversion.Find(flag);
            callback?.Invoke(tmp);
        }

        public static void Main()
        {
            var lib = new BookLibrary();
            string invokedWithName = null;

            // Happy path: the widened interface reference reaches the
            // callback intact (a real interface member call proves it is not
            // corrupted/boxed by the bridging conversion), preserving the
            // original C#'s runtime behavior exactly.
            lib.callback = c => { invokedWithName = c.Name; };
            lib.Process(1);
            string happyResult = invokedWithName == "x" ? "invoked-ok" : "invoked-wrong";
            Console.WriteLine(happyResult);

            // Null-callback path: the conditional invocation itself must
            // still short-circuit safely and never touch the ` + "`" + `!!` + "`" + `-asserted
            // argument, even when it, too, is genuinely null.
            lib.callback = null;
            lib.Process(0);
            Console.WriteLine("no-crash");
        }
    }
}`))
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2434-e2e")
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "BookLibrary.gs")
        let dllPath = Path.Combine(workDir, "BookLibrary.dll")
        File.WriteAllText(gsPath, printed)
        let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated BookLibrary shape with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
        )
        let (runExit, stdout) = RunDotnet("\"$dllPath\"")
        Assert.True(runExit == 0, "Translated BookLibrary must run successfully. Output:\n" + stdout)
        Assert.Contains("invoked-ok", stdout)
        Assert.Contains("no-crash", stdout)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateNullableEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue2434.NullableEnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            return (process!!.ExitCode, stdout + stderr)
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
