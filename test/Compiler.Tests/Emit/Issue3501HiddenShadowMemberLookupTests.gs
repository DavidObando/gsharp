// <copyright file="Issue3501HiddenShadowMemberLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import Xunit

/// Issue #3501 (Translator burn-down, GS0158 "Cannot find member SyntaxTree"
/// ×44): reflection's flattened member view applies hide-by-name BEFORE the
/// visibility filter, so an INTERNAL `new` shadow in a derived metadata
/// class — Roslyn's `CSharpSyntaxNode.SyntaxTree` over the public
/// `SyntaxNode.SyntaxTree` — removes the base member from the flattened
/// set while the shadow itself is excluded by the Public flag, and the member
/// vanishes entirely. `ClrTypeUtilities.SafeGetMember` now walks the base
/// chain most-derived-first with DeclaredOnly per level, matching C# lookup:
/// an accessible shadow wins at its own level, and an inaccessible one simply
/// doesn't hide the base member.
open class Issue3501HiddenShadowMemberLookupTests {
    @Fact
    func InternalNewShadow_DoesNotHideInheritedPublicMember() {
        let directory = Directory.CreateTempSubdirectory("gs_issue3501_shadow_").FullName
        try {
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, `package Probe
import System
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax

func lengthOf(node CSharpSyntaxNode) int32 {
    return node.SyntaxTree.Length
}

func viaStatement(statement StatementSyntax) string {
    return statement.SyntaxTree.FilePath
}`)
            let exitCode = RunCompiler(
                []string{
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/r:" + typeof(SyntaxNode).Assembly.Location,
                    "/r:" + typeof(CSharpSyntaxNode).Assembly.Location,
                    sourcePath
                },
                out var diagnostics
            )
            Assert.True(exitCode == 0, diagnostics)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func RunCompiler(arguments[]string, out diagnostics string) int32 {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                diagnostics = (`stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                return exitCode
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
