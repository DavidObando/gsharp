// <copyright file="Issue2617ImportedGenericStaticExplicitTypeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2617: explicit type arguments on imported generic static methods must
/// participate in overload resolution and satisfy constraints symbolically.
class Issue2617ImportedGenericStaticExplicitTypeArgumentTests {
    @Theory
    @InlineData("Oahu.App", "UserSettings")
    @InlineData("Oahu.Cli.App", "OahuUserSettings")
    func ExactOahuCall_CrossAssembly_BindsAndRuns(packageName string, settingsType string) {
        let source = (`package ` + "$packageName" + `
import System
import Oahu.Aux

class ` + "$settingsType" + ` : IUserSettings {}

func Main() {
    var settings = SettingsManager.GetUserSettings[` + "$settingsType" + `]()
    Console.WriteLine(settings.GetType().Name)
}`)
        using let result = Compile(source, target: "exe")
        Assert.DoesNotContain("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal)
        Assert.Equal(
            "default:$settingsType${Environment.NewLine}$settingsType${Environment.NewLine}",
            Run(result.OutputPath)
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath})
    }

    @Fact
    func ExplicitTypeArgument_StillSelectsApplicableOverload() {
        const source = `package Oahu.Overloads
import System
import Oahu.Aux

class UserSettings : IUserSettings {}

func Main() {
    var settings = SettingsManager.GetUserSettings[UserSettings]("custom.json")
    Console.WriteLine(settings.GetType().Name)
}`
        using let result = Compile(source, target: "exe")
        Assert.Equal("file:custom.json${Environment.NewLine}UserSettings${Environment.NewLine}", Run(result.OutputPath))
    }

    @Fact
    func ExplicitTypeArgument_ThatViolatesImportedInterfaceConstraint_IsRejected() {
        const source = `package Oahu.Negative
import Oahu.Aux

class NotUserSettings {}

func Bad() NotUserSettings ->
    SettingsManager.GetUserSettings[NotUserSettings]()`
        using let result = Compile(source, target: "library", expectSuccess: false)
        Assert.Contains("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitTypeArgument_ThatViolatesImportedConstructorConstraint_IsRejected() {
        const source = `package Oahu.Negative
import Oahu.Aux

class UserSettings(value int32) : IUserSettings {}

func Bad() UserSettings ->
    SettingsManager.GetUserSettings[UserSettings]()`
        using let result = Compile(source, target: "library", expectSuccess: false)
        Assert.Contains("GS0159", result.Stdout + result.Stderr, StringComparison.Ordinal)
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string, contractsPath string, stdout string, stderr string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
            ContractsPath = contractsPath
            Stdout = stdout
            Stderr = stderr
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ContractsPath string {
            get;
        }

        prop Stdout string {
            get;
        }

        prop Stderr string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch { }
        }
    }

    shared {
        private const ContractsSource string = `#nullable enable
using System;

namespace Oahu.Aux
{
    public interface IUserSettings { }

    public static class SettingsManager
    {
        public static T GetUserSettings<T>(bool renew = false, string? settingsFile = null)
            where T : class, IUserSettings, new()
        {
            Console.WriteLine("default:" + typeof(T).Name);
            return new T();
        }

        public static T GetUserSettings<T>(string settingsFile, bool renew = false)
            where T : class, IUserSettings, new()
        {
            Console.WriteLine("file:" + settingsFile);
            return new T();
        }
    }
}`

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                return TrustedPlatformAssemblies().ToArray()
            }
        )

        private func Compile(
            source string,
            target string,
            expectSuccess bool = true
        ) Issue2617ImportedGenericStaticExplicitTypeArgumentTests
            .CompilationResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2617-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let contractsPath = EmitContracts(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/reference:" + contractsPath
            }
            args.AddRange(BclReferences.Value.Select((path string) -> ("/reference:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            if expectSuccess {
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            } else {
                Assert.NotEqual(0, exitCode)
            }
            return Issue2617ImportedGenericStaticExplicitTypeArgumentTests.CompilationResult(
                directory,
                outputPath,
                contractsPath,
                stdout.ToString(),
                stderr.ToString()
            )
        }

        private func EmitContracts(directory string) string {
            let outputPath = Path.Combine(directory, "Oahu.Aux.dll")
            let compilation = CSharpCompilation.Create(
                "Oahu.Aux",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ContractsSource, CSharpParseOptions(LanguageVersion.Latest))},
                BclReferences.Value.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                cast[IEnumerable[string]](value!!.Split(Path.PathSeparator))
            }
        }
    }
}
