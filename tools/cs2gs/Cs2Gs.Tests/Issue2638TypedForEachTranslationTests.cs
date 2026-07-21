// <copyright file="Issue2638TypedForEachTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2638TypedForEachTranslationTests
{
    [Fact]
    public void OahuFileSecurityLoop_PreservesExplicitElementCast()
    {
        const string source = """
            using System;
            using System.Security.AccessControl;
            using System.Security.Principal;

            namespace Oahu.Cli.Server.Auth;

            public static class TokenStore
            {
                public static void RemoveCurrent(FileSecurity sec)
                {
                    var current = sec.GetAccessRules(true, true, typeof(SecurityIdentifier));
                    foreach (FileSystemAccessRule r in current)
                    {
                        sec.RemoveAccessRule(r);
                    }
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("TokenStore.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("for __foreach0 in current", printed, StringComparison.Ordinal);
        Assert.Contains(
            "let r FileSystemAccessRule = (__foreach0 as FileSystemAccessRule)!!",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("sec.RemoveAccessRule(r)", printed, StringComparison.Ordinal);
        AssertTranslatedSourceCompiles(printed);
    }

    private static void AssertTranslatedSourceCompiles(string source)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2638TypedForEachTranslationTests));
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "TokenStore.gs");
        var outputPath = Path.Combine(directory, "TokenStore.dll");
        File.WriteAllText(sourcePath, source);

        var compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"));
        Assert.True(File.Exists(compiler), "gsc.dll was not built.");

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(compiler);
        startInfo.ArgumentList.Add("/target:library");
        startInfo.ArgumentList.Add("/targetframework:net10.0");
        startInfo.ArgumentList.Add("/out:" + outputPath);
        startInfo.ArgumentList.Add(sourcePath);
        using var process = Process.Start(startInfo);
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, output);
        Assert.DoesNotContain("GS0159", output, StringComparison.Ordinal);
    }
}
