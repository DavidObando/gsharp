// <copyright file="ObliviousPromotionSinkCompilationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

open class ObliviousPromotionSinkCompilationTests {
    @Fact
    func ObliviousPromotion_SinksCompileWithGsc() {
        let printed = TranslateOblivious(`
namespace Demo
{
    using System.Collections.Generic;

    public interface INode
    {
        string Name { get; }
    }

    public class Node : INode
    {
        public string Name { get; set; }

        public void Clear()
        {
            Name = null;
        }
    }

    public class Box
    {
        public string Text;
        public string[] Items;
    }

    public class Target
    {
        public string Field;
    }

    public class Cases
    {
        public string ViaConcrete(Node node)
        {
            if (node.Name == null) { return "missing"; }
            return node.Name;
        }

        public string ViaInterface(INode node)
        {
            if (node.Name == null) { return "missing"; }
            return node.Name;
        }

        public string VarNullCompare(string input)
        {
            var x = input;
            if (x == null) { return "missing"; }
            return x;
        }

        public T Generic<T>(T value) where T : class
        {
            T local = value;
            if (value == null) { local = null; }
            return local;
        }

        public void Sinks(Box box, string[] array, Dictionary<string, string> dict)
        {
            array[0] = box?.Text;
            array[1] = box.Items?[0];
            dict["k"] = box?.Text;
            var target = new Target { Field = box?.Text };
        }

        public string Pick(int i)
        {
            return i switch
            {
                0 => "zero",
                _ => null,
            };
        }

        public (string Action, string Method, Dictionary<string, string> Inputs) Parse(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return (null, null, null);
            }

            return ("/login", "POST", new Dictionary<string, string>());
        }
    }
}`)
        Assert.Contains("Name string?", printed)
        Assert.Contains("if x == nil", printed)
        Assert.Contains("Generic[T class](value T?) T?", printed)
        Assert.Contains("array[0] = box?.Text!!", printed)
        Assert.Contains("array[1]", printed)
        Assert.Contains("dict[\"k\"] = box?.Text!!", printed)
        Assert.Contains("Field:", printed)
        Assert.Contains("default(string?)", printed)
        Assert.Contains(
            "Parse(text string) (Action string?, Method string?, Inputs Dictionary[string, string]?)",
            printed
        )
        CompileWithGsc(printed)
    }

    @Fact
    func ObliviousPromotion_DisabledForNullableEnabledCompilation() {
        let printed = TranslateEnabled(`
#nullable enable
namespace Demo
{
    public class C
    {
        public string Keep(string input)
        {
            var x = input;
            return x;
        }
    }
}`)
        Assert.DoesNotContain("string?", printed)
    }

    @Fact
    func TupleElementPromotion_ScalarCallSinksCompileWithGsc() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public delegate int Counter(string value);

    public sealed class Box
    {
        public Box(string value)
        {
        }
    }

    public sealed class Lookup
    {
        public int this[string key] => 1;
    }

    public static class Repro
    {
        public static int Run(bool missing, Counter counter, Lookup lookup)
        {
            var result = Gather(missing);
            var value = result.Payload.Maybe;
            var box = new Box(result.Payload.Maybe);
            return Count(value) + counter(result.Payload.Maybe) + lookup[result.Payload.Maybe];
        }

        private static ((string Keep, string Maybe) Payload, int Count) Gather(bool missing)
        {
            if (missing)
                return (("keep", null), 0);

            return (("keep", "value"), 1);
        }

        private static int Count(string value)
        {
            if (value is null)
                return 0;

            return value.Length;
        }
    }
}`)
        Assert.Contains("delegate Counter(value string?) int32;", printed)
        Assert.Contains("init(value string?)", printed)
        Assert.Contains("prop this[key string?] int32", printed)
        Assert.Contains("func Count(value string?) int32", printed)
        CompileWithGsc(printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CompileWithGsc(printed string) {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "oblivious-promotion", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed)
            let (exit, output) = RunDotnet("\"$compiler\" /target:library /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                exit == 0 && !output.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile translated snippet with zero errors. Output:\n" + output + `

Translated G#:
` + printed
            )
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
