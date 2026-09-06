// <copyright file="Issue3770SilentRuntimeDivergenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #3770 / #3771: two translations that TRANSLATE, COMPILE and ILVerify
/// clean but behave differently from the C# original at run time — the
/// <c>test-parity-failure</c> profile from the #3501 self-migration gate, where
/// no diagnostic points at the defect.
/// <para>
/// #3770 — a C# 12 primary constructor plus a get-only auto-property
/// initializer emitted BOTH a primary-constructor parameter list and a
/// synthesized <b>parameterless</b> <c>init()</c> carrying the assignments. The
/// parameterless initializer is unreachable, so every such property was silently
/// left at its default. This is what broke <c>DocumentContent</c> and, through
/// it, 151 of the 259 migrated <c>LanguageServer.Tests</c> failures with a
/// <c>NullReferenceException</c> on <c>content.SyntaxTree</c>.
/// </para>
/// <para>
/// #3771 — <c>for (var c = x; c != null; c = Parent(c))</c> emitted a <c>!!</c>
/// on the incrementor. C#'s <c>!</c> is erased at compile time; G#'s <c>!!</c> is
/// a CHECKED assertion that THROWS on nil, so the loop's normal termination
/// became a guaranteed <c>NullReferenceException</c>. This broke
/// <c>BoundScope.TryLookupLexicalNestedTypeAlias</c> in the migrated compiler and
/// with it 6 of the 13 migrated <c>GSharp.GeneratorHost.Tests</c> failures.
/// </para>
/// <para>
/// #3775 completes the policy: an event handler is passed through because G#
/// now models C#'s nil-tolerant subscription contract, and an explicit C#
/// null-forgiving operator is erased when its sink already accepts nil. A
/// non-null sink still receives <c>!!</c>, because G# has no erased equivalent.
/// </para>
/// <para>
/// Both are invisible to a binding-only assertion, so each is asserted by
/// EXECUTING the translated G#.
/// </para>
/// </summary>
public sealed class Issue3770SilentRuntimeDivergenceTests
{
    private const string PrimaryConstructorSource = @"
    public class Doc(string tree, int n)
    {
        public string Tree { get; } = tree;

        public int N { get; } = n;
    }
";

    private const string NullableLoopSource = @"
    public class Walker
    {
        private readonly Walker? parent;

        public Walker(Walker? parent) => this.parent = parent;

        public static Walker? Parent(Walker w) => w.parent;

        public static int Depth(Walker start)
        {
            var d = 0;
            for (var current = start; current != null; current = Parent(current))
            {
                d++;
            }

            return d;
        }
    }
";

    private const string NilEventHandlerSource = @"
    public class Clock
    {
        public event EventHandler Ticked;

        public void Subscribe(EventHandler handler)
        {
            Ticked += handler;
            Ticked -= handler;
        }
    }

    public static class EventProbe
    {
        private static EventHandler Pick(bool present) =>
            present ? (_, _) => { } : null;

        public static void Run()
        {
            var clock = new Clock();
            EventHandler handler = Pick(false);
            clock.Subscribe(handler);
            Console.WriteLine(""event-ok"");
        }
    }
";

    private const string NullForgivingSource = @"
    public static class NullForgivingProbe
    {
        private static string? Pick(bool present) => present ? ""value"" : null;

        public static object? NullableProperty { get; } = Pick(false)!;

        public static object? NullableSink() => Pick(false)!;

        public static int InferredNonNullLocal()
        {
            var value = Pick(true)!;
            return value.Length;
        }

        public static bool NullableLocal()
        {
            string? value = Pick(false);
            object? result = value!;
            return result is null;
        }

        public static bool NullableConditional(bool flag)
        {
            string? value = Pick(false);
            object? result = flag ? value! : null;
            return result is null;
        }

        public static object NonNullSink()
        {
            string? value = Pick(false);
            return value!;
        }

        public static int NullableValue(int? value) => value.Value;

        public static T Generic<T>(T? value) => value!;
    }
";

