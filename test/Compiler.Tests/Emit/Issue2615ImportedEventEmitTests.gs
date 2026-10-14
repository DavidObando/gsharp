// <copyright file="Issue2615ImportedEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.ComponentModel
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2615: imported inherited events participate in access, binding, and emit.
class Issue2615ImportedEventEmitTests {
    @Fact
    func ImportedInheritedPropertyChanged_AddRemove_Runs() {
        using let artifacts = Compile(OahuSource)
        // One context for the reference fixture and the emitted assembly
        // that imports it.
        let assembly = EmittedFixture.LoadTogether(artifacts.FixturePath, artifacts.OutputPath)[1]
        let probeType Type? = assembly.GetType("Oahu.Core.UI.Avalonia.ViewModels.Probe")
        let probe object? = Activator.CreateInstance(probeType!!)
        Assert.Equal(1, probeType!!.GetMethod("Run")!!.Invoke(probe, nil))
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: []string{artifacts.FixturePath})
    }

    @Fact
    func ImportedInheritedPropertyChanged_EmitsAddAndRemoveMemberReferences() {
        using let artifacts = Compile(OahuSource)
        using let stream = File.OpenRead(artifacts.OutputPath)
        using let peReader = PEReader(stream)
        let reader = peReader.GetMetadataReader()
        let memberNames = reader
            .MemberReferences
            .Select((handle MemberReferenceHandle) -> reader.GetString(reader.GetMemberReference(handle).Name))
            .ToHashSet(StringComparer.Ordinal)
        Assert.Contains("add_PropertyChanged", memberNames)
        Assert.Contains("remove_PropertyChanged", memberNames)
    }

    @Fact
    func MissingImportedInheritedEvent_RemainsGS0158() {
        let source = OahuSource.Replace(
            "vm.PropertyChanged += OnPropertyChanged",
            "vm.Missing += OnPropertyChanged",
            StringComparison.Ordinal
        )
        using let artifacts = Compile(source, expectSuccess: false)
        Assert.NotEqual(0, artifacts.ExitCode)
        Assert.Contains("GS0158", artifacts.Diagnostics, StringComparison.Ordinal)
        Assert.Contains("Cannot find member Missing", artifacts.Diagnostics, StringComparison.Ordinal)
    }

    private class CompilationArtifacts : IDisposable {
        init(directory string, fixturePath string, outputPath string, exitCode int32, diagnostics string) {
            Directory = directory
            FixturePath = fixturePath
            OutputPath = outputPath
            ExitCode = exitCode
            Diagnostics = diagnostics
        }

        prop Directory string {
            get;
        }

        prop FixturePath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Diagnostics string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private const FixtureSource string = `using System.ComponentModel;

namespace OahuFixture;

public class ObservableObject : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    public void Raise(string name) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}`

        private const OahuSource string = `package Oahu.Core.UI.Avalonia.ViewModels

import System
import System.ComponentModel
import OahuFixture

class BookItemViewModel : ObservableObject { }

class Probe {
    var Hits int32

    init() {
        Hits = 0
    }

    func OnPropertyChanged(sender Object, e PropertyChangedEventArgs) {
        Hits = Hits + 1
    }

    func Run() int32 {
        let vm = BookItemViewModel()
        vm.PropertyChanged += OnPropertyChanged
        vm.Raise("IsSelected")
        vm.PropertyChanged -= OnPropertyChanged
        vm.Raise("Ignored")
        return Hits
    }
}`

        private func Compile(source string, expectSuccess bool = true) Issue2615ImportedEventEmitTests
            .CompilationArtifacts {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2615-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let fixturePath = Path.Combine(directory, "OahuFixture.dll")
            EmitFixture(fixturePath)
            let sourcePath = Path.Combine(directory, "BookLibraryViewModel.gs")
            let outputPath = Path.Combine(directory, "Oahu.UI.dll")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/r:" + fixturePath,
                    "/nowarn:GS9100",
                    sourcePath
                }
            )
            if expectSuccess {
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            }
            return Issue2615ImportedEventEmitTests.CompilationArtifacts(
                directory,
                fixturePath,
                outputPath,
                exitCode,
                stdout + stderr
            )
        }

        private func EmitFixture(path string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "OahuFixture",
                []SyntaxTree{CSharpSyntaxTree.ParseText(FixtureSource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
