// <copyright file="Issue2734AsyncConditionalReferenceLocalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2734: the translated <c>SignInFlow</c> combination of an async
/// <c>Task.Run</c> lambda, a reference-valued conditional with awaited arms,
/// and a later await makes <c>SpillConditional</c> synthesize an
/// <c>AuthSession</c> spill local. <c>FlushSideEffects</c> used to initialize
/// that local with an <c>int32</c> zero before the selected arm assigned it.
/// Async capture then hoisted the local to an <c>AuthSession</c> field, yielding
/// ILVerify <c>StackUnexpected: found Int32, expected ref AuthSession</c>.
/// </summary>
public class Issue2734AsyncConditionalReferenceLocalEmitTests
{
    [Fact]
    public void ExactSignInFlow_D1205f3d4b51_VerifiesAndRuns()
    {
        const string HelperSource = """
            using System.Threading.Tasks;

            namespace Oahu.Cli.App.Auth;

            public sealed class AuthSession
            {
                public AuthSession(string profileAlias) => ProfileAlias = profileAlias;
                public string ProfileAlias { get; }
            }

            public static class AuthService
            {
                public static int CredentialCalls { get; private set; }
                public static int BrowserCalls { get; private set; }

                public static async Task<AuthSession> LoginWithCredentialsAsync()
                {
                    CredentialCalls++;
                    await Task.Yield();
                    return new AuthSession("credentials");
                }

                public static async Task<AuthSession> LoginAsync()
                {
                    BrowserCalls++;
                    await Task.Yield();
                    return new AuthSession("browser");
                }

                public static async Task<int> SyncAsync(string profileAlias)
                {
                    await Task.Yield();
                    return profileAlias.Length;
                }
            }
            """;
        const string Source = """
            package Oahu.Cli.Tui.Auth

            import System
            import System.Threading.Tasks
            import Oahu.Cli.App.Auth

            class SignInFlow() {
                func StartCore(hasCredentials bool) Task[string] {
                    return Task.Run(async () -> {
                        let session = hasCredentials
                            ? await AuthService.LoginWithCredentialsAsync().ConfigureAwait(false)
                            : await AuthService.LoginAsync().ConfigureAwait(false)

                        let count = await AuthService.SyncAsync(session.ProfileAlias).ConfigureAwait(false)
                        return "${session.ProfileAlias}:${count}"
                    })
                }
            }

            let flow = SignInFlow()
            Console.WriteLine(flow.StartCore(true).GetAwaiter().GetResult())
            Console.WriteLine(flow.StartCore(false).GetAwaiter().GetResult())
            Console.WriteLine("${AuthService.CredentialCalls}:${AuthService.BrowserCalls}")
            """;

        Assert.Equal(
            "credentials:11\nbrowser:7\n1:1\n",
            CompileVerifyAndRun(Source, HelperSource));
    }

    private static string CompileVerifyAndRun(string source, string helperSource)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2734Emit");
        Directory.CreateDirectory(directory);
        var helperPath = BuildHelper(directory, helperSource);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + helperPath,
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath, new[] { helperPath });

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n");
    }

    private static string BuildHelper(string directory, string source)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Oahu.Cli.App",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(directory, "Oahu.Cli.App.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
