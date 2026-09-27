// <copyright file="Issue4472KeptTopLevelProgramAccessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4472: C# top-level statements execute in their synthesized
/// <c>Program</c> type and can access its private members. When cs2gs retains
/// that type, emitted G# top-level statements must keep the same access and
/// must qualify nested types through <c>Program</c>.
/// </summary>
public sealed class Issue4472KeptTopLevelProgramAccessTests
{
    [Fact]
    public void NestedAggregate_KeepsProgramPrivateMembersReachableAndQualifiesNestedType()
    {
        const string source = """
            using System;

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
            }
            """;

        string printed = Translate(source);

        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal);
        Assert.Contains("internal class Box", printed, StringComparison.Ordinal);
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal);
        Assert.Contains("Program.Box(2)", printed, StringComparison.Ordinal);
        Assert.Contains("func Make(value int32) Box -> Box(value)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("func Make(value int32) Program.Box", printed, StringComparison.Ordinal);
        Assert.Contains("private func Hidden() int32", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "1\n2");
    }

    [Fact]
    public void ForcedPreservation_KeepsProgramPrivateMethodReachable()
    {
        const string source = """
            using System;

            Console.WriteLine(Seed());

            internal static partial class Program
            {
                private static int Seed() => 3;
            }
            """;

        string printed = Translate(source, preserveEntryType: true);

        Assert.Contains("class Program", printed, StringComparison.Ordinal);
        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal);
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "3");
    }

    [Fact]
    public void ExportedMember_KeepsProgramPrivateMethodReachable()
    {
        const string source = """
            using System;

            Console.WriteLine(Seed());

            internal static partial class Program
            {
                public static int Exported() => 5;

                private static int Seed() => Exported();
            }
            """;

        string printed = Translate(source);

        Assert.Contains("class Program", printed, StringComparison.Ordinal);
        Assert.Contains("internal func Seed() int32", printed, StringComparison.Ordinal);
        Assert.Contains("Program.Seed()", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "5");
    }

    [Fact]
    public void PrivateOnlyProgram_StillUsesCanonicalHoistedOutput()
    {
        const string source = """
            using System;

            Console.WriteLine(Seed());

            internal static partial class Program
            {
                private static int Seed() => 4;
            }
            """;

        string printed = Translate(source);

        Assert.Equal(
            "import System" + Environment.NewLine +
            Environment.NewLine +
            "private func Seed() int32 -> 4" + Environment.NewLine +
            "Console.WriteLine(Seed())" + Environment.NewLine,
            printed);
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, string.Empty, "4");
    }

    private static string Translate(string source, bool preserveEntryType = false)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) },
            outputKind: OutputKind.ConsoleApplication);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator(preserveEntryType: preserveEntryType)
                .TranslateDocument(document, context));

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }
}
