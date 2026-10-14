// <copyright file="Issue2012OpenGenericTypeOfProducerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2012 (S1): cs2gs's translation of a C# unbound generic
/// `typeof(...)` operand (`typeof(Func<>)`,
/// `typeof(Dictionary<,>)`) was untouched by #1989/#2011 — it kept
/// emitting the bare generic-definition name (`typeof(Func)`), which
/// stays ambiguous (GS0113) for a same-base-name multi-arity BCL family. cs2gs
/// now emits the canonical explicit-arity `_` placeholder form
/// established by #1989/#2011 (`typeof(Func[_])`,
/// `typeof(Dictionary[_, _])`) so the syntax has an automated C# → G#
/// producer, and proves the full round-trip: translate → compile with the
/// real `gsc` → run → the reflected (cref:Type) is bit-for-bit
/// the same CLR open generic type definition as C#'s own `typeof(Func<>)`.
open class Issue2012OpenGenericTypeOfProducerTests {
    @Fact
    func UnboundFunc_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<>);
    }
}`)
        Assert.Contains("typeof(Func[_])", printed)
    }

    @Fact
    func UnboundFunc_TwoArity_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<,>);
    }
}`)
        Assert.Contains("typeof(Func[_, _])", printed)
    }

    /// Issue #3589: an unbound generic in a NON-terminal segment renders each
    /// generic segment with its own `_` placeholder list instead of
    /// leaking the C# `<,>` spelling verbatim (which failed the
    /// round-trip parse).
    @Fact
    func UnboundNestedType_TypeOf_RendersPlaceholdersPerSegment() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Dictionary<,>.Enumerator);
    }
}`)
        Assert.Contains("typeof(Dictionary[_, _].Enumerator)", printed)
        Assert.DoesNotContain("<,>", printed)
    }

    @Fact
    func UnboundNestedGeneric_TypeOf_RendersPlaceholdersPerSegment() {
        let printed = TranslateNestedUnit(`
using System;

namespace Demo
{
    public class Outer<T>
    {
        public class Inner<U>
        {
        }
    }

    public class C
    {
        public Type Describe() => typeof(Outer<>.Inner<>);
    }
}`)
        Assert.Contains("typeof(Outer[_].Inner[_])", printed)
        Assert.DoesNotContain("<>", printed)
    }

    @Fact
    func NonGenericOuterGenericNestedQualifier_TypeOf_RendersPlaceholdersOnNestedSegment() {
        let printed = TranslateNestedUnit(`
using System;

namespace Demo
{
    public class Outer
    {
        public class Nested<T>
        {
            public class Leaf
            {
            }
        }
    }

    public class C
    {
        public Type Describe() => typeof(Outer.Nested<>.Leaf);
    }
}`)
        Assert.Contains("typeof(Outer.Nested[_].Leaf)", printed)
        Assert.DoesNotContain("<>", printed)
    }

    /// Full producer round-trip: the translated `typeof(Func[_])`
    /// compiles with the real `gsc` and, at run time, is REFLECTION-equal
    /// (not merely name-equal) to C#'s own `typeof(System.Func<>)` —
    /// proving cs2gs's emitted `_` placeholder form really does round-trip
    /// to the same CLR open generic type definition.
    @Fact
    func UnboundFunc_TypeOf_CompilesAndReflectsSameClrOpenGenericDefinition() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            // gsc.dll not built in this run (e.g. cs2gs-only build); the
            // translation-level assertions above still cover the producer.
            return
        }
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<>);
    }
}`)
        Assert.Contains("typeof(Func[_])", printed)
        let source = `package i2012s1func1
import System

func Main() { System.Console.WriteLine(typeof(Func[_]).AssemblyQualifiedName) }`
        let workDir = Path.Combine(AppContext.BaseDirectory, "i2012-e2e")
        Directory.CreateDirectory(workDir)
        let gsPath = Path.Combine(workDir, "Program.gs")
        let dllPath = Path.Combine(workDir, "Program.dll")
        File.WriteAllText(gsPath, source)
        let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the emitted `_` placeholder form with zero errors. Output:\n" + compileOut
        )
        let runResult = RunDotnetFull("\"$dllPath\"")
        Assert.True(runResult.Exit == 0, "The compiled program must run successfully. Output:\n" + runResult.Combined)
        let stdout = runResult.Stdout
        let reflectedType Type? = Type.GetType(stdout.Trim())
        Assert.Equal(typeof(Func[_]), reflectedType)
    }

    shared {
        // Same as TranslateUnit but parse-only for source-defined open nested
        // generics, which have no reflectable CLR type during binding.
        private func TranslateNestedUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            let printed = GSharpPrinter.Print(unit)
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "gsc binds `_` placeholders only in the terminal segment until #3589"
            )
            Assert.True(
                result.Success,
                "Translated G# must round-trip-parse. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
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

        private func RunDotnetFull(arguments string)(Exit int32, Stdout string, Combined string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            return (process!!.ExitCode, stdout, stdout + stderr)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let (exit, _, combined) = RunDotnetFull(arguments)
            return (exit, combined)
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
