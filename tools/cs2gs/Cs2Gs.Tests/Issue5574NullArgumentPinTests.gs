// <copyright file="Issue5574NullArgumentPinTests.cs" company="GSharp">
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

/// Issue #5574: two gsharp-csharp self-migration failures after #5525, from the pinned C# shapes.
///
/// 1. `TypeSymbol.ContainsTypeParameter(null)` (Core.Tests) widened `type` to `TypeSymbol?`, but
/// the value goes on unchanged to a local function whose parameter stays non-null, so the
/// translation bridged it with `type!!` and threw where C# returns `false`. A declaration whose
/// value reaches a slot that keeps a non-null contract is now PINNED: it is not widened, and no
/// value is widened through it.
/// 2. `Slice<string>.FromArray(null)` (Compiler.Tests) widened the migrated `Gsharp.Runtime.Values`
/// declaration, but `slice[string].FromArray` binds to the SDK's copy, so the call's `nil` was
/// GS0155. A declaration of an SDK runtime assembly is not a null-argument candidate, and the call
/// keeps `default([]string)` as before #5525.
/// @remarks Mutation witnesses (ADR-0154): with `IsPinnedNonNull` always `false`, the
/// `ContainsTypeParameter` rows emit `type!!` and the translated program throws
/// `NullReferenceException`; with `IsSdkRuntimeDeclaration` always `false`, the slice row emits
/// `FromArray(nil)` and fails binding with GS0155. Both rows also fail on 9e0dbaecb, before this fix.
open class Issue5574NullArgumentPinTests {
    /// The pinned `ContainsTypeParameter` shape: a null into a parameter that forwards its value to a
    /// local function keeps the parameter non-null, and the translation returns `false` as C# does.
    /// @remarks The pinned corpus is nullable-oblivious. In a two-project oblivious snippet the #2113
    /// taint (not this rule) also widens `ContainsTypeParameter`, so this row runs nullable-enabled,
    /// where only the null-argument rule decides; the oblivious corpus shape is covered by the
    /// gsharp-csharp leg's `Core.Tests` test-parity.
    @Fact
    func NullForwardedIntoALocalFunction_IsNotWidenedAndDoesNotThrow() {
        let (core, image) = Compile(`
namespace Demo
{
    public class TypeSymbol
    {
        public static readonly TypeSymbol Int32 = new TypeSymbol();

        public static bool ContainsTypeParameter(TypeSymbol type) => AnyTypeParameter(type, t => true);

        public static bool AnyTypeParameter(TypeSymbol type, System.Func<TypeSymbol, bool> match)
        {
            return AnyTypeParameter(type, match);

            bool AnyTypeParameter(TypeSymbol type, System.Func<TypeSymbol, bool> match)
            {
                switch (type)
                {
                    case null:
                        return false;
                    default:
                        return type != Int32 && match(type);
                }
            }
        }
    }

}`, "Core", NullableContextOptions.Enable, Array.Empty[MetadataReference]())
        let (tests, _) = Compile(`
namespace Demo.Tests
{
    public static class Probe
    {
        public static string Run() =>
            Demo.TypeSymbol.ContainsTypeParameter(Demo.TypeSymbol.Int32) + " " +
            Demo.TypeSymbol.ContainsTypeParameter(null);
    }
}`, "Core.Tests", NullableContextOptions.Enable, []MetadataReference{image})
        let repository = []CSharpCompilation{core, tests}
        let printed = Translate(core, repository)
        Assert.Equal(
            "False False",
            CompileAndRun([]string{printed, Translate(tests, repository)}, "Demo.Tests.Probe.Run()").Trim()
        )
        Assert.False(printed.Contains("AnyTypeParameter(type!!", StringComparison.Ordinal), printed)
        Assert.False(printed.Contains("ContainsTypeParameter(type TypeSymbol?)", StringComparison.Ordinal), printed)
    }

    /// The pinned `Slice<string>.FromArray(null)` shape: the call binds to the SDK's
    /// `Gsharp.Runtime.Values`, so the null keeps the typed default and the SDK's argument check
    /// still runs.
    @Fact
    func NullIntoAnSdkRuntimeDeclaration_KeepsTheTypedDefault() {
        let (values, image) = Compile(`
namespace Gsharp.Values
{
    public readonly struct Slice<T>
    {
        private readonly T[] array;

        private Slice(T[] array) { this.array = array; }

        public static Slice<T> FromArray(T[] array)
        {
            if (array == null) { throw new System.ArgumentNullException(nameof(array)); }
            return new Slice<T>(array);
        }
    }
}`, "Gsharp.Runtime.Values", NullableContextOptions.Enable, Array.Empty[MetadataReference]())
        let (consumer, _) = Compile(`
namespace Demo
{
    public static class Probe
    {
        public static string Run()
        {
            try
            {
                Gsharp.Values.Slice<string>.FromArray(null);
                return "none";
            }
            catch (System.ArgumentNullException)
            {
                return "ANE";
            }
        }
    }
}`, "Compiler.Tests", NullableContextOptions.Disable, []MetadataReference{image})
        let repository = []CSharpCompilation{values, consumer}
        let printed = Translate(consumer, repository)
        Assert.Equal("ANE", CompileAndRun([]string{printed}, "Demo.Probe.Run()").Trim())
        Assert.Contains("FromArray(default([]string))", printed)
    }

    shared {
        private func Translate(compilation CSharpCompilation, repository IReadOnlyList[CSharpCompilation]) string {
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(
                compilation,
                model,
                document.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func Compile(
            source string,
            assemblyName string,
            nullable NullableContextOptions,
            references IReadOnlyList[MetadataReference]
        )(Compilation CSharpCompilation, Image MetadataReference) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                // The snippet's own `Gsharp.Runtime.Values` stands in for the migrated project.
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Where(
                    (reference MetadataReference) -> !(reference.Display ?? "").EndsWith(
                        "Gsharp.Runtime.Values.dll",
                        StringComparison.Ordinal
                    )
                )
                    .Concat(references),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(nullable)
            )
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return (compilation, MetadataReference.CreateFromStream(peStream))
        }

        private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5574-e2e", Guid.NewGuid().ToString("N"))
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
