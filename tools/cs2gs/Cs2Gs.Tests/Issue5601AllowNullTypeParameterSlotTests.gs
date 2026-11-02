// <copyright file="Issue5601AllowNullTypeParameterSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #5601: an `[AllowNull]` field or property typed by a type parameter that is not
/// constrained to a class. The producer emits the slot `Value T` (#3694 widens only a reference
/// type), so `Box[Node].Value` does not accept `nil`, and a maybe-null value stored into it needs
/// the bridge that any maybe-null value into a non-null slot gets. In one project the promotion
/// query read the substituted type `Node` of `Box<Node>.Value`, answered that the slot was widened,
/// and left the store unbridged (gsc GS0155). The query now reads the original declaration, as the
/// producer does and as the query for a slot seen through an emitted reference (#5577) does.
/// @remarks Mutation witnesses (ADR-0154) are in the PR body.
open class Issue5601AllowNullTypeParameterSlotTests {
    /// A maybe-null value stored into `Box<Node>.Value` or `Box<Node>.Prop` keeps its bridge, in one
    /// project and through the producer's emitted reference, and the translation compiles and runs.
    /// A read of the slot needs no `!!`.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func AnAllowNullSlotOfAnUnconstrainedTypeParameter_KeepsItsBridge(throughReference bool) {
        let (libraryPrinted, appPrinted) = Translate(throughReference, UnconstrainedBoxSource)
        Assert.Contains("var Value T", libraryPrinted)
        Assert.Contains("prop Prop T", libraryPrinted)
        Assert.DoesNotContain("T?", libraryPrinted)
        Assert.Contains("b.Value = m!!", appPrinted)
        Assert.Contains("b.Prop = m!!", appPrinted)
        Assert.Contains("b.Value.Name", appPrinted)
        Assert.Equal("node node", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    /// The control: with `where T : class` the producer widens the slot to `T?` (#3694), so the
    /// maybe-null value is stored without a bridge and the translation stores the null as C# does.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func AnAllowNullSlotOfAClassConstrainedTypeParameter_TakesTheNull(throughReference bool) {
        let (libraryPrinted, appPrinted) = Translate(
            throughReference,
            UnconstrainedBoxSource.Replace("public class Box<T>", "public class Box<T> where T : class")
        )
        Assert.Contains("var Value T?", libraryPrinted)
        Assert.Contains("prop Prop T?", libraryPrinted)
        Assert.DoesNotContain("m!!", appPrinted)
        Assert.Equal("null null", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.RunNull()").Trim())
    }

    /// The control: a slot typed by `T` without `[AllowNull]` stays `T`, and a maybe-null value stored
    /// into it keeps its bridge.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ASlotOfATypeParameterWithoutAllowNull_KeepsItsBridge(throughReference bool) {
        let (libraryPrinted, appPrinted) = Translate(
            throughReference,
            UnconstrainedBoxSource.Replace("[AllowNull] ", "")
        )
        Assert.DoesNotContain("T?", libraryPrinted)
        Assert.Contains("b.Value = m!!", appPrinted)
        Assert.Contains("b.Prop = m!!", appPrinted)
        Assert.Equal("node node", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    shared {
        private const UnconstrainedBoxSource string = `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { public string Name => "node"; }
    public class Box<T>
    {
        public Box(T value) { Value = value; Prop = value; }
        [AllowNull] public T Value;
        [AllowNull] public T Prop { get; set; }
    }
}`

        private const UseSource string = `
namespace Demo.App
{
    public static class Use
    {
        public static void Put(Box<Node> b, Node? m) { b.Value = m; }
        public static void PutProp(Box<Node> b, Node? m) { b.Prop = m; }
        public static string Read(Box<Node> b) => b.Value.Name;

        public static string Run()
        {
            var b = new Box<Node>(new Node());
            Put(b, new Node());
            PutProp(b, new Node());
            return Read(b) + " " + (b.Prop == null ? "null" : "node");
        }

        public static string RunNull()
        {
            var b = new Box<Node>(new Node());
            Put(b, null);
            PutProp(b, null);
            return (b.Value == null ? "null" : "node") + " " + (b.Prop == null ? "null" : "node");
        }
    }
}`

        // Translates the producer and the consumer, in one project or in two where the consumer
        // binds the producer through its emitted reference.
        private func Translate(throughReference bool, librarySource string)(Library string, App string) {
            let library = if throughReference {
                CompileFiles("Lib", nil, ("Lib.cs", librarySource))
            } else {
                CompileFiles("Lib", nil, ("Lib.cs", librarySource), ("Use.cs", UseSource))
            }
            let app = if throughReference {
                CompileFiles("App", Emit(library), ("Use.cs", UseSource))
            } else {
                library
            }
            let repository = []CSharpCompilation{library, app}.Distinct().ToArray()
            return (TranslateFile(library, "Lib.cs", repository), TranslateFile(app, "Use.cs", repository))
        }

        private func Emit(compilation CSharpCompilation) MetadataReference {
            let image = MemoryStream()
            Assert.True(compilation.Emit(image).Success)
            image.Position = 0
            return MetadataReference.CreateFromStream(image)
        }

        private func TranslateFile(
            compilation CSharpCompilation,
            path string,
            repository IReadOnlyList[CSharpCompilation]
        ) string {
            let tree = compilation.SyntaxTrees.First((t SyntaxTree) -> t.FilePath == path)
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(
                compilation,
                model,
                tree.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
        }

        private func CompileFiles(
            name string,
            reference MetadataReference?,
            sources ...(Path string, Source string)
        ) CSharpCompilation {
            let trees = sources.Select(
                (source(Path string, Source string)) -> CSharpSyntaxTree.ParseText(
                    source.Source,
                    CSharpParseOptions(LanguageVersion.Latest),
                    path: source.Path
                )
            )
                .ToArray()
            var references = CSharpProjectLoader.RuntimeReferences().ToList()
            if reference != nil {
                references.Add(reference)
            }
            let compilation = CSharpCompilation.Create(
                name,
                trees,
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            return compilation
        }

        private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5601-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath"}
                for var i = 0; i < printedFiles.Count; i++ {
                    let gsPath = Path.Combine(workDir, "Unit$i.gs")
                    File.WriteAllText(gsPath, printedFiles[i])
                    arguments.Add(gsPath)
                }
                let entryPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(
                    entryPath,
                    "import System${Environment.NewLine}${Environment.NewLine}Console.WriteLine($callExpression)${Environment.NewLine}"
                )
                arguments.Add(entryPath)
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + string.Join(Environment.NewLine, printedFiles)
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(TimeSpan.FromMinutes(5)) {
                process!!.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
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
