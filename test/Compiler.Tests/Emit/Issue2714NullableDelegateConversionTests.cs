// <copyright file="Issue2714NullableDelegateConversionTests.cs" company="GSharp">
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

/// <summary>Issue #2714: delegate signatures ignore nullable-reference annotations.</summary>
public sealed class Issue2714NullableDelegateConversionTests
{
    [Fact]
    public void ClrMethodGroup_NullableObliviousDelegateParameter_BindsAndRuns()
    {
        const string source = """
            package Issue2714
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
        var result = compilation.Emit(stream, null, null, "Issue2714ClrRuntime");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        stream.Position = 0;
        var context = new AssemblyLoadContext("Issue2714ClrRuntime", isCollectible: true);
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
    public void OahuAudibleClient_MethodGroupAndEquivalentLambda_Bind()
    {
        const string source = """
            package Issue2714

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
                            let lambdaApi = AudibleApi(
                                (profile IProfile) -> authorize!!.RefreshTokenAsync(profile))
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
        var result = compilation.Emit(stream, null, null, "Issue2714AudibleClient");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void UserImportedAndNestedGenericDelegateConversions_Run()
    {
        const string source = """
            package Issue2714Runtime
            import System
            import System.Collections.Generic

            interface IProfile { }
            class Profile : IProfile { }

            func ProfileCode(profile IProfile) int32 -> 7
            func TextLength(value string) int32 -> value.Length
            func MaybeText() string? -> "ok"
            func Count(values List[string]) int32 -> values.Count

            func Invoke(callback (IProfile?) -> int32) int32 ->
                callback(Profile{})

            func Main() {
                let userMethod = Invoke(ProfileCode)
                let userLambda = Invoke((profile IProfile) -> 8)
                let importedMethod Func[string?, int32] = TextLength
                let importedLambda Func[string?, int32] =
                    (value string) -> value.Length
                let nullableReturn Func[string] = MaybeText
                let genericMethod Func[List[string?], int32] = Count
                let values = List[string?]()
                values.Add("x")

                Console.WriteLine(
                    userMethod + userLambda +
                    importedMethod("abc") + importedLambda("four") +
                    nullableReturn().Length + genericMethod(values))
            }
            """;

        Assert.Equal("25\n", CompileAndRun(source, "Issue2714Runtime"));
    }

    [Theory]
    [MemberData(nameof(TrueSignatureMismatches))]
    public void TrueSignatureMismatches_RemainErrors(string source, string diagnosticId)
    {
        using var resolver = ReferenceResolver.WithReferences([]);
        var compilation = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, null, null, "Issue2714Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == diagnosticId);
    }

    public static TheoryData<string, string> TrueSignatureMismatches => new()
    {
        {
            """
            package Issue2714WrongType
            class Source {
                func Convert(value int32) int32 -> value
                func Convert(value bool) int32 -> 0
            }
            func Use(callback (string) -> int32) { }
            Use(Source{}.Convert)
            """,
            "GS0218"
        },
        {
            """
            package Issue2714WrongArity
            class Source {
                func Convert(value int32) int32 -> value
                func Convert(a int32, b int32, c int32) int32 -> a
            }
            func Use(callback (int32, int32) -> int32) { }
            Use(Source{}.Convert)
            """,
            "GS0218"
        },
        {
            """
            package Issue2714ValueNullable
            class Source {
                func Convert(value int32) int32 -> value
                func Convert(value string) int32 -> 0
            }
            func Use(callback (int32?) -> int32) { }
            Use(Source{}.Convert)
            """,
            "GS0218"
        },
        {
            """
            package Issue2714RefKind
            type RefCallback = delegate func(ref value int32)
            class Source {
                func Change(value int32) { }
                func Change(value string) { }
            }
            let callback RefCallback = Source{}.Change
            """,
            "GS0218"
        },
        {
            """
            package Issue2714LambdaType
            func Use(callback (string) -> int32) { }
            Use((value int32) -> value)
            """,
            "GS0154"
        },
    };

    private static string CompileAndRun(string source, string assemblyName)
    {
        using var resolver = ReferenceResolver.WithReferences([]);
        var compilation = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream, null, null, assemblyName);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        stream.Position = 0;
        var context = new AssemblyLoadContext(assemblyName, isCollectible: true);
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

            return output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            context.Unload();
        }
    }
}
