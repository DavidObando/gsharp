// <copyright file="Issue4680EscapedNamedArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4680: argument spelling must not change a parameter's CLR identity.</summary>
public sealed class Issue4680EscapedNamedArgumentEmitTests
{
    [Fact]
    public void ImportedParameters_EscapesPreserveSlotsDefaultsReferencesAndResultTypes()
    {
        InDirectory(directory =>
        {
            const string librarySource = """
                #nullable enable
                namespace ParameterLib;
                public enum ProtectionScope { CurrentUser }
                public sealed class Api
                {
                    public Api(int scope, int scope_) { Value = scope * 10 + scope_; }
                    public int Value { get; }
                    public static byte[] Protect(byte[] data, byte[]? optionalEntropy, ProtectionScope scope) => data;
                    public static byte[] Unprotect(byte[] encrypted, byte[]? optionalEntropy, ProtectionScope scope) => encrypted;
                    public static int Optional(int scope = 2, int scope_ = 3) => scope * 10 + scope_;
                    public static void Update(ref int scope, out int scope_) { scope += 4; scope_ = scope * 2; }
                    public static int Sum(params int[] scope) => System.Linq.Enumerable.Sum(scope);
                    public static T Map<T>(T value, System.Func<T, T> scope) => scope(value);
                }
                """;
            var libraryPath = Path.Combine(directory, "ParameterLib.dll");
            var compilation = CSharpCompilation.Create(
                "ParameterLib",
                new[] { CSharpSyntaxTree.ParseText(librarySource) },
                RuntimeReferences().Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var result = compilation.Emit(libraryPath);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            var library = EmittedFixture.Load(libraryPath);
            var api = library.GetType("ParameterLib.Api", throwOnError: true);
            Assert.NotNull(api);
            Assert.Equal(
                new[] { "scope", "scope_" },
                api.GetMethod("Optional").GetParameters().Select(parameter => parameter.Name));
            var update = api.GetMethod("Update").GetParameters();
            Assert.Equal(2, update.Length);
            Assert.True(update[0].ParameterType.IsByRef);
            Assert.True(update[1].IsOut);
            Assert.True(api.GetMethod("Optional").GetParameters().All(parameter => parameter.IsOptional));
            Assert.NotEmpty(api.GetMethod("Sum").GetParameters()[0].GetCustomAttributes<ParamArrayAttribute>());

            const string source = """
                package EscapedImported
                import System
                import System.IO
                import System.Text
                import ParameterLib

                func Run() string {
                    let encrypted = Api.Protect(Encoding.UTF8.GetBytes("ok"), optionalEntropy: nil, $scope: ProtectionScope.CurrentUser)
                    let json = Api.Unprotect(encrypted, optionalEntropy: nil, $scope: ProtectionScope.CurrentUser)
                    let stream = MemoryStream()
                    stream.Write(encrypted)
                    var value = 1
                    var doubled = 0
                    Api.Update($scope: &value, scope_: out doubled)
                    let box = Api(scope_: 7, $scope: 3)
                    return Encoding.UTF8.GetString(json) + "," + stream.Length.ToString() + "," +
                        Api.Optional(scope_: 8).ToString() + "," + Api.Optional($scope: 5).ToString() + "," +
                        value.ToString() + "," + doubled.ToString() + "," + box.Value.ToString() + "," +
                        Api.Sum($scope: []int32{2, 3}).ToString() + "," +
                        Api.Map(value: 6, $scope: x -> x + 1).ToString()
                }
                """;
            var output = Compile(directory, source, libraryPath);
            Assert.True(output.Exit == 0, output.Diagnostics);
            Assert.DoesNotContain("GS0246", output.Diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0159", output.Diagnostics, StringComparison.Ordinal);
            IlVerifier.Verify(output.Path, new[] { libraryPath });
            var assemblies = EmittedFixture.LoadTogether(libraryPath, output.Path);
            var program = assemblies[1].GetTypes().Single(type => type.Name == "<Program>");
            Assert.Equal("ok,2,28,53,5,10,37,5,7", program.GetMethod("Run", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null));
        });
    }

    [Fact]
    public void SourceParameters_EscapedAndPlainNamesShareIdentityAndLexicalEvaluationOrder()
    {
        InDirectory(directory =>
        {
            const string source = """
                package EscapedSource
                var trace = ""
                func mark(label string, value int32) int32 {
                    trace = trace + label
                    return value
                }
                func consume($scope int32, value int32) string -> trace + ":" + $scope.ToString() + ":" + value.ToString() + ":" + nameof($scope)
                func Run() string {
                    let first = consume($value: mark("V", 2), $scope: mark("S", 1))
                    trace = ""
                    return first + "|" + consume($scope: mark("S", 3), value: mark("V", 4))
                }
                """;
            var output = Compile(directory, source);
            Assert.True(output.Exit == 0, output.Diagnostics);
            IlVerifier.Verify(output.Path);
            var assembly = EmittedFixture.Load(output.Path);
            Assert.NotNull(assembly.EntryPoint);
            assembly.EntryPoint.Invoke(null, new object[] { Array.Empty<string>() });
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
            var consume = program.GetMethod("consume", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(consume);
            Assert.Equal(new[] { "scope", "value" }, consume.GetParameters().Select(parameter => parameter.Name));
            Assert.Equal("VS:1:2:scope|SV:3:4:scope", program.GetMethod("Run", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null));
        });
    }

    [Theory]
    [InlineData("value: 1, $value: 2", "GS0245", "Named argument 'value' specified more than once.", 32)]
    [InlineData("$missing: 1", "GS0246", "Named argument 'missing' does not match any parameter of 'consume'.", 22)]
    public void InvalidNames_ReportSemanticNameAtOriginalSourcePosition(string arguments, string id, string message, int column)
    {
        InDirectory(directory =>
        {
            var source = "func consume(value int32) int32 -> value\nlet result = consume(" + arguments + ")\n";
            var output = Compile(directory, source);
            Assert.NotEqual(0, output.Exit);
            Assert.False(File.Exists(output.Path));
            Assert.Contains(id, output.Diagnostics, StringComparison.Ordinal);
            Assert.Contains(message, output.Diagnostics, StringComparison.Ordinal);
            Assert.Contains($"(2,{column},2,{column + arguments.Substring(arguments.LastIndexOf('$')).IndexOf(':')})", output.Diagnostics, StringComparison.Ordinal);
        });
    }

    private static (int Exit, string Diagnostics, string Path) Compile(string directory, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var assemblyPath = Path.Combine(directory, "Fixture.dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new[] { "/target:exe", "/out:" + assemblyPath, "/targetframework:net10.0" }
            .Concat(RuntimeReferences().Concat(references).Select(path => "/reference:" + path))
            .Append(sourcePath)
            .ToArray();
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exit = Program.Main(arguments);
            return (exit, stdout.ToString() + stderr, assemblyPath);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string[] RuntimeReferences() =>
        Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");

    private static void InDirectory(Action<string> test)
    {
        var directory = Path.Combine(Path.GetTempPath(), "gs_issue4680_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            test(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
