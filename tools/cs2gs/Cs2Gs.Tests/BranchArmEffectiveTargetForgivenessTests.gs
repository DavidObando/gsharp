// <copyright file="BranchArmEffectiveTargetForgivenessTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// A conditional or switch-expression arm flows into the target of the WHOLE
/// expression, so whether the arm needs `!!` depends on that target
/// rather than on the arm itself. cs2gs asserted a nullable arm unconditionally.
/// That turned `string emittedName = constructorIndex >= 0 ? null :
/// argument.Name;` into `… else { argument.Name!! }` inside a
/// `string?` local, and the migrated translator threw
/// `NullReferenceException` on every positional attribute argument
/// (`Name` is null). That was the nightly self-migration's
/// `Cs2Gs.Tests` test-parity failure in
/// `CSharpToGSharpTranslator.LibraryImport`. An arm whose target is
/// non-null keeps its `!!`.
open class BranchArmEffectiveTargetForgivenessTests {
    /// The exact LibraryImport shape, across projects as in the migration
    /// (the translator reads `AttributeArgument.Name` from
    /// `Cs2Gs.CodeModel`), compiled and run: a positional argument (null
    /// `Name`) takes the conditional's non-null arm, which must not
    /// assert.
    @Fact
    func LibraryImportShape_PositionalArgument_CompilesAndRuns() {
        const app = `
using System.Collections.Generic;
using System.Text;
using Model;

namespace App
{
    public static class Emitter
    {
        private static int ConstructorParameterIndex(string name) => name == null ? -1 : name == "libraryName" ? 0 : -1;

        public static string Emit(List<Arg> arguments)
        {
            var builder = new StringBuilder();
            foreach (Arg argument in arguments)
            {
                int constructorIndex = ConstructorParameterIndex(argument.Name);
                string emittedName = constructorIndex >= 0 ? null : argument.Name;
                builder.Append(emittedName == null ? argument.Value : emittedName + "=" + argument.Value).Append(';');
            }

            return builder.ToString();
        }

        public static string Run() => Emit(new List<Arg>
        {
            new Arg("libc"),
            new Arg("Lib", "libraryName"),
            new Arg("Utf8", "StringMarshalling"),
        });
    }
}`
        let (library, consumer) = TranslateBothProjects(app)
        Assert.Contains("prop Name string?", library)
        Assert.DoesNotContain("argument.Name!!", consumer)
        Assert.Equal(
            "libc;Lib;StringMarshalling=Utf8;",
            CompileAndRun([]string{library, consumer}, "App.Emitter.Run()").Trim()
        )
    }

    /// Every branching form whose whole-expression target accepts nil leaves
    /// the arm bare when the member is declared in another project of the run:
    /// a conditional or switch into a widened local, a return from a widened
    /// method, an expression-bodied member, an assignment, the left operand of
    /// `??`, a `?.` receiver, and a `== null` / `is null`
    /// test (including a wrapped `(null!)`).
    @Fact
    func NullableEffectiveTarget_ArmsStayBare() {
        const app = `
namespace App
{
    public static class Use
    {
        public static string Local(Model.Arg argument, int i)
        {
            string emittedName = i >= 0 ? null : argument.Name;
            return emittedName;
        }

        public static string Switch(Model.Arg argument, int i)
        {
            string e = i switch { 0 => null, _ => argument.Name };
            return e;
        }

        public static string Arrow(Model.Arg argument, int i) => i >= 0 ? null : argument.Name;

        public static string Returns(Model.Arg argument, int i)
        {
            if (i > 3) { return i >= 0 ? null : argument.Name; }
            return i switch { 0 => null, _ => argument.Name };
        }

        public static string Assigned(Model.Arg argument, int i)
        {
            string e;
            e = i >= 0 ? null : argument.Name;
            return e;
        }

        public static string Coalesced(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name) ?? "fallback";

        public static string SwitchCoalesced(Model.Arg argument, int i) => (i switch { 0 => null, _ => argument.Name }) ?? "fallback";

        public static int? Accessed(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name)?.Length;

        public static int? SwitchAccessed(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name })?.Length;

        public static bool Compared(Model.Arg argument, int i) => (i >= 0 ? argument.Value : argument.Name) == null;

        public static bool Tested(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name }) is null;

        public static bool ComparedWrapped(Model.Arg argument, int i) => (i >= 0 ? argument.Value : argument.Name) == (null!);
    }
}`
        let printed = TranslateCrossProject(app)
        // No assertion anywhere: not on an arm, and not moved around the
        // whole branching expression either.
        Assert.DoesNotContain("!!", printed)
    }

    /// The arm stays bare for an inferred generic parameter and for a widened
    /// local reached through a C# `!`. The translated `!` into the
    /// widened local is erased too. Only the inferred-generic argument bridge
    /// still emits a whole-value `!!` (left open on #4452), so for that
    /// call this test pins only the arm.
    @Fact
    func InferredGenericAndSuppressedLocal_ArmsStayBare() {
        const app = `
namespace App
{
    public static class Use
    {
        public static T Id<T>(T value) => value;

        public static string Inferred(Model.Arg argument, int i) => Id(i > 0 ? argument.Value : argument.Name);

        public static int Suppressed(Model.Arg argument, bool flag)
        {
            string chosen = (flag ? argument.Name : argument.Value)!;
            return chosen == null ? 0 : chosen.Length;
        }

        public static string[] DefaultArm(Model.Arg argument, int i) => new[] { i > 0 ? default(string) : argument.Name };
    }
}`
        let printed = TranslateCrossProject(app)
        Assert.DoesNotContain("argument.Name!!", printed)
        Assert.DoesNotContain("argument.Value!!", printed)
        // Issue #4452: the translated C# `!` into the widened `chosen` is erased
        // rather than asserted, so no `!!` wraps the whole branch either.
        Assert.Contains("let chosen string? = (if flag { argument.Name } else { argument.Value })", printed)
        Assert.DoesNotContain("argument.Value })!!", printed)
    }

