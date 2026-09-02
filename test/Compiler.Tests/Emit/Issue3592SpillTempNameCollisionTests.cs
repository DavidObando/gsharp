// <copyright file="Issue3592SpillTempNameCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3592: a method body can pass through SEVERAL spiller passes — the
/// control-flow block lifter during general lowering, then the async await
/// spiller — and each started its <c>&lt;&gt;7__wrapN</c> ordinal at zero.
/// Two same-named locals with DIFFERENT types collided in the async state
/// machine, which maps hoisted locals to fields by name: a generic async
/// method whose if-expression arm throws before its trailing value stored the
/// await's <c>TResult</c> through the class-typed wrap field (ilverify
/// StackUnexpected; the migrated <c>GSharpLanguageServerRpc.InvokeAsync</c>
/// wall). Each pass now names its temps in a distinct domain.
/// </summary>
public class Issue3592SpillTempNameCollisionTests
{
    [Fact]
    public void GenericAsync_ThrowingIfExpressionArm_VerifiesAndRuns()
    {
        const string Source = """
            package Issue3592

            import System
            import System.Threading.Tasks

            class Rpc {
                async func Get[T](name string) T {
                    await Task.Delay(1)
                    return default(T)
                }
            }

            class Client {
                private var rpc Rpc? = nil
                private var ready bool = false

                internal func Attach(connection Rpc) {
                    rpc = connection
                    ready = true
                }

                internal async func Invoke[TResult](method string) TResult {
                    var current Rpc
                    current = if ready && rpc != nil { rpc!! } else { throw InvalidOperationException("not ready")
                        default(Rpc) }
                    return await current.Get[TResult](method)
                }
            }

            func Main() {
                let c = Client()
                c.Attach(Rpc())
                let n = c.Invoke[int32]("answer").GetAwaiter().GetResult()
                Console.WriteLine(n.ToString())
                let missing = Client()
                var threw = false
                try {
                    missing.Invoke[int32]("nope").GetAwaiter().GetResult()
                } catch (ex InvalidOperationException) {
                    threw = true
                }
                Console.WriteLine(threw.ToString())
            }
            """;

        Assert.Equal($"0{Environment.NewLine}True{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3592spill", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3592Spill.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
            IlVerifier.Verify(outputPath);
            var assembly = EmittedFixture.Load(outputPath);
            _ = assembly.GetTypes();
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");

            previousOut = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            return output.ToString();
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
