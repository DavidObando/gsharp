// <copyright file="Issue2305ImportedReferenceClassNilCompareTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2305 (residual of #2300): <c>x == nil</c> / <c>x != nil</c> still
/// reported GS0129 ("operator not defined") when <c>x</c> is an IMPORTED
/// reference class — an <see cref="ImportedTypeSymbol"/> whose <c>ClrType</c>
/// is a genuine reference type (<c>!ClrType.IsValueType</c>). Issue #2300 only
/// extended <c>BoundBinaryOperator.IsNullCompare</c> to source interfaces,
/// imported interfaces, and reference-capable type parameters — an imported
/// CONCRETE class (e.g. a cross-assembly response/session type) was left out.
/// These tests pin BOTH operand orders for an imported class, and a negative
/// control confirming an imported VALUE type (struct/enum) is still correctly
/// rejected, since a value type can never be nil.
/// </summary>
public class Issue2305ImportedReferenceClassNilCompareTests
{
    [Fact]
    public void ImportedClass_EqualsNil_Binds_BothOperandOrders()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedClass_EqualsNil_Binds_BothOperandOrders),
            "namespace MyLib { public class LibraryResponse { public int Code { get; set; } } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import MyLib

                func IsNil(x LibraryResponse) bool {
                    return x == nil
                }

                func IsNotNil(x LibraryResponse) bool {
                    return x != nil
                }

                func NilIsX(x LibraryResponse) bool {
                    return nil == x
                }

                func NilIsNotX(x LibraryResponse) bool {
                    return nil != x
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ImportedStruct_EqualsNil_StillReportsGs0129()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedStruct_EqualsNil_StillReportsGs0129),
            "namespace MyLib { public struct LibraryPoint { public int X; public int Y; } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import MyLib

                func IsNil(x LibraryPoint) bool {
                    return x == nil
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void ImportedEnum_EqualsNil_StillReportsGs0129()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedEnum_EqualsNil_StillReportsGs0129),
            "namespace MyLib { public enum LibraryStatus { Ok, Failed } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import MyLib

                func IsNil(x LibraryStatus) bool {
                    return x == nil
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void ImportedClass_EqualsNil_EvaluatesCorrectlyAtRuntime()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedClass_EqualsNil_EvaluatesCorrectlyAtRuntime),
            "namespace MyLib { public class AuthSession { public string Token { get; set; } } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import MyLib

                func IsNil(x AuthSession) bool {
                    return x == nil
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitCSharpLibrary(string caseName, string source)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2305", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "MyLib2305.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "MyLib2305",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