    /// <summary>
    /// The property initializers must land on a constructor that is actually
    /// reached: the primary-constructor parameters move onto the synthesized
    /// designated <c>init(...)</c> and the class header is left parameterless.
    /// </summary>
    [Fact]
    public void PrimaryConstructorWithPropertyInitializers_DoesNotEmitAnUnreachableParameterlessInit()
    {
        string printed = Translate(PrimaryConstructorSource);

        Assert.DoesNotContain("init() {", printed, StringComparison.Ordinal);
        Assert.Contains("init(tree string, n int32)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing half of <see
    /// cref="PrimaryConstructorWithPropertyInitializers_DoesNotEmitAnUnreachableParameterlessInit"/>.
    /// On the pre-fix translation this printed <c>|0</c> — the properties were
    /// silently left at their defaults — with a clean compile.
    /// </summary>
    [Fact]
    public void PrimaryConstructorWithPropertyInitializers_ConstructedValuesReachTheProperties()
    {
        string printed = Translate(PrimaryConstructorSource);
        string stdout = CompileAndRun(
            printed,
            "let d = Doc(\"hello\", 7)\nConsole.WriteLine(d.Tree + \"|\" + d.N.ToString())");

        Assert.Equal("hello|7", stdout.Trim());
    }

    /// <summary>
    /// A <c>var</c> local widened to <c>T?</c> at its declaration must not also
    /// receive a <c>!!</c> bridge on assignments into it.
    /// </summary>
    [Fact]
    public void NullableLoopIncrementor_DoesNotAssertTheNullableAssignment()
    {
        string printed = Translate(NullableLoopSource);

        // Asserted on the whole for-header, not on a `Parent(current)!!`
        // substring: the pre-fix output was `Parent(current!!)!!`, so a substring
        // assertion would have passed vacuously. The ARGUMENT's `!!` is faithful
        // — `current` is flow-narrowed non-null there and `Parent` takes a
        // non-nullable `Walker` — it is the assertion on the assigned VALUE that
        // is wrong.
        Assert.Contains(
            "for var current Walker? = start; current != nil; current = Parent(current!!) {",
            printed,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing half of <see
    /// cref="NullableLoopIncrementor_DoesNotAssertTheNullableAssignment"/>. On the
    /// pre-fix translation this threw <c>NullReferenceException</c> at the loop's
    /// normal exit, with a clean compile and a clean ILVerify.
    /// </summary>
    [Fact]
    public void NullableLoopIncrementor_LoopTerminatesInsteadOfThrowing()
    {
        string printed = Translate(NullableLoopSource);
        string stdout = CompileAndRun(
            printed,
            "Console.WriteLine(Walker.Depth(Walker(Walker(Walker(nil)))).ToString())");

        Assert.Equal("3", stdout.Trim());
    }

    /// <summary>
    /// Once gsc accepts a nilable event-subscription handler, cs2gs must not
    /// reintroduce the old run-time divergence by appending <c>!!</c>.
    /// </summary>
    [Fact]
    public void NilEventHandler_DoesNotReceiveANonNullAssertion()
    {
        string printed = Translate(NilEventHandlerSource, nullableEnabled: false);

        Assert.Contains("Ticked += handler", printed, StringComparison.Ordinal);
        Assert.Contains("Ticked -= handler", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Ticked += handler!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Ticked -= handler!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing half of <see cref="NilEventHandler_DoesNotReceiveANonNullAssertion"/>.
    /// The pre-fix translation threw at the first subscription.
    /// </summary>
    [Fact]
    public void NilEventHandler_RemainsASilentNoOpAtRuntime()
    {
        string printed = Translate(NilEventHandlerSource, nullableEnabled: false);
        string stdout = CompileAndRun(printed, "EventProbe.Run()");

        Assert.Equal("event-ok", stdout.Trim());
    }

    /// <summary>
    /// C#'s null-forgiving operator is erased when the contextual G# sink is
    /// nullable, but remains a checked assertion when a non-null sink requires
    /// it. <c>Nullable&lt;T&gt;.Value</c> keeps the same checked spelling under
    /// the accepted exception-type compatibility limit recorded in ADR-0115.
    /// </summary>
    [Fact]
    public void NullForgivingOperator_FollowsTheContextualSinkPolicy()
    {
        string printed = Translate(NullForgivingSource);

        Assert.Contains("func NullableSink() object? -> Pick(false)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func NullableSink() object? -> Pick(false)!!", printed, StringComparison.Ordinal);
        Assert.Contains("prop NullableProperty object?", printed, StringComparison.Ordinal);
        Assert.Contains("let value = Pick(true)!!", printed, StringComparison.Ordinal);
        Assert.Contains("let result object? = value", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let result object? = value!!", printed, StringComparison.Ordinal);
        Assert.Contains("return value!!", printed, StringComparison.Ordinal);
        Assert.Contains("func NullableValue(value int32?) int32 -> value!!", printed, StringComparison.Ordinal);
        Assert.Contains("func Generic[T](value T?) T -> value!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A genuinely nil value reaches a nullable sink unchanged. This is the
    /// run-time behavior that a text-only assertion cannot prove.
    /// </summary>
    [Fact]
    public void NullForgivingOperator_AtNullableSink_RemainsNilAtRuntime()
    {
        string printed = Translate(NullForgivingSource);
        string stdout = CompileAndRun(
            printed,
            "Console.WriteLine(if NullForgivingProbe.NullableProperty == nil && NullForgivingProbe.NullableSink() == nil && NullForgivingProbe.NullableLocal() && NullForgivingProbe.NullableConditional(true) { \"nil\" } else { \"value\" })");

        Assert.Equal("nil", stdout.Trim());
    }

    /// <summary>
    /// Pins the retained non-null-sink assertion and verifies that
    /// <c>Nullable&lt;T&gt;.Value</c> now preserves C#'s
    /// <see cref="InvalidOperationException"/> contract.
    /// </summary>
    [Fact]
    public void RetainedAssertions_KeepTheirDocumentedRuntimeBehavior()
    {
        string printed = Translate(NullForgivingSource);
        string stdout = CompileAndRun(
            printed,
            """
            try {
                NullForgivingProbe.NonNullSink()
            } catch (NullReferenceException) {
                Console.WriteLine("non-null-sink")
            }
            try {
                NullForgivingProbe.NullableValue(nil)
            } catch (InvalidOperationException) {
                Console.WriteLine("nullable-value")
            }
            """);

        Assert.Equal(
            "non-null-sink" + Environment.NewLine + "nullable-value",
            stdout.Trim());
    }

    private static string Translate(string source, bool nullableEnabled = true)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                (
                    "Snippet.cs",
                    (nullableEnabled ? "#nullable enable\n" : string.Empty)
                        + "using System;\n\nnamespace Demo\n{\n"
                        + source
                        + "\n}\n"),
            });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors)
                + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string entryStatements)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-3770-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + entryStatements + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut
                + "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(
            runExit == 0,
            "Translated snippet must run successfully. Output:\n" + stdout
                + "\n\nTranslated G#:\n" + printed);
        return stdout;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(psi);
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
