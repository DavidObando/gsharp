// <copyright file="Issue1909PrimaryConstructorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #1909: a C# 12 primary constructor (`class NamedItem(string name)
/// { ... }`) had its parameter list silently dropped by
/// `CSharpToGSharpTranslator.MapPrimaryConstructor` — that method only
/// recognized (cref:Microsoft.CodeAnalysis.CSharp.Syntax.RecordDeclarationSyntax),
/// so a plain `class`/`struct` primary-ctor parameter list (which
/// hangs off the same `TypeDeclarationSyntax.ParameterList` property)
/// was ignored. The emitted G# then referenced the vanished parameter as a
/// free variable (GS0125) and constructed the type with zero arguments
/// (GS0144). A derived type's `: Base(arg)` forwarding call
/// ((cref:Microsoft.CodeAnalysis.CSharp.Syntax.PrimaryConstructorBaseTypeSyntax))
/// failed the same way — the base-call argument list was never read at all.
///
/// G# has native primary constructors, including an explicit base-call form
/// `class Derived(...) : Base(args) { ... }` (ADR-0065 §5,
/// `Parser.cs` `baseCtorOpenParen`/`BaseConstructorArguments`),
/// so both C# shapes map directly with no semantic loss.
open class Issue1909PrimaryConstructorTranslationTests {
    @Fact
    func PlainClass_PrimaryConstructor_KeepsParameterList() {
        let rendered = Render(`
namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }
}
`)
        Assert.Contains("class NamedItem(name string) {", rendered, StringComparison.Ordinal)
        Assert.Contains("return name", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DerivedClass_PrimaryConstructorBaseType_ForwardsBaseArguments() {
        let rendered = Render(`
namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }

    public class PricedItem(string name, int price) : NamedItem(name)
    {
        public int Price()
        {
            return price;
        }
    }
}
`)
        Assert.Contains("open class NamedItem(name string) {", rendered, StringComparison.Ordinal)
        Assert.Contains(
            "class PricedItem(name string, price int32) : NamedItem(name) {",
            rendered,
            StringComparison.Ordinal
        )
        AssertRoundTripParses(rendered)
    }

    @Fact
    func Struct_PrimaryConstructor_KeepsParameterList() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1909
{
    public struct Point(int x, int y)
    {
        public int Sum()
        {
            return x + y;
        }
    }
}
`)})
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("struct Point(x int32, y int32) {", rendered, StringComparison.Ordinal)
        Assert.Contains("return x + y", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func Record_PrimaryConstructorBaseType_StillForwardsBaseArguments() {
        // The record positional-parameter path already worked before this fix
        // (RecordDeclarationSyntax.ParameterList was special-cased), but the
        // `: Base(args)` forwarding call was never read at all — verify both
        // still hold together now that the class-primary-ctor gap is closed.
        let rendered = Render(`
namespace Corpus.Issue1909
{
    public record Message(int Type, string Text);

    public record CustomMessage(int Type, string Text, string Extra) : Message(Type, Text);
}
`)
        Assert.Contains("data class Message(Type int32, Text string)", rendered, StringComparison.Ordinal)
        Assert.Contains(
            "data class CustomMessage(Type int32, Text string, Extra string) : Message(Type, Text)",
            rendered,
            StringComparison.Ordinal
        )
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NullablePrimaryConstructorBaseArgument_IsForgiven() {
        let rendered = Render(`
#nullable enable
namespace Corpus.Issue1909
{
    public record Message(string Text);
    public record CustomMessage(string? Text) : Message(Text);
}
`)
        Assert.Contains("data class CustomMessage(Text string?) : Message(Text!!)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func TranslatedProgram_CompilesAndRunsWithGsc() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }

    public class PricedItem(string name, int price) : NamedItem(name)
    {
        public int Price()
        {
            return price;
        }
    }
}
`)
        let stdout = CompileAndRun(
            rendered,
            "var item = NamedItem(\"widget\")\n" +
                "Console.WriteLine(\"name=\" + item.Name())\n" +
                "var priced = PricedItem(\"gadget\", 25)\n" +
                "Console.WriteLine(\"derived=\" + priced.Name() + \"/\" + priced.Price().ToString())"
        )
        Assert.Equal("name=widget" + Environment.NewLine + "derived=gadget/25" + Environment.NewLine, stdout)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }

        /// Compiles [`printed`](paramref) (with [`callExpression`](paramref)
        /// appended as top-level entry statements) with the real `gsc` and runs
        /// it, returning stdout (mirrors `Issue1912ExplicitEnumValueTranslationTests.CompileAndRun`).
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-1909-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout)
            return stdout
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
