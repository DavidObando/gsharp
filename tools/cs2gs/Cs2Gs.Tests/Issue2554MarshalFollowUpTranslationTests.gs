// <copyright file="Issue2554MarshalFollowUpTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import MetadataParameter = System.Reflection.Metadata.Parameter
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import System.Text
import System.Threading.Tasks
import Xunit

/// Cycle-three coverage for issue #2554: C#'s implicit four-byte P/Invoke bool
/// contract must become explicit when translated to G#.
class Issue2554MarshalFollowUpTranslationTests {
    @Fact
    async func ProjectBacked_SystemParametersInfo_RefBool_GainsCanonicalMarshalAs() {
        let projectDir = NewDirectory("project")
        let projectPath = Path.Combine(projectDir, "Repro.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDir, "NativeMethods.cs"), `using System.Runtime.InteropServices;

internal static class NativeMethods
{
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SystemParametersInfo(
        uint action,
        uint parameter,
        ref bool value,
        uint flags);
}`)
        let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
        Assert.True(
            project.BoundWithoutErrors,
            "Project should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let printed = Translate(project)
        Assert.Contains(
            "@System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool) ref value bool",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func CSharpMetadata_DefaultRefBool_OmitsDescriptor() {
        let project = Load(`using System.Runtime.InteropServices;

internal static class NativeMethods
{
    [DllImport("libc", EntryPoint = "rand_r")]
    internal static extern int Rand(ref bool seed);
}`)
        using let peStream = MemoryStream()
        let emit = project.Compilation.Emit(peStream)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        peStream.Position = 0
        using let pe = PEReader(peStream)
        let metadata = pe.GetMetadataReader()
        let method = metadata
            .MethodDefinitions
            .Select(metadata.GetMethodDefinition)
            .Single((candidate MethodDefinition) -> metadata.GetString(candidate.Name) == "Rand")
        let parameter = method
            .GetParameters()
            .Select(metadata.GetParameter)
            .Single((candidate MetadataParameter) -> metadata.GetString(candidate.Name) == "seed")
        Assert.True((method.Attributes & MethodAttributes.PinvokeImpl) != 0)
        Assert.Contains(uint8(SignatureTypeCode.ByReference), metadata.GetBlobBytes(method.Signature))
        Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) == 0)
        Assert.True(parameter.GetMarshallingDescriptor().IsNil)
    }

    @Fact
    func ExplicitMarshalAs_IsPreserved() {
        let printed = Translate(Load(`using System.Runtime.InteropServices;

internal static class NativeMethods
{
    [DllImport("libc")]
    internal static extern int Read([MarshalAs(UnmanagedType.I1)] ref bool value);
}`))
        Assert.Contains("@MarshalAs(UnmanagedType.I1) ref value bool", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("UnmanagedType.Bool", printed, StringComparison.Ordinal)
    }

    @Fact
    func TranslatedDefaultRefBool_EmitsDescriptor_AndWritesBack() {
        if !RuntimeInformation.IsOSPlatform(OSPlatform.Linux) && !RuntimeInformation.IsOSPlatform(OSPlatform.OSX) {
            return
        }
        let printed = Translate(Load(`using System;
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
}`))
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let workDir = NewDirectory("runtime")
        let sourcePath = Path.Combine(workDir, "Repro.gs")
        let outputPath = Path.Combine(workDir, "Repro.dll")
        File.WriteAllText(sourcePath, printed + Environment.NewLine + "NativeMethods.Run()" + Environment.NewLine)
        let (compileExit, compileOutput) = RunDotnet("\"$compiler\" /target:exe /out:\"$outputPath\" \"$sourcePath\"")
        Assert.True(compileExit == 0, "gsc must compile the translated P/Invoke. Output:\n" + compileOutput + `
Translated G#:
` + printed)
        {
            using let pe = PEReader(File.OpenRead(outputPath))
            let metadata = pe.GetMetadataReader()
            let method = metadata
                .MethodDefinitions
                .Select(metadata.GetMethodDefinition)
                .Single((candidate MethodDefinition) -> metadata.GetString(candidate.Name) == "Rand")
            let parameter = method
                .GetParameters()
                .Select(metadata.GetParameter)
                .Single((candidate MetadataParameter) -> metadata.GetString(candidate.Name) == "seed")
            Assert.True((parameter.Attributes & ParameterAttributes.HasFieldMarshal) != 0)
            Assert.Equal(
                []uint8{uint8(UnmanagedType.Bool)},
                metadata.GetBlobBytes(parameter.GetMarshallingDescriptor())
            )
        }
        let (runExit, runOutput) = RunDotnet("\"$outputPath\"")
        Assert.True(runExit == 0, "Translated program must run successfully. Output:\n" + runOutput)
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}",
            runOutput.ReplaceLineEndings(Environment.NewLine)
        )
    }

    shared {
        private func Load(source string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Repro.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            return project
        }

        private func Translate(project LoadedCSharpProject) string {
            let translator = CSharpToGSharpTranslator()
            return string.Join(
                Environment.NewLine,
                project.Documents.Select(
                    (document LoadedDocument) -> {
                        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                        let unit = translator.TranslateDocument(document, context)
                        Assert.DoesNotContain(
                            context.Diagnostics,
                            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                        )
                        return GSharpPrinter.Print(unit)
                    }
                )
            )
        }

        private func NewDirectory(category string) string {
            let path = Path.Combine(
                AppContext.BaseDirectory,
                "issue-2554-follow-up",
                category,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(path)
            return path
        }

        private func RunDotnet(arguments string)(ExitCode int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
