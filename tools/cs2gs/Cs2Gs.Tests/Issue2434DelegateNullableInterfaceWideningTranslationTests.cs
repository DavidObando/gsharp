// <copyright file="Issue2434DelegateNullableInterfaceWideningTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2434: an UNCONDITIONAL (no guard
/// dominating the use) forward of a same-project promoted-nullable
/// field/property/local/parameter/method as the ENTIRE (possibly
/// parenthesized) expression of a call-site ARGUMENT whose bound parameter is
/// a genuine non-null reference type cs2gs will not also promote. This is the
/// argument-position counterpart of #2432's return-preserving-body rule,
/// reusing the same <c>IsNullablePromotedValue</c>/guard-detection machinery
/// (<see cref="Issue2432UnguardedForwardForgivenessTranslationTests"/>). The
/// canonical shape is the real <c>Oahu.Core</c> <c>BookLibrary.gs:490</c>
/// case: a same-project concrete <c>Conversion</c> local promoted to
/// <c>Conversion?</c> by unrelated constructor-parameter taint, forwarded as
/// the sole argument of a CONDITIONAL delegate invocation
/// (<c>callback?(tmp)</c>) whose delegate parameter type is the concrete
/// class's own interface <c>IConversion</c> — a fixed, external
/// (<c>System.Action&lt;T&gt;</c>-shaped) function-type parameter that can
/// NEVER itself be promoted to nullable the way an ordinary same-project
/// method parameter can. gsc's own <c>Conversion.Classify</c> already
/// composes an explicit nullable-unwrap (<c>!!</c>) with the implicit
/// reference/interface widening correctly (issue #1627's deliberate
/// <c>S? -&gt; S</c>/<c>S? -&gt; I</c> rejection without an explicit unwrap is
/// BY DESIGN and unrelated to this bug) — the gap is entirely on the cs2gs
/// side: it must actually EMIT the <c>!!</c> at this argument position.
/// </summary>
public class Issue2434DelegateNullableInterfaceWideningTranslationTests
{
    /// <summary>
    /// The exact real-world <c>BookLibrary.gs:490</c> shape: a nullable
    /// concrete class local forwarded, unguarded, as the sole argument of a
    /// CONDITIONAL delegate invocation whose parameter type is the concrete
    /// class's own interface. Must assert <c>!!</c> so gsc accepts the
    /// <c>Conversion? -&gt; IConversion</c> widening.
    /// </summary>
    [Fact]
    public void ConditionalDelegateInvoke_NullableConcreteToInterfaceArg_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("callback?(tmp!!)", printed);
    }

    /// <summary>
    /// Same tainted-forward shape, but a DIRECT (non-conditional) delegate
    /// invocation (<c>callback.Invoke(tmp)</c> / G#'s <c>callback(tmp)</c>
    /// spelling). The delegate's <c>Invoke</c> parameter is exactly as fixed
    /// and external as the conditional form, so the same bridge applies.
    /// </summary>
    [Fact]
    public void DirectDelegateInvoke_NullableConcreteToInterfaceArg_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("callback(tmp!!)", printed);
    }

    /// <summary>
    /// The same forward through a LOCAL lambda-typed variable rather than a
    /// field: local delegate-typed variables bind against the same fixed,
    /// external <c>Invoke</c> parameter, so this must assert too — the rule
    /// is scoped to the argument shape, not to fields specifically.
    /// </summary>
    [Fact]
    public void LambdaTypedLocal_NullableConcreteToInterfaceArg_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("local(tmp!!)", printed);
    }

    /// <summary>
    /// A GENERIC delegate (<c>Func&lt;IConversion, string&gt;</c>) invoked
    /// conditionally — confirms the fix is not limited to <c>Action</c>-typed
    /// delegates or a fixed non-generic BCL shape.
    /// </summary>
    [Fact]
    public void GenericDelegate_NullableConcreteToInterfaceArg_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("callback?(tmp!!)", printed);
    }

    /// <summary>
    /// The forward target is <c>object</c> rather than a source-declared
    /// interface — confirms the rule covers the general <c>C? -&gt; object</c>
    /// widening, not only <c>C? -&gt; I</c> for a source/imported interface.
    /// </summary>
    [Fact]
    public void ObjectTarget_NullableConcreteToObjectArg_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public class Conversion
    {
        public string Name { get; set; }

        public static Conversion Find(int flag)
        {
            if (flag == 0) { return null; }
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("callback?(tmp!!)", printed);
    }

    /// <summary>
    /// Contrast case: an ORDINARY same-project static method call
    /// (<c>Run(IConversion c)</c>). The whole-program oblivious taint
    /// fixpoint promotes <c>Run</c>'s OWN parameter to <c>IConversion?</c> in
    /// lockstep with the tainted argument (unlike a delegate's fixed external
    /// <c>Invoke</c> signature, an ordinary same-project parameter CAN be
    /// promoted), so the call already widens <c>T? -&gt; T?</c> — asserting
    /// <c>!!</c> here would be superfluous. Confirms the new rule's
    /// "parameter declared in this compilation and itself promotable" carve-
    /// out correctly stays silent for the case the fixpoint already handles.
    /// </summary>
    [Fact]
    public void NormalMethodCall_CalleeParameterAlsoPromoted_DoesNotAssertNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.Contains("func Run(c IConversion?)", printed);
        Assert.DoesNotContain("tmp!!", printed);
    }

    /// <summary>
    /// A local narrowed by a dominating textual null-check guard
    /// (<c>if (tmp != null) { callback?.Invoke(tmp); }</c>) needs no help at
    /// all from this rule: gsc's own Kotlin-style smart-cast already narrows
    /// a syntactically-guarded LOCAL read, so forcing <c>!!</c> here would be
    /// a redundant (if harmless) assertion — the rule must stay silent so the
    /// forgiveness is reserved for the genuinely unconditional forward.
    /// </summary>
    [Fact]
    public void GuardedLocal_ConditionalDelegateInvoke_DoesNotAssertNonNull()
    {
        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
}");

        Assert.DoesNotContain("tmp!!", printed);
        Assert.Contains("callback?(tmp)", printed);
    }

    [Fact]
    public void TryGetOutLocal_PassedToNonNullMethod_AssertsNonNull()
    {
        string printed = TranslateNullableEnabled(@"
#nullable enable
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Item { public string Name { get; set; } = """"; }

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
}");

        Assert.Contains("Sink(item!!)", printed);
    }

    [Fact]
    public void EarlyReturnNullGuard_LocalPassedToNonNullConstructor_AssertsNonNull()
    {
        string printed = TranslateNullableEnabled(@"
#nullable enable
namespace Demo
{
    public class Item { public string Name { get; set; } = """"; }
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
}");

        Assert.Contains("return Holder(item!!)", printed);
    }

    [Fact]
    public void PreviouslyDereferencedNullableLocal_PassedToNonNullConstructor_AssertsNonNull()
    {
        string printed = TranslateNullableEnabled(@"
#nullable enable
namespace Demo
{
    public class Item { public string Name { get; set; } = """"; }
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
}");

        Assert.Contains("return Holder(item!!)", printed);
    }

    /// <summary>
    /// Negative control: the forwarded value is never null-tainted at all (no
    /// flow of <c>null</c> anywhere in the compilation), so
    /// <c>IsNullablePromotedValue</c> rejects it outright — no spurious
    /// <c>!!</c> on an already-non-nullable forward.
    /// </summary>
    [Fact]
    public void UnTaintedForward_DoesNotAssertNonNull()
    {
        string printed = TranslateOblivious(@"
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
            Conversion tmp = new Conversion { Name = ""x"" };
            callback?.Invoke(tmp);
        }
    }
}");

        Assert.DoesNotContain("tmp!!", printed);
    }

    /// <summary>
    /// Negative control: an UNRELATED, genuinely invalid conversion (a
    /// concrete class with no relationship to the delegate parameter's type)
    /// never reaches cs2gs at all — Roslyn itself rejects it as a C# compile
    /// error before <see cref="Cs2Gs.ProjectLoading.LoadedCSharpProject.BoundWithoutErrors"/>
    /// would pass, so <see cref="TranslateOblivious"/>'s own bind-assertion
    /// is the control here: this snippet must simply fail to bind, proving
    /// no cs2gs-side guard is needed for that case.
    /// </summary>
    [Fact]
    public void UnrelatedInvalidConversion_FailsToBind()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
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
            Conversion tmp = new Conversion { Name = ""x"" };
            callback?.Invoke(tmp);
        }
    }
}"),
        });

        Assert.False(project.BoundWithoutErrors, "An unrelated/invalid conversion must fail to bind in C# itself.");
    }

    /// <summary>
    /// Negative control: a GENUINELY nullable-enabled compilation
    /// (<c>NullableContextOptions.Enable</c>, project-wide).
    /// <see cref="CSharpToGSharpTranslator.IsObliviousCompilation"/> gates
    /// this entire rule to oblivious compilations, so a nullable-enabled
    /// project's identical forwarding shape must stay byte-identical to
    /// pre-#2434 behavior (the real compiler's own nullable analysis already
    /// enforces the contract there; a genuine violation would be a C# error).
    /// </summary>
    [Fact]
    public void NullableEnabledCompilation_Forward_DoesNotAssertNonNull()
    {
        string source = @"
#nullable enable
namespace Demo
{
    public interface IConversion { string Name { get; } }

    public class Conversion : IConversion
    {
        public string Name { get; set; } = """";
    }

    public class BookLibrary
    {
        public System.Action<IConversion>? callback;

        public void Process(Conversion tmp)
        {
            callback?.Invoke(tmp);
        }
    }
}";

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2434.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        string printed = PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.DoesNotContain("tmp!!", printed);
    }

    /// <summary>
    /// Full compile/run proof: the exact <c>Oahu.Core</c>
    /// <c>BookLibrary.gs:490</c> shape, once translated, must actually
    /// compile with the real <c>gsc</c> (zero errors — the concrete assertion
    /// that GS0155 no longer reproduces) and RUN correctly, preserving the
    /// original C#'s runtime null behavior: a non-null converted value
    /// reaches the callback through the widened interface reference
    /// (verified by invoking a real interface member on it inside the
    /// callback), and a <see langword="null"/> callback field still safely
    /// no-ops the whole conditional invocation (never touching the `!!`
    /// asserted argument at all). Gated on the compiler artifact being
    /// present (built via <c>GSharp.sln</c>); the translation-level
    /// assertions in the other tests in this file still validate the fix
    /// when only the cs2gs test project itself is built.
    /// </summary>
    [Fact]
    public void ConditionalDelegateInvoke_BookLibraryShape_CompilesAndRunsWithGsc()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string printed = TranslateOblivious(@"
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
            return new Conversion { Name = ""x"" };
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
            string happyResult = invokedWithName == ""x"" ? ""invoked-ok"" : ""invoked-wrong"";
            Console.WriteLine(happyResult);

            // Null-callback path: the conditional invocation itself must
            // still short-circuit safely and never touch the `!!`-asserted
            // argument, even when it, too, is genuinely null.
            lib.callback = null;
            lib.Process(0);
            Console.WriteLine(""no-crash"");
        }
    }
}");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2434-e2e");
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "BookLibrary.gs");
        string dllPath = Path.Combine(workDir, "BookLibrary.dll");
        File.WriteAllText(gsPath, printed);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated BookLibrary shape with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated BookLibrary must run successfully. Output:\n" + stdout);
        Assert.Contains("invoked-ok", stdout);
        Assert.Contains("no-crash", stdout);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateNullableEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2434.NullableEnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
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
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdout + stderr);
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
