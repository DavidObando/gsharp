// <copyright file="Issue5936ParamsArrayBoundaryTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Runtime.Loader
import System.Text
import Xunit

/// On 36d50e65c, the emitted library returns true when an external C# caller passes a null params array.
class Issue5936ParamsArrayBoundaryTests {
    @Fact
    func ExternalCSharpCaller_PreservesExplicitNullParamsValidation() {
        const source = `#nullable enable
using System;
namespace Boundary;
public static class Gate
{
    private static Action? clear;
    public static bool Authorize(params string[] credentials) => credentials != null!;
    public static bool Raw(params string[] credentials) => credentials != null;
    public static bool Missing(params string[] credentials) => credentials == null;
    public static bool NullPattern(params string[] credentials) => credentials is null;
    public static bool NotNullPattern(params string[] credentials) => credentials is not null;
    public static bool AnyObject(params string[] credentials) => credentials is {};
    public static bool Switch(params string[] credentials) => credentials switch { { Length: > 0 } => true, {} => true, _ => false };
    public static bool CapturedFact(params string[] credentials)
    {
        string? text = null;
        clear = () => text = null;
        text = "ok";
        bool authorized = credentials != null!;
        return (text?[0]).HasValue && authorized;
    }
    public static bool ReferenceRegion(params string[] credentials)
    {
        string? text = null;
        ref string? alias = ref text;
        text = "ok";
        bool authorized = false;
        for (int i = 0; i < 1; i++)
        {
            authorized = credentials != null!;
            authorized = (text?[0]).HasValue && authorized;
        }
        return authorized;
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Boundary.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let native = MemoryStream()
        let emitted = project.Compilation.WithAssemblyName("ParamsBoundary").Emit(native)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        let directory = Path.Combine(AppContext.BaseDirectory, "params-boundary", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let input = Path.Combine(directory, "Boundary.gs")
            let output = Path.Combine(directory, "ParamsBoundary.dll")
            File.WriteAllText(input, printed)
            let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.NotNull(compiler)
            let result = GscInvoker(compiler!!).Compile(
                []string{input},
                output,
                TargetKind.Library,
                Array.Empty[string]()
            )
            Assert.True(result.Succeeded, result.Output + "\n" + printed)
            Assert.DoesNotContain("GS0523", result.Output)
            Assert.DoesNotContain("GS0300", result.Output)
            let expected = Encoding.UTF8.GetBytes(
                "False:False:True:True:False:False:False:False:False|True:True:False:False:True:True:True:True:True|True:True:False:False:True:True:True:True:True\n"
            )
            let nativeBytes = RunCSharpConsumer(native.ToArray())
            Assert.Equal(expected, nativeBytes)
            Assert.Equal(nativeBytes, RunCSharpConsumer(File.ReadAllBytes(output)))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func RunCSharpConsumer(library[]byte)[]byte {
            const consumer = `#nullable enable
using System;
using Boundary;
public static class Consumer
{
    private static string Describe(string[] values) =>
        Gate.Authorize(values) + ":" + Gate.Raw(values) + ":" + Gate.Missing(values) + ":" +
        Gate.NullPattern(values) + ":" + Gate.NotNullPattern(values) + ":" + Gate.AnyObject(values) + ":" +
        Gate.Switch(values) + ":" + Gate.CapturedFact(values) + ":" + Gate.ReferenceRegion(values);
    public static string Run() =>
        Gate.Authorize((string[])null!) + ":" + Gate.Raw((string[])null!) + ":" +
        Gate.Missing((string[])null!) + ":" + Gate.NullPattern((string[])null!) + ":" +
        Gate.NotNullPattern((string[])null!) + ":" + Gate.AnyObject((string[])null!) + ":" +
        Gate.Switch((string[])null!) + ":" + Gate.CapturedFact((string[])null!) + ":" +
        Gate.ReferenceRegion((string[])null!) + "|" +
        Describe(Array.Empty<string>()) + "|" + Describe(new[] { "ok" });
}`
            let name = "ParamsConsumer" + Guid.NewGuid().ToString("N")
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(consumer)},
                CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(library)),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let image = MemoryStream()
            let emitted = compilation.Emit(image)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loader = AssemblyLoadContext(name, isCollectible: true)
            try {
                using let libraryStream = MemoryStream(library)
                loader.LoadFromStream(libraryStream)
                image.Position = 0
                let assembly = loader.LoadFromStream(image)
                let value = Assert.IsType[string](
                    assembly.GetType("Consumer", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
                )
                return Encoding.UTF8.GetBytes(value + "\n")
            } finally {
                loader.Unload()
            }
        }
    }
}
