// <copyright file="Issue2643NamedGenericDelegateArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Runtime.Loader
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import System.Reflection

open class Issue2643NamedGenericDelegateArgumentEmitTests {
    @Fact
    func OahuConvertDelegateExactSites_RunAndVerify() {
        let output = CompileAndRun(`package App
import System
import Lib2643
import Lib2643.Models

class SimpleCancellation : ICancellation {
    let Name string
    init(name string) { this.Name = name }
}

class CliCancellation : ICancellation {
    let Name string
    init(name string) { this.Name = name }
}

func Main() {
    var mainWindowAction ((Book, SimpleCancellation, (Conversion) -> void) -> void)? = nil
    mainWindowAction = (book Book, ctx SimpleCancellation, callback (Conversion) -> void) -> {
        callback(Conversion("${book.Name}:${ctx.Name}:window"))
    }

    var audibleAction ((Book, CliCancellation, (Conversion) -> void) -> void)? = nil
    audibleAction = (book Book, ctx CliCancellation, callback (Conversion) -> void) -> {
        callback(Conversion("${book.Name}:${ctx.Name}:cli"))
    }

    let windowJob = DownloadDecryptJob[SimpleCancellation]()
    Console.WriteLine(windowJob.Run(SimpleCancellation("simple"), mainWindowAction!!))
    let cliJob = DownloadDecryptJob[CliCancellation]()
    Console.WriteLine(cliJob.Run(CliCancellation("linked"), audibleAction!!))
}`, "OahuConvertDelegateExactSites_RunAndVerify")
        Assert.Equal("book:simple:window${Environment.NewLine}book:linked:cli${Environment.NewLine}", output)
    }

    @Fact
    func GenericMethod_InfersNamedDelegateTypeArgumentFromStructuralFunction_RunAndVerify() {
        let output = CompileAndRun(`package App
import System
import Lib2643
import Lib2643.Models

class SimpleCancellation : ICancellation {}

func Main() {
    let convertAction (Book, SimpleCancellation, (Conversion) -> void) -> void =
        (book Book, ctx SimpleCancellation, callback (Conversion) -> void) -> {}
    Console.WriteLine(GenericRunner.Infer(convertAction))
}`, "GenericMethod_InfersNamedDelegateTypeArgumentFromStructuralFunction_RunAndVerify")
        Assert.Equal("SimpleCancellation${Environment.NewLine}", output)
    }

    @Fact
    func NamedDelegateValue_PreservesIdentityAcrossGenericCall_RunAndVerify() {
        let output = CompileAndRun(`package App
import System
import Lib2643

class SimpleCancellation : ICancellation {}

func Main() {
    let action = GenericRunner.Create[SimpleCancellation]()
    Console.WriteLine(GenericRunner.IsSame(action, action))
}`, "NamedDelegateValue_PreservesIdentityAcrossGenericCall_RunAndVerify")
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func StructurallyIncompatibleFunction_StillRejected() {
        let libraries = EmitCSharpLibraries("StructurallyIncompatibleFunction_StillRejected")
        using let resolver = ReferenceResolver.WithReferences([]string{libraries.ModelsPath, libraries.LibraryPath})
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package App
import Lib2643
import Lib2643.Models

class SimpleCancellation : ICancellation {}

func Main() {
    let bad (Book, SimpleCancellation, (int32) -> void) -> void =
        (book Book, ctx SimpleCancellation, callback (int32) -> void) -> {}
    let job = DownloadDecryptJob[SimpleCancellation]()
    job.Run(SimpleCancellation("simple"), bad)
}`)))
        using let stream = MemoryStream()
        let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2643.Negative")
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0159"
        )
    }

    shared {
        private func CompileAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2643Emit", caseName)
            Directory.CreateDirectory(directory)
            let libraries = EmitCSharpLibraries(caseName)
            let consumerPath = Path.Combine(directory, "Consumer.dll")
            using let resolver = ReferenceResolver.WithReferences([]string{libraries.ModelsPath, libraries.LibraryPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                using let stream = File.Create(consumerPath)
                let result = compilation.Emit(
                    stream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue2643." + caseName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraries.ModelsPath, libraries.LibraryPath})
            let context = AssemblyLoadContext("Issue2643." + caseName, isCollectible: true)
            try {
                context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> switch name.Name {
                    case "Lib2643": context.LoadFromAssemblyPath(libraries.LibraryPath)
                    case "Lib2643.Models": context.LoadFromAssemblyPath(libraries.ModelsPath)
                    default: default(Assembly?)
                }
                let assembly = context.LoadFromAssemblyPath(consumerPath)
                let output = Console.Out
                using let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    assembly.EntryPoint!!.Invoke(nil, nil)
                } finally {
                    Console.SetOut(output)
                }
                return captured.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                context.Unload()
            }
        }

        private func EmitCSharpLibraries(caseName string)(LibraryPath string, ModelsPath string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2643Emit", caseName)
            Directory.CreateDirectory(directory)
            let modelsPath = Path.Combine(directory, "Lib2643.Models.dll")
            let libraryPath = Path.Combine(directory, "Lib2643.dll")
            const modelsSource = `namespace Lib2643.Models
{
    public sealed class Book
    {
        public Book(string name) => Name = name;
        public string Name { get; }
    }
    public sealed class Conversion
    {
        public Conversion(string value) => Value = value;
        public string Value { get; }
    }
}`
            const source = `using System;
using Lib2643.Models;

namespace Lib2643
{
    public interface ICancellation { }
    public delegate void ConvertDelegate<T>(
        Book book,
        T context,
        Action<Conversion> callback)
        where T : ICancellation;

    public sealed class DownloadDecryptJob<T> where T : ICancellation
    {
        public string Run(T context, ConvertDelegate<T> convertAction)
        {
            string result = null;
            convertAction(new Book("book"), context, conversion => result = conversion.Value);
            return result;
        }
    }

    public static class GenericRunner
    {
        public static string Infer<T>(ConvertDelegate<T> action) where T : ICancellation => typeof(T).Name;

        public static ConvertDelegate<T> Create<T>() where T : ICancellation => (_, _, _) => { };

        public static bool IsSame<T>(ConvertDelegate<T> expected, ConvertDelegate<T> actual)
            where T : ICancellation
            => ReferenceEquals(expected, actual);
    }
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToArray()
            let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            let modelsCompilation = CSharpCompilation.Create(
                "Lib2643.Models",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(modelsSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                options
            )
            {
                using let stream = File.Create(modelsPath)
                let result = modelsCompilation.Emit(stream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            let compilation = CSharpCompilation.Create(
                "Lib2643",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references.Append(MetadataReference.CreateFromFile(modelsPath)),
                options
            )
            using let libraryStream = File.Create(libraryPath)
            let libraryResult = compilation.Emit(libraryStream)
            Assert.True(libraryResult.Success, string.Join(Environment.NewLine, libraryResult.Diagnostics))
            return (libraryPath, modelsPath)
        }
    }
}