    /// Issue #4452: a branch whose whole value C# takes as a possibly-null value
    /// (an interpolation hole, a string concatenation operand, the operand of
    /// `as`, a switch scrutinee) leaves its arms bare. Compiled with gsc and
    /// run with a null `Name`: each form reproduces C#'s result instead of
    /// throwing.
    @Fact
    func NilAcceptingParents_ArmsStayBare_CompileAndRun() {
        const app = `
using Model;

namespace App
{
    public static class Use
    {
        public static string Interpolated(Arg a, bool f) => $"[{(f ? a.Name : a.Value)}]";

        public static string Concatenated(Arg a, bool f) => "<" + (f ? a.Name : a.Value) + ">";

        public static string Cast(Arg a, bool f) => ((f ? a.Name : a.Value) as string) ?? "none";

        public static string Switched(Arg a, bool f) => (f ? a.Name : a.Value) switch { null => "null", var s => s };

        public static string Appended(Arg a, bool f)
        {
            string s = "{";
            s += f ? a.Name : a.Value;
            return s + "}";
        }

        public static string SwitchStatement(Arg a, bool f)
        {
            switch (f ? a.Name : a.Value)
            {
                case null: return "N";
                default: return "V";
            }
        }

        public static string Run()
        {
            var a = new Arg("v");
            return Interpolated(a, true) + Concatenated(a, true) + Cast(a, true) + Switched(a, true) + Appended(a, true) + SwitchStatement(a, true);
        }
    }
}`
        let (library, consumer) = TranslateBothProjects(app)
        Assert.DoesNotContain("a.Name!!", consumer)
        Assert.Equal("[]<>nonenull{}N", CompileAndRun([]string{library, consumer}, "App.Use.Run()").Trim())
    }

    /// Precision: an arm whose whole-expression target is a non-null
    /// parameter still asserts, for a conditional and for a switch, and so
    /// does an arm into a generic parameter whose type argument is explicit.
    @Fact
    func NonNullEffectiveTarget_ArmsKeepAssertion() {
        const app = `
namespace App
{
    public static class Use
    {
        public static int Index(string name) => name == "x" ? 0 : -1;

        public static int Conditional(Model.Arg argument, int i) => Index(i > 0 ? argument.Name : "x");

        public static int Switch(Model.Arg argument, int i) => Index(i switch { 0 => argument.Name, _ => "y" });

        public static T Id<T>(T value) => value;

        public static string Explicit(Model.Arg argument, int i) => Id<string>(i > 0 ? argument.Value : argument.Name);

        public sealed class Dest
        {
            public static explicit operator Dest(string s) => new Dest();
        }

        public static Dest Converted(Model.Arg argument, bool flag)
        {
            Dest d = (Dest)(flag ? argument.Name : "x");
            if (d == null) { return null; }
            return d;
        }
    }
}`
        let printed = TranslateCrossProject(app)
        Assert.Contains("if i > 0 { argument.Name!! } else { \"x\" }", printed)
        Assert.Contains("case 0: argument.Name!!", printed)
        Assert.Contains("Id[string](if i > 0 {", printed)
        Assert.Contains("else { argument.Name!! })", printed)
        // A user-defined conversion is an invocation boundary: the arm feeds
        // the operator's non-null parameter, not the widened local `d`.
        Assert.Contains("if flag { argument.Name!! } else { \"x\" }", printed)
    }

    /// A `var` local is not a nil-accepting target, even though
    /// nullable-enabled C# annotates it: G# infers it from the emitted value.
    /// This is the Oahu `CoreAuthService.ToSession` shape. The flow-narrowed
    /// `a` arm keeps its `!!`, so `alias` stays `string`
    /// and can initialize a non-null member.
    @Fact
    func ImplicitlyTypedLocal_IsNotANilAcceptingTarget() {
        const source = `
#nullable enable
using System.Collections.Generic;

public sealed class Session { public string Alias { get; set; } = ""; }

public static class C
{
    public static Session Make(IReadOnlyDictionary<string, string> aliases, string id, string? name)
    {
        var alias = aliases.TryGetValue(id, out var a) && !string.IsNullOrWhiteSpace(a)
            ? a
            : name ?? id;
        return new Session { Alias = alias };
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("{ a!! } else { name ?? id }", printed)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, string.Join("\n", result!!.Errors) + `

` + printed)
    }

    shared {
        private const Model string = `
namespace Model
{
    public sealed class Arg
    {
        public Arg(string value, string name = null) { Value = value; Name = name; }
        public string Name { get; }
        public string Value { get; }
    }

    public static class Printer
    {
        public static string Print(Arg a) => a.Name == null ? a.Value : a.Name + ": " + a.Value;
    }
}`

        private func TranslateCrossProject(app string) string -> TranslateBothProjects(app).Consumer

        private func TranslateBothProjects(app string)(Library string, Consumer string) {
            let (library, image) = Compile(Model, "Model", Array.Empty[MetadataReference]())
            let (consumer, _) = Compile(app, "App", []MetadataReference{image})
            let repository = []CSharpCompilation{library, consumer}
            return (Translate(library, repository), Translate(consumer, repository))
        }

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

        private func Compile(source string, assemblyName string, references IReadOnlyList[MetadataReference])(
            Compilation CSharpCompilation,
            Image MetadataReference
        ) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Concat(references),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
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
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "branch-arm-effective-target-e2e",
                Guid.NewGuid().ToString("N")
            )
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
            // Drain both streams concurrently so neither pipe can fill and block
            // the child, and bound the wait so a hung child fails the test.
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
