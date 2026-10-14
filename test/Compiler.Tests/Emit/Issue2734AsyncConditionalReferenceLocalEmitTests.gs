// <copyright file="Issue2734AsyncConditionalReferenceLocalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2734: the translated `SignInFlow` combination of an async
/// `Task.Run` lambda, a reference-valued conditional with awaited arms,
/// and a later await makes `SpillConditional` synthesize an
/// `AuthSession` spill local. `FlushSideEffects` used to initialize
/// that local with an `int32` zero before the selected arm assigned it.
/// Async capture then hoisted the local to an `AuthSession` field, yielding
/// ILVerify `StackUnexpected: found Int32, expected ref AuthSession`.
open class Issue2734AsyncConditionalReferenceLocalEmitTests {
    @Fact
    func ExactSignInFlow_D1205f3d4b51_VerifiesAndRuns() {
        const HelperSource = `using System.Threading.Tasks;

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
}`
        const Source = `package Oahu.Cli.Tui.Auth

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
Console.WriteLine("${AuthService.CredentialCalls}:${AuthService.BrowserCalls}")`
        Assert.Equal(
            "credentials:11${Environment.NewLine}browser:7${Environment.NewLine}1:1${Environment.NewLine}",
            CompileVerifyAndRun(Source, HelperSource)
        )
    }

    shared {
        private func CompileVerifyAndRun(source string, helperSource string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2734Emit")
            Directory.CreateDirectory(directory)
            let helperPath = BuildHelper(directory, helperSource)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{
                        "/out:" + outputPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + helperPath,
                        sourcePath
                    }
                )
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath, []string{helperPath})
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                        outputPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let output = process!!.StandardOutput.ReadToEnd()
            let error = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, error)
            return output.ReplaceLineEndings(Environment.NewLine)
        }

        private func BuildHelper(directory string, source string) string {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Oahu.Cli.App",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, "Oahu.Cli.App.dll")
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
