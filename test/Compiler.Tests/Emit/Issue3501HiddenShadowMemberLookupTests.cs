// <copyright file="Issue3501HiddenShadowMemberLookupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501 (Translator burn-down, GS0158 "Cannot find member SyntaxTree"
/// ×44): reflection's flattened member view applies hide-by-name BEFORE the
/// visibility filter, so an INTERNAL <c>new</c> shadow in a derived metadata
/// class — Roslyn's <c>CSharpSyntaxNode.SyntaxTree</c> over the public
/// <c>SyntaxNode.SyntaxTree</c> — removes the base member from the flattened
/// set while the shadow itself is excluded by the Public flag, and the member
/// vanishes entirely. <c>ClrTypeUtilities.SafeGetMember</c> now walks the base
/// chain most-derived-first with DeclaredOnly per level, matching C# lookup:
/// an accessible shadow wins at its own level, and an inaccessible one simply
/// doesn't hide the base member.
/// </summary>
public class Issue3501HiddenShadowMemberLookupTests
{
    [Fact]
    public void InternalNewShadow_DoesNotHideInheritedPublicMember()
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3501_shadow_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, """
                package Probe
                import System
                import Microsoft.CodeAnalysis
                import Microsoft.CodeAnalysis.CSharp
                import Microsoft.CodeAnalysis.CSharp.Syntax

                func lengthOf(node CSharpSyntaxNode) int32 {
                    return node.SyntaxTree.Length
                }

                func viaStatement(statement StatementSyntax) string {
                    return statement.SyntaxTree.FilePath
                }
                """);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:library",
                "/targetframework:net10.0",
                "/r:" + typeof(Microsoft.CodeAnalysis.SyntaxNode).Assembly.Location,
                "/r:" + typeof(Microsoft.CodeAnalysis.CSharp.CSharpSyntaxNode).Assembly.Location,
                sourcePath,
            }, out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static int RunCompiler(string[] arguments, out string diagnostics)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(arguments);
            diagnostics = $"stdout:\n{stdout}\nstderr:\n{stderr}";
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
