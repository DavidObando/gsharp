// <copyright file="Issue3865ImportedObliviousArgumentAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3865: cs2gs emitted a <c>!!</c> on arguments passed to IMPORTED
/// parameters that carry no nullable metadata at all (oblivious).
/// <para>
/// gsc's import rule is the INVERSE of C#'s. <c>ClrNullability.IsPositionNonNull</c>
/// reads "non-null iff the byte is <c>1</c>", so an oblivious byte (<c>0</c>)
/// and absent metadata BOTH map to <c>T?</c>. An imported oblivious parameter
/// therefore already accepts a nullable value, and the assertion is not a
/// widening bridge — it is pure runtime overhead that CHANGES BEHAVIOUR:
/// G#'s <c>x!!</c> lowers to <c>dup; brtrue; pop; newobj NullReferenceException;
/// throw</c>, unlike C#'s erased <c>x!</c>. A legal C# call such as
/// <c>string.Equals(null, "root", StringComparison.OrdinalIgnoreCase)</c>
/// (which returns <c>false</c>) became a crash in the migrated artifact —
/// invisible to translate, compile and ILVerify, observable only by running it.
/// </para>
/// <para>
/// The trigger looked context-sensitive on issue #3862 ("the same
/// <c>BuildTask.cs</c> translates clean standalone and with <c>!!</c>
/// in-corpus") because the in-memory test harness compiles against the running
/// runtime's fully annotated net10.0 reference assemblies, while the real
/// <c>src/Sdk/Gsharp.NET.Sdk</c> targets <b>netstandard2.0</b>, whose reference
/// assemblies contain ZERO <c>NullableAttribute</c>. Under netstandard2.0 even
/// <c>string.IsNullOrEmpty</c>, <c>string.Equals</c> and <c>bool.TryParse</c>
/// are oblivious, so there was only ever ONE mechanism, not two.
/// </para>
/// <para>
/// The tests below model that faithfully: the "imported" library is emitted to
/// a real metadata image (no <c>DeclaringSyntaxReference</c>, exactly like a
/// framework or NuGet reference) from a nullable-DISABLED compilation, and the
/// consumer that calls it is nullable-ENABLED, mirroring
/// <c>&lt;Nullable&gt;enable&lt;/Nullable&gt;</c> on a netstandard2.0 project.
/// </para>
/// </summary>
public class Issue3865ImportedObliviousArgumentAssertionTests
{
    // A nullable-DISABLED library: `Sink.Accept(string)` and `Sink.Field` carry
    // no nullable metadata, exactly like netstandard2.0's `string.Equals` or
    // `Microsoft.Build.Utilities.TaskLoggingHelper.LogError`.
    private const string ObliviousLibrarySource = @"
using System;

namespace Imported
{
    public static class Sink
    {
        public static bool Accept(string value)
        {
            return value == null;
        }

        public static bool AcceptTwo(string first, string second)
        {
            return first == null && second == null;
        }
    }

    public class Holder
    {
        public string Field;
    }

    public class Target
    {
        public string Value { get; set; }
    }

    public sealed class Lookup
    {
        public string this[string key]
        {
            get { return key == null ? ""<null-key>"" : ""hit""; }
            set { }
        }
    }
}";

    // The same library, nullable-ENABLED, declaring the parameter NON-nullable.
    // gsc imports that as a genuine non-null `string`, so a nullable argument
    // still needs the `!!` bridge — the anti-vacuity control for the fix.
    private const string AnnotatedLibrarySource = @"
#nullable enable
using System;

namespace Imported
{
    public static class Sink
    {
        public static bool Accept(string value)
        {
            return value.Length == 0;
        }

        public static bool AcceptTwo(string first, string second)
        {
            return first.Length == second.Length;
        }
    }

    public class Holder
    {
        public string Field = string.Empty;
    }

    public class Target
    {
        public string Value { get; set; } = string.Empty;
    }

    public sealed class Lookup
    {
        public string this[string key]
        {
            get { return key.Length == 0 ? ""empty"" : ""hit""; }
            set { }
        }
    }
}";

