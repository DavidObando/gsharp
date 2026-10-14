// <copyright file="Issue4472KeptTopLevelProgramAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #4472: C# top-level statements execute in their synthesized
/// `Program` type and can access its private members. When cs2gs retains
/// that type, emitted G# top-level statements must keep the same access and
/// must qualify nested types through `Program`.
class Issue4472KeptTopLevelProgramAccessTests {
    @Fact
    func NestedAggregate_KeepsProgramPrivateMembersReachableAndQualifiesNestedType() {
        const source = `using System;

Console.WriteLine(Seed());
Console.WriteLine(new Box(2).Value);

internal static partial class Program
{
    private static int Seed() => 1;
    private static Box Make(int value) => new Box(value);

    private sealed class Box
    {
        private readonly int value;

        public Box(int value) => this.value = value;

        public int Value => value;
    }
}

internal static class Unrelated
{
    private static int Hidden() => 9;
}`
        let printed = Translate(source)
        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal)
        Assert.Contains("internal class Box", printed, StringComparison.Ordinal)
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal)
        Assert.Contains("Program.Box(2)", printed, StringComparison.Ordinal)
        Assert.Contains("func Make(value int32) Box -> Box(value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Make(value int32) Program.Box", printed, StringComparison.Ordinal)
        Assert.Contains("private func Hidden() int32", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "1\n2")
    }

    @Fact
    func ForcedPreservation_KeepsProgramPrivateMethodReachable() {
        const source = `using System;

Console.WriteLine(Seed());

internal static partial class Program
{
    private static int Seed() => 3;
}`
        let printed = Translate(source, preserveEntryType: true)
        Assert.Contains("class Program", printed, StringComparison.Ordinal)
        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal)
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "3")
    }

    @Fact
    func ExportedMember_KeepsProgramPrivateMethodReachable() {
        const source = `using System;

Console.WriteLine(Seed());

internal static partial class Program
{
    public static int Exported() => 5;

    private static int Seed() => Exported();
}`
        let printed = Translate(source)
        Assert.Contains("class Program", printed, StringComparison.Ordinal)
        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal)
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "5")
    }

    @Fact
    func NestedExplicitInterfaceImplementation_RemainsPrivate() {
        const source = `using System;

IRunner runner = new Runner();
Console.WriteLine(runner.Run());

internal static partial class Program
{
    private interface IRunner
    {
        int Run();
    }

    private sealed class Runner : IRunner
    {
        int IRunner.Run() => 6;
    }
}`
        let printed = Translate(source)
        Assert.Contains("internal interface IRunner", printed, StringComparison.Ordinal)
        Assert.Contains("internal class Runner", printed, StringComparison.Ordinal)
        Assert.Contains("private func (IRunner) Run() int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("internal func (IRunner) Run()", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "6")
    }

    @Fact
    func PrivateOnlyProgram_StillUsesCanonicalHoistedOutput() {
        const source = `using System;

Console.WriteLine(Seed());

internal static partial class Program
{
    private static int Seed() => 4;
}`
        let printed = Translate(source)
        Assert.Equal(
            "import System" +
                Environment.NewLine +
                Environment.NewLine +
                "private func Seed() int32 -> 4" +
                Environment.NewLine +
                "Console.WriteLine(Seed())" +
                Environment.NewLine,
            printed
        )
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "4")
    }

    shared {
        private func Translate(source string, preserveEntryType bool = false) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Program.cs", source)},
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator(preserveEntryType: preserveEntryType).TranslateDocument(document, context)
            )
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            TranslationTestValidation.AssertBinds(printed)
            return printed
        }
    }
}
