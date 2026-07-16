// <copyright file="Issue2403MethodCallVsImportedTypeInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2403: runtime (tree-walking interpreter) parity for the
/// call-vs-imported-type precedence fix in
/// <c>OverloadResolver.BindCallExpression</c>. These tests execute (not just
/// bind) call sites where a user method name collides with an imported CLR
/// type, confirming the interpreter actually dispatches to the user method's
/// body (observable via its return value) rather than constructing/converting
/// the CLR type.
/// </summary>
public class Issue2403MethodCallVsImportedTypeInterpreterTests
{
    [Fact]
    public void PrivateInstanceMethod_ClassArgument_ImportedClrTypeCollision_ExecutesUserMethod()
    {
        var source = """
            import System.Text

            class Profile {
                var Name string
            }

            class Service {
                private func StringBuilder(profile Profile) string {
                    return "user:" + profile.Name
                }

                func Run(profile Profile) string {
                    return StringBuilder(profile)
                }
            }

            var svc = Service{}
            svc.Run(Profile{Name: "abc"})
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("user:abc", output);
    }

    [Fact]
    public void ZeroArgument_ImportedClrTypeCollision_ExecutesUserMethod()
    {
        var source = """
            import System.Text

            class Service {
                func StringBuilder() string {
                    return "user-zero-arg"
                }

                func Run() string {
                    return StringBuilder()
                }
            }

            var svc = Service{}
            svc.Run()
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("user-zero-arg", output);
    }

    [Fact]
    public void MultiArgument_ImportedClrTypeCollision_ExecutesUserMethod()
    {
        var source = """
            import System.Text

            class Profile {
                var Name string
            }

            class Service {
                private func StringBuilder(a Profile, b Profile) string {
                    return a.Name + "-" + b.Name
                }

                func Run(a Profile, b Profile) string {
                    return StringBuilder(a, b)
                }
            }

            var svc = Service{}
            svc.Run(Profile{Name: "x"}, Profile{Name: "y"})
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("x-y", output);
    }

    [Fact]
    public void GenuineConstructorControl_NoUserMethod_StillConstructsClrTypeAtRuntime()
    {
        // Guardrail: with no colliding user method, `StringBuilder(16)` must
        // still construct the real CLR StringBuilder at runtime.
        var source = """
            import System.Text

            let sb = StringBuilder(16)
            sb.Capacity
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("16", output);
    }

    [Fact]
    public void ExactOahuCoreShape_AuthorizeHttpClient_ExecutesUserMethodAtRuntime()
    {
        // The exact Oahu.Core Authorize shape: a private instance method named
        // `HttpClient` colliding with the imported `System.Net.Http.HttpClient`
        // CLR type, invoked through implicit `this` across four call sites,
        // returning a nullable `IProfile`.
        var source = """
            import System.Net.Http

            interface IProfile {
                prop Authorization string { get; }
            }

            class Profile : IProfile {
                prop Authorization string { get; set; }
            }

            class Authorize {
                private func HttpClient(profile IProfile) IProfile? {
                    return profile
                }

                func Run(a IProfile, b IProfile, c IProfile, d IProfile) IProfile? {
                    let x = HttpClient(a)
                    let y = HttpClient(b)
                    let z = HttpClient(c)
                    return HttpClient(d)
                }
            }

            var auth = Authorize{}
            var p = Profile{Authorization: "tok"}
            var result = auth.Run(p, p, p, p)
            result?.Authorization
            """;

        var output = RunSubmission(source);
        Assert.DoesNotContain("error", output, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("tok", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
