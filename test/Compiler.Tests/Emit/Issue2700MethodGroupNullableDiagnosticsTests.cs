// <copyright file="Issue2700MethodGroupNullableDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2700: failed method-group conversions are diagnosed before emit.</summary>
public sealed class Issue2700MethodGroupNullableDiagnosticsTests
{
    [Fact]
    public void ClrMethodGroup_NullableObliviousDelegateParameter_BindsAndRuns()
    {
        const string source = """
            package Issue2700
            import System

            class Runner {
                private var callback (string?) -> void

                init(callback (string?) -> void) {
                    this.callback = callback
                }

                func Run() {
                    callback("ok")
                }
            }

            func Main() {
                let runner = Runner(Console.WriteLine)
                runner.Run()
            }
            """;

        using var resolver = ReferenceResolver.WithReferences([]);
        var compilation = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, null, null, "Issue2700Runtime");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        stream.Position = 0;
        var context = new AssemblyLoadContext("Issue2700Runtime", isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(stream);
            var previous = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(previous);
            }

            Assert.Equal("ok\n", output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void OahuAudibleClientMethodGroup_NullableParameterMismatch_ReportsSourceDiagnostic()
    {
        const string source = """
            package Issue2700

            interface IProfile { }

            class Authorize {
                async func RefreshTokenAsync(profile IProfile) { }
                internal async func RefreshTokenAsync(profile IProfile?, automatic bool) { }
            }

            class AudibleApi {
                init(refreshTokenAsyncFunc async (IProfile?) -> void) { }
            }

            class AudibleClient {
                private var authorize Authorize?
                private var audibleApi AudibleApi?

                prop Api AudibleApi? {
                    get {
                        if audibleApi == nil {
                            audibleApi = AudibleApi(authorize!!.RefreshTokenAsync)
                        }
                        return audibleApi!!
                    }
                }
            }
            """;

        using var resolver = ReferenceResolver.WithReferences([]);
        var compilation = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, null, null, "Issue2700Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0218");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }
}
