// <copyright file="Issue2554MarshalFollowUpTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Cycle-three coverage for issue #2554: C#'s implicit four-byte P/Invoke bool
/// contract must become explicit when translated to G#.
/// </summary>
public sealed class Issue2554MarshalFollowUpTranslationTests
{
    [Fact]
    public async Task ProjectBacked_SystemParametersInfo_RefBool_GainsCanonicalMarshalAs()
    {
        string projectDir = NewDirectory("project");
        string projectPath = Path.Combine(projectDir, "Repro.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(projectDir, "NativeMethods.cs"), """
            using System.Runtime.InteropServices;

            internal static class NativeMethods
            {
                [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
                [return: MarshalAs(UnmanagedType.Bool)]
                internal static extern bool SystemParametersInfo(
                    uint action,
                    uint parameter,
                    ref bool value,
                    uint flags);
            }
            """);

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);
        Assert.True(
            project.BoundWithoutErrors,
            "Project should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        string printed = Translate(project);
        Assert.Contains(
            "@System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool) ref value bool",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CSharpMetadata_DefaultRefBool_OmitsDescriptor()
    {
        LoadedCSharpProject project = Load("""
            using System.Runtime.InteropServices;

            internal static class NativeMethods
            {
                [DllImport("libc", EntryPoint = "rand_r")]
                internal static extern int Rand(ref bool seed);
            }
            """);

        using var peStream = new MemoryStream();
        var emit = project.Compilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;

        using var pe = new PEReader(peStream);
        MetadataReader metadata = pe.GetMetadataReader();
        MethodDefinition method = metadata.MethodDefinitions
            .Select(metadata.GetMethodDefinition)
            .Single(candidate => metadata.GetString(candidate.Name) == "Rand");
        System.Reflection.Metadata.Parameter parameter = method.GetParameters()
            .Select(metadata.GetParameter)
            .Single(candidate => metadata.GetString(candidate.Name) == "seed");

        Assert.True((method.Attributes & MethodAttributes.PinvokeImpl) != 0);
        Assert.Contains((byte)SignatureTypeCode.ByReference, metadata.GetBlobBytes(method.Signature));
        Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) == 0);
        Assert.True(parameter.GetMarshallingDescriptor().IsNil);
    }

    [Fact]
    public void ExplicitMarshalAs_IsPreserved()
    {
        string printed = Translate(Load("""
            using System.Runtime.InteropServices;

            internal static class NativeMethods
            {
                [DllImport("libc")]
                internal static extern int Read([MarshalAs(UnmanagedType.I1)] ref bool value);
            }
            """));

        Assert.Contains("@MarshalAs(UnmanagedType.I1) ref value bool", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("UnmanagedType.Bool", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TranslatedDefaultRefBool_EmitsDescriptor_AndWritesBack()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
            && !RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return;
        }

        string printed = Translate(Load("""
            using System;
            using System.Runtime.InteropServices;

            internal static class NativeMethods
            {
                [DllImport("libc", EntryPoint = "rand_r")]
                private static extern int Rand(ref bool seed);

                internal static void Run()
                {
                    bool seed = false;
                    int result = Rand(ref seed);
                    Console.WriteLine(result != 0);
                    Console.WriteLine(seed);
                }
            }
            """));

        string compiler = FindCompiler();
        Assert.NotNull(compiler);
        string workDir = NewDirectory("runtime");
        string sourcePath = Path.Combine(workDir, "Repro.gs");
        string outputPath = Path.Combine(workDir, "Repro.dll");
        File.WriteAllText(sourcePath, printed + Environment.NewLine + "NativeMethods.Run()" + Environment.NewLine);

        (int compileExit, string compileOutput) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{outputPath}\" \"{sourcePath}\"");
        Assert.True(
            compileExit == 0,
            "gsc must compile the translated P/Invoke. Output:\n" + compileOutput +
                "\nTranslated G#:\n" + printed);

        using (var pe = new PEReader(File.OpenRead(outputPath)))
        {
            MetadataReader metadata = pe.GetMetadataReader();
            MethodDefinition method = metadata.MethodDefinitions
                .Select(metadata.GetMethodDefinition)
                .Single(candidate => metadata.GetString(candidate.Name) == "Rand");
            System.Reflection.Metadata.Parameter parameter = method.GetParameters()
                .Select(metadata.GetParameter)
                .Single(candidate => metadata.GetString(candidate.Name) == "seed");

            Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) != 0);
            Assert.Equal(
                new[] { (byte)UnmanagedType.Bool },
                metadata.GetBlobBytes(parameter.GetMarshallingDescriptor()));
        }

        (int runExit, string runOutput) = RunDotnet($"\"{outputPath}\"");
        Assert.True(runExit == 0, "Translated program must run successfully. Output:\n" + runOutput);
        Assert.Equal("True\nTrue\n", runOutput.Replace("\r\n", "\n"));
    }

    private static LoadedCSharpProject Load(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static string Translate(LoadedCSharpProject project)
    {
        var translator = new CSharpToGSharpTranslator();
        return string.Join(
            Environment.NewLine,
            project.Documents.Select(document =>
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
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
            "issue-2554-follow-up",
            category,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static (int ExitCode, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
