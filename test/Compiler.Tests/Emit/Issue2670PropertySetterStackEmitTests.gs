// <copyright file="Issue2670PropertySetterStackEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2670: nested symbolic generic types stay exact in property setters.
class Issue2670PropertySetterStackEmitTests {
    @Fact
    func ExactUiSetters_RunAndIlVerify() {
        const source = `package Oahu.Core.UI.Avalonia.ViewModels

import System
import System.Collections.Generic
import System.Collections.ObjectModel

class ConversionItemViewModel {}
class BookItemViewModel {}

class ConversionViewModel {
    var conversions ObservableCollection[ConversionItemViewModel] = ObservableCollection[ConversionItemViewModel]()

    prop Conversions ObservableCollection[ConversionItemViewModel] {
        get -> conversions
        set {
            if !EqualityComparer[ObservableCollection[ConversionItemViewModel]].Default.Equals(conversions, value) {
                conversions = value
            }
        }
    }
}

class BookLibraryViewModel {
    var books ObservableCollection[BookItemViewModel] = ObservableCollection[BookItemViewModel]()

    prop Books ObservableCollection[BookItemViewModel] {
        get -> books
        set {
            if !EqualityComparer[ObservableCollection[BookItemViewModel]].Default.Equals(books, value) {
                books = value
            }
        }
    }
}

func Main() {
    let conversion = ConversionViewModel()
    let conversions = ObservableCollection[ConversionItemViewModel]()
    conversions.Add(ConversionItemViewModel())
    conversion.Conversions = conversions
    Console.WriteLine(conversion.Conversions.Count)

    let library = BookLibraryViewModel()
    let books = ObservableCollection[BookItemViewModel]()
    books.Add(BookItemViewModel())
    library.Books = books
    Console.WriteLine(library.Books.Count)
}`
        using let result = Compile(source)
        Assert.Equal("1${Environment.NewLine}1${Environment.NewLine}", Run(result.OutputPath))
        let loadContext = AssemblyLoadContext("Issue2670-" + Guid.NewGuid().ToString(), isCollectible: true)
        try {
            using let stream = File.OpenRead(result.OutputPath)
            let assembly = loadContext.LoadFromStream(stream)
            AssertSetterType(
                assembly,
                "Oahu.Core.UI.Avalonia.ViewModels.ConversionViewModel",
                "Conversions",
                "Oahu.Core.UI.Avalonia.ViewModels.ConversionItemViewModel"
            )
            AssertSetterType(
                assembly,
                "Oahu.Core.UI.Avalonia.ViewModels.BookLibraryViewModel",
                "Books",
                "Oahu.Core.UI.Avalonia.ViewModels.BookItemViewModel"
            )
        } finally {
            loadContext.Unload()
        }
        IlVerifier.Verify(result.OutputPath)
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch {
                // Best effort cleanup on Windows where loaded assemblies may remain locked.

            }
        }
    }

    shared {
        private func AssertSetterType(
            assembly Assembly,
            containingTypeName string,
            propertyName string,
            elementTypeName string
        ) {
            let setter = assembly.GetType(containingTypeName, throwOnError: true)!!.GetProperty(
                propertyName
            )!!.SetMethod!!
            Assert.Equal("set_" + propertyName, setter.Name)
            let collectionType = Assert.Single(setter.GetParameters()).ParameterType
            Assert.Equal(
                typeof(System.Collections.ObjectModel.ObservableCollection[_]),
                collectionType.GetGenericTypeDefinition()
            )
            Assert.Equal(elementTypeName, Assert.Single(collectionType.GetGenericArguments()).FullName)
        }

        private func Compile(source string) Issue2670PropertySetterStackEmitTests.CompilationResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2670-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "ViewModels.gs")
            let outputPath = Path.Combine(directory, "Oahu.UI.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
            args.AddRange(TrustedPlatformAssemblies().Select((path string) -> ("/reference:" + path)))
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
            Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Issue2670PropertySetterStackEmitTests.CompilationResult(directory, outputPath)
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
