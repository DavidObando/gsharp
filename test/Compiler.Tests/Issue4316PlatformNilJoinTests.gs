// <copyright file="Issue4316PlatformNilJoinTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #4316: the join of a `nil` arm and a non-nullable arm is `T?`, but a `T!` arm already admits
/// `nil`, so the join stays `T!` (ADR-0186 section 3) and a later `T! -> T` coercion inserts the
/// runtime check instead of failing to bind. The conditional and the switch expression must agree.
/// @remarks Mutation witness: the switch arm without its `!hasPlatformArm || hasNullableArm` guard
/// lifts the join to `string?`, and the probe below fails with GS0154 on `Take(joined)`.
open class Issue4316PlatformNilJoinTests {
    /// A conditional or switch joining an oblivious `string!` and `nil` binds at a `string` parameter.
    /// @param joinExpression The G# expression that joins the two arms.
    @Theory
    @InlineData("c ? Ob.Field : nil")
    @InlineData("switch i { case 0: Ob.Field\n default: nil }")
    func APlatformArmJoinedWithNil_StaysPlatformAndBindsAtANonNullSlot(joinExpression string) {
        let directory = Directory.CreateTempSubdirectory("gsc_4316_platform_").FullName
        try {
            let libraryPath = EmitObliviousLibrary(directory)
            let probe = Path.Combine(directory, "probe.gs")
            File.WriteAllText(probe, `package P
import Adr0186.Switch.Library

func Take(s string) int32 -> 0

func F(c bool, i int32) int32 {
    let joined = ` + joinExpression + `
    return Take(joined)
}`)
            let (exit, output, error) = RunGscWith(directory, []string{probe, "/r:" + libraryPath})
            Assert.True(exit == 0, output + error)
            Assert.DoesNotContain("GS0154", output + error, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        private func EmitObliviousLibrary(directory string) string {
            const source = `namespace Adr0186.Switch.Library;

public static class Ob
{
    public static string Field = "V";
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where((path string) -> path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .ToImmutableArray()
            let compilation = CSharpCompilation.Create(
                "Adr0186.Switch.Library",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "Adr0186.Switch.Library.dll")
            let result = compilation.Emit(path)
            Assert.True(
                result.Success,
                string.Join(Environment.NewLine, result.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            return path
        }

        private func RunGscWith(workingDirectory string, arguments[]string)(Exit int32, Output string, Error string) {
            let originalCwd = Directory.GetCurrentDirectory()
            Directory.SetCurrentDirectory(workingDirectory)
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let exit = Program.Main(arguments)
                return (exit, outWriter.ToString(), errWriter.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
                Directory.SetCurrentDirectory(originalCwd)
            }
        }
    }
}
