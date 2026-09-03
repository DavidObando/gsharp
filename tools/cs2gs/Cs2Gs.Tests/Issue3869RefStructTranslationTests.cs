// <copyright file="Issue3869RefStructTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3869 defect 1: cs2gs dropped the <c>ref</c> from a C# <c>ref struct</c>
/// declaration. That is not a cosmetic loss — it changes the emitted type's CLR
/// identity. Without
/// <c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c> the type is an
/// ordinary struct, and a struct holding a by-ref-like instance field
/// (<c>Span&lt;int&gt;</c>, including an auto-property's backing field) cannot be
/// loaded by the runtime at all: <c>GetExportedTypes()</c> throws
/// <c>TypeLoadException</c>, xunit discovers nothing, and the whole migrated
/// test assembly silently runs zero tests.
/// <para>
/// G# has the construct (ADR-0058 / issue #367, <c>samples/UserRefStruct.gs</c>)
/// and gsc emits the attribute (<c>TypeDefEmitter.EmitIsByRefLikeAttribute</c>),
/// so this was purely a translator-side gap. The assertions below are therefore
/// deliberately NOT binding-only: the emitted assembly is compiled by gsc, its
/// metadata is read back, and the program is EXECUTED so the CLR type loader is
/// the thing that passes the test.
/// </para>
/// </summary>
public sealed class Issue3869RefStructTranslationTests
{
    private const string RefStructSource = """
        using System;

        namespace Repro
        {
            public ref struct Issue2852ImportedRefStruct
            {
                public Span<int> Values { get; set; }
            }
        }
        """;

    /// <summary>
    /// The declaration keeps its <c>ref</c>: <c>ref struct Name { ... }</c>, the
    /// spelling <c>samples/UserRefStruct.gs</c> uses and gsc's aggregate-head
    /// parser accepts.
    /// </summary>
    [Fact]
    public void RefStruct_KeepsTheRefModifier()
    {
        string printed = Translate(RefStructSource);

        Assert.Contains("ref struct Issue2852ImportedRefStruct", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Anti-vacuity guard: a PLAIN C# struct must not acquire a <c>ref</c> it
    /// never had. Without this, "always emit ref" would pass the test above.
    /// </summary>
    [Fact]
    public void PlainStruct_DoesNotGainARefModifier()
    {
        string printed = Translate("""
            namespace Repro
            {
                public struct PlainPoint
                {
                    public int X { get; set; }
                }
            }
            """);

        Assert.Contains("struct PlainPoint", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ref struct PlainPoint", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A C# <c>class</c> is never by-ref-like, whatever it holds.
    /// </summary>
    [Fact]
    public void Class_DoesNotGainARefModifier()
    {
        string printed = Translate("""
            namespace Repro
            {
                public class Holder
                {
                    public int X { get; set; }
                }
            }
            """);

        Assert.DoesNotContain("ref class", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing proof of the whole #3869 chain. The translated G# is
    /// compiled by gsc into an executable that calls <c>GetExportedTypes()</c> on
    /// itself — exactly the call xunit's assembly-info shim makes during
    /// discovery. On <c>origin/main</c> (the <c>ref</c> dropped) the emitted type
    /// carried no <c>IsByRefLikeAttribute</c> and this program died with
    /// <c>System.TypeLoadException: A ByRef or ByRef-like type cannot be used as
    /// the type for an instance field in a non-ByRef-like type</c>. It must now
    /// load, enumerate, and exit 0 — and the metadata must actually carry the
    /// attribute, so a fix that merely stopped the crash some other way cannot
    /// pass.
    /// </summary>
    [Fact]
    public void TranslatedRefStruct_CarriesIsByRefLike_AndTheAssemblyTypeLoads()
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);

        string printed = Translate(RefStructSource);
        Assert.Contains("ref struct Issue2852ImportedRefStruct", printed, StringComparison.Ordinal);

        string workDir = NewDirectory("runtime");
        string sourcePath = Path.Combine(workDir, "Repro.gs");
        string outputPath = Path.Combine(workDir, "Repro.dll");
        File.WriteAllText(
            sourcePath,
            printed + Environment.NewLine +
            "System.Console.WriteLine(System.Reflection.Assembly.GetExecutingAssembly().GetExportedTypes().Length)" +
            Environment.NewLine);

        (int compileExit, string compileOutput) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{outputPath}\" \"{sourcePath}\"",
            workDir);
        Assert.True(
            compileExit == 0,
            "gsc must compile the translated `ref struct`. Output:\n" + compileOutput +
                "\nTranslated G#:\n" + printed);

        using (var pe = new PEReader(File.OpenRead(outputPath)))
        {
            MetadataReader metadata = pe.GetMetadataReader();
            TypeDefinition definition = metadata.TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single(candidate =>
                    metadata.GetString(candidate.Name) == "Issue2852ImportedRefStruct");

            Assert.Contains(
                definition.GetCustomAttributes()
                    .Select(metadata.GetCustomAttribute)
                    .Select(attribute => AttributeTypeName(metadata, attribute)),
                name => name == "IsByRefLikeAttribute");
        }

        // The load-bearing assertion: the CLR type loader, not the binder.
        (int runExit, string runOutput) = RunDotnet($"\"{outputPath}\"", workDir);
        Assert.True(
            runExit == 0,
            "The emitted assembly must type-load and enumerate its exported types " +
                "(this is the call xunit discovery makes). Output:\n" + runOutput);
        Assert.DoesNotContain("TypeLoadException", runOutput, StringComparison.Ordinal);
    }

    private static string AttributeTypeName(MetadataReader metadata, CustomAttribute attribute)
    {
        switch (attribute.Constructor.Kind)
        {
            case HandleKind.MemberReference:
                MemberReference member = metadata.GetMemberReference(
                    (MemberReferenceHandle)attribute.Constructor);
                return member.Parent.Kind == HandleKind.TypeReference
                    ? metadata.GetString(metadata.GetTypeReference((TypeReferenceHandle)member.Parent).Name)
                    : string.Empty;
            case HandleKind.MethodDefinition:
                MethodDefinition method = metadata.GetMethodDefinition(
                    (MethodDefinitionHandle)attribute.Constructor);
                return metadata.GetString(metadata.GetTypeDefinition(method.GetDeclaringType()).Name);
            default:
                return string.Empty;
        }
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        return string.Join(
            Environment.NewLine,
            project.Documents.Select(document =>
            {
                var context = new TranslationContext(
                    project.Compilation, document.SemanticModel, document.FilePath);
                CompilationUnit unit = translator.TranslateDocument(document, context);
                Assert.DoesNotContain(
                    context.Diagnostics,
                    diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
                return GSharpPrinter.Print(unit);
            }));
    }

    private static string NewDirectory(string category)
    {
        string path = Path.Combine(
            AppContext.BaseDirectory,
            "issue-3869-ref-struct",
            category,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static (int ExitCode, string Output) RunDotnet(string arguments, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        using Process process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }
}