    private const string ConsumerSource = @"
#nullable enable
using Imported;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public bool Call() => Sink.Accept(this.Maybe);
    }
}";

    [Fact]
    public void ObliviousImportedParameter_NullableArgument_EmitsNoRuntimeAssertion()
    {
        string printed = TranslateAgainstLibrary(ObliviousLibrarySource, ConsumerSource);

        Assert.Contains("Sink.Accept(this.Maybe)", Compact(printed), StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void AnnotatedNonNullImportedParameter_NullableArgument_StillAssertsAntiVacuityControl()
    {
        // Anti-vacuity guard rail: this assertion is required, and it passes on
        // `origin/main` too. Were the fix over-broad (dropping `!!` at every
        // imported target rather than only oblivious ones), this would fail.
        string printed = TranslateAgainstLibrary(AnnotatedLibrarySource, ConsumerSource);

        Assert.Contains("Sink.Accept(this.Maybe!!)", Compact(printed), StringComparison.Ordinal);
    }

    [Fact]
    public void ObliviousImportedField_NullableAssignment_EmitsNoRuntimeAssertion()
    {
        const string Source = @"
#nullable enable
using Imported;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public void Store(Holder holder)
        {
            holder.Field = this.Maybe;
        }
    }
}";

        string printed = TranslateAgainstLibrary(ObliviousLibrarySource, Source);

        Assert.Contains("holder.Field = this.Maybe", Compact(printed), StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ObliviousImportedParameter_SubstitutedGenericTargetStillAsserts()
    {
        // A generic BCL target such as `List<string>.Add(T item)` declares its
        // parameter as the TYPE PARAMETER `T` (`NullableAnnotation.None`), which
        // says nothing about obliviousness — gsc binds the substituted `string`
        // as non-null. The fix keys off the ORIGINAL definition's type and
        // excludes type parameters, so this still asserts. Passes on
        // `origin/main` as well; it exists to pin the exclusion.
        const string Source = @"
#nullable enable
using System.Collections.Generic;

namespace Consumer
{
    public class Caller
    {
        public string? Maybe { get; set; }

        public void Fill(List<string> items)
        {
            items.Add(this.Maybe);
        }
    }
}";

        string printed = TranslateAgainstLibrary(ObliviousLibrarySource, Source);

        Assert.Contains("items.Add(this.Maybe!!)", Compact(printed), StringComparison.Ordinal);
    }

    /// <summary>
    /// The defect class is definitionally invisible to translate, compile and
    /// ILVerify, so the regression has to EXECUTE. Compiles the translated G#
    /// with the real gsc against the real oblivious library image and asserts
    /// the program prints what the equivalent C# prints instead of throwing
    /// <see cref="NullReferenceException"/>.
    /// </summary>
    [Fact]
    public void ObliviousImportedParameter_NullArgument_RunsWithoutThrowing()
    {
        const string Source = @"
#nullable enable
using System;
using Imported;

namespace Consumer
{
    public static class Program
    {
        public static string? Maybe { get; set; }

        public static void Main()
        {
            Console.WriteLine(""before"");
            Console.WriteLine(Sink.Accept(Maybe));
            Console.WriteLine(Sink.AcceptTwo(Maybe, Maybe));
            Console.WriteLine(""after"");
        }
    }
}";

        (string printed, ImmutableArray<byte> libraryImage) =
            TranslateAgainstLibraryWithImage(ObliviousLibrarySource, Source, OutputKind.ConsoleApplication);

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);

        (int exit, string stdout) = CompileAndRun(printed, libraryImage);

        // C# semantics for the identical program: `value == null` is `true`.
        Assert.Equal(0, exit);
        Assert.Equal(
            new[] { "before", "True", "True", "after" },
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray());
    }

    /// <summary>
    /// The same executing proof for the two OTHER sink shapes whose existing
    /// expectations this fix changes — an imported oblivious PROPERTY in an
    /// object initializer (issue #2521's prebuilt-metadata case) and an imported
    /// oblivious INDEXER key argument (issue #2511's <c>ImportedLookup</c>
    /// case). Both used to carry a <c>!!</c>; this run is the evidence that
    /// removing it is a gratuitous-assertion removal and not lost checking —
    /// gsc compiles the assertion-free form with zero diagnostics AND the
    /// program produces the value the equivalent C# produces instead of
    /// throwing.
    /// </summary>
    [Fact]
    public void ObliviousImportedInitializerAndIndexerSinks_RunWithoutThrowing()
    {
        const string Source = @"
#nullable enable
using System;
using Imported;

namespace Consumer
{
    public static class Program
    {
        public static string? Maybe { get; set; }

        public static void Main()
        {
            Console.WriteLine(""before"");
            Target target = new Target { Value = Maybe };
            Console.WriteLine(target.Value == null);
            Lookup lookup = new Lookup();
            lookup[Maybe] = ""v"";
            Console.WriteLine(lookup[Maybe]);
            Console.WriteLine(""after"");
        }
    }
}";

        (string printed, ImmutableArray<byte> libraryImage) =
            TranslateAgainstLibraryWithImage(ObliviousLibrarySource, Source, OutputKind.ConsoleApplication);

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);

        (int exit, string stdout) = CompileAndRun(printed, libraryImage);

        Assert.Equal(0, exit);
        Assert.Equal(
            new[] { "before", "True", "<null-key>", "after" },
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray());
    }

    // ---- harness -----------------------------------------------------------

    private static string Compact(string printed) =>
        string.Join(" ", printed.Split((char[])null, StringSplitOptions.RemoveEmptyEntries));

    private static string TranslateAgainstLibrary(
        string librarySource, string consumerSource, OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
        => TranslateAgainstLibraryWithImage(librarySource, consumerSource, outputKind).Printed;

    private static (string Printed, ImmutableArray<byte> LibraryImage) TranslateAgainstLibraryWithImage(
        string librarySource, string consumerSource, OutputKind outputKind)
    {
        ImmutableArray<byte> image = EmitLibraryImage(librarySource);

        // A METADATA reference (not a compilation reference): the imported
        // symbols have no `DeclaringSyntaxReference` at all, which is what a
        // framework/NuGet reference looks like and what the fix keys off.
        var references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new MetadataReference[] { MetadataReference.CreateFromImage(image) })
            .ToList();

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            consumerSource, new CSharpParseOptions(LanguageVersion.Latest), path: "Consumer.cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Consumer",
            new[] { tree },
            references,
            new CSharpCompilationOptions(outputKind)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        List<Diagnostic> errors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.True(
            errors.Count == 0,
            "Consumer should bind with no C# errors: " + string.Join(Environment.NewLine, errors));

        var document = new LoadedDocument("Consumer.cs", tree, compilation.GetSemanticModel(tree));
        var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (GSharpPrinter.Print(unit), image);
    }

    private static ImmutableArray<byte> EmitLibraryImage(string librarySource)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            librarySource, new CSharpParseOptions(LanguageVersion.Latest), path: "Imported.cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Imported",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));

        using var stream = new MemoryStream();
        EmitResult result = compilation.Emit(stream);
        Assert.True(
            result.Success,
            "Imported library must emit: " + string.Join(
                Environment.NewLine, result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        return ImmutableArray.Create(stream.ToArray());
    }

    private static (int Exit, string Stdout) CompileAndRun(string printed, ImmutableArray<byte> libraryImage)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-3865-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);

        string libraryPath = Path.Combine(workDir, "Imported.dll");
        File.WriteAllBytes(libraryPath, libraryImage.ToArray());

        string gsPath = Path.Combine(workDir, "Program.gs");
        File.WriteAllText(gsPath, printed);

        string dllPath = Path.Combine(workDir, "Program.dll");
        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /reference:\"{libraryPath}\" /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated program with zero errors. Output:\n" + compileOut
                + "\n\nTranslated G#:\n" + printed);

        WriteRuntimeConfig(Path.Combine(workDir, "Program.runtimeconfig.json"));
        return RunDotnet($"\"{dllPath}\"");
    }

    private static void WriteRuntimeConfig(string path)
    {
        if (File.Exists(path))
        {
            return;
        }

        File.WriteAllText(
            path,
            "{\n  \"runtimeOptions\": {\n    \"tfm\": \"net10.0\",\n"
                + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \""
                + Environment.Version.Major + ".0.0\" }\n  }\n}\n");
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
