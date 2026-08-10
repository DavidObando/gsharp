// <copyright file="Issue3065MethodSpecRemapKeyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue3065MethodSpecRemapKeyTests
{
    private const string Source = """
        package MsProbe
        import System

        func Remap[A, B](first A, value B) B {
            var outer = Array.Empty[B]()
            let f (B) -> B = (innerValue B) -> {
                var inner = Array.Empty[B]()
                return innerValue
            }
            return f(value)
        }

        Console.WriteLine(Remap[int32, int32](0, 11))
        Console.WriteLine(Remap[int32, int32](0, 22))
        """;

    private const string RepeatedSource = """
        package MsProbe
        import System

        func Remap[A, B](first A, value B) B {
            var outer = Array.Empty[B]()
            let f (B) -> B = (innerValue B) -> {
                var inner = Array.Empty[B]()
                var innerAgain = Array.Empty[B]()
                return innerValue
            }
            return f(value)
        }

        Console.WriteLine(Remap[int32, int32](0, 11))
        """;

    [Fact]
    public void MethodSpecSymbolKey_DifferentRemapScopes_AreNotEqual()
    {
        var method = typeof(Array)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(candidate => candidate.Name == nameof(Array.Empty))
            .MakeGenericMethod(typeof(object));
        var typeArguments = ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32);
        var classRemap = new Dictionary<TypeParameterSymbol, int>();
        var methodRemap = new Dictionary<TypeParameterSymbol, int>();

        var key = new MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            new RemapScope(classRemap, methodRemap));
        var sameScopes = new MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            new RemapScope(classRemap, methodRemap));
        var differentClassScope = new MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            new RemapScope(new Dictionary<TypeParameterSymbol, int>(), methodRemap));
        var differentMethodScope = new MetadataTokenCache.MethodSpecSymbolKey(
            method,
            typeArguments,
            new RemapScope(classRemap, new Dictionary<TypeParameterSymbol, int>()));

        Assert.Equal(key, sameScopes);
        Assert.NotEqual(key, differentClassScope);
        Assert.NotEqual(key, differentMethodScope);
    }

    [Fact]
    public void GenericLambdaMethodSpecs_WithDistinctRemaps_EmitRunnableAssembly()
    {
        var assembly = Assembly.Load(Emit());
        Assert.NotEmpty(assembly.GetTypes());
        var entryPoint = Assert.IsAssignableFrom<MethodInfo>(assembly.EntryPoint);

        var previousOut = Console.Out;
        using var output = new StringWriter();
        Console.SetOut(output);
        try
        {
            entryPoint.Invoke(
                null,
                entryPoint.GetParameters().Length == 0
                    ? null
                    : new object[] { Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}", output.ToString().ReplaceLineEndings(Environment.NewLine));
    }

    [Fact]
    public void GenericLambdaMethodSpecs_RepeatedCallUsesCachedRow()
    {
        using var peReader = new PEReader(new MemoryStream(Emit(RepeatedSource)));
        var metadata = peReader.GetMetadataReader();
        var emptyMethodSpecs = Enumerable.Range(1, metadata.GetTableRowCount(TableIndex.MethodSpec))
            .Select(row =>
            {
                var handle = MetadataTokens.MethodSpecificationHandle(row);
                return metadata.GetMethodSpecification(handle);
            })
            .Count(spec =>
                spec.Method.Kind == HandleKind.MemberReference
                && metadata.GetString(metadata.GetMemberReference((MemberReferenceHandle)spec.Method).Name)
                    == nameof(Array.Empty));

        Assert.Equal(2, emptyMethodSpecs);
    }

    private static byte[] Emit(string source = Source)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var emitResult = compilation.Emit(peStream);

        Assert.True(
            emitResult.Success,
            "compilation should succeed: " +
            string.Join("; ", emitResult.Diagnostics.Select(diagnostic => diagnostic.Message)));
        return peStream.ToArray();
    }
}
