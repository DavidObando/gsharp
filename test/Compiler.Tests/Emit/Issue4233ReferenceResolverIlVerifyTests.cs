// <copyright file="Issue4233ReferenceResolverIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4233 — emit-level regression: <c>ReferenceResolverTests</c> only
/// asserted which <see cref="Type"/> <c>ReferenceResolver.TryResolveType</c>
/// selects; it would stay green even if a later emit-site (e.g.
/// <c>ImportedMemberRefFactory</c>'s host-type-to-reference-closure
/// projection, or any other TypeRef-scoping helper) still wrote a TypeRef into
/// the inaccessible duplicate assembly. This test compiles a real G# program
/// against a reference closure carrying BOTH an internal (first-declared) and
/// a public duplicate of the same full type name — mirroring
/// <c>Microsoft.TestPlatform.Utilities</c>'s private
/// <c>System.Diagnostics.CodeAnalysis.NotNullWhenAttribute</c> polyfill
/// shadowing the real, public BCL type — emits the assembly, runs the actual
/// <c>ilverify</c> gate over it (the exact tool that caught the original
/// <c>MethodAccess</c> failure), and inspects the emitted metadata directly to
/// confirm the TypeRef targets the public assembly.
/// </summary>
public class Issue4233ReferenceResolverIlVerifyTests
{
    [Fact]
    public void AmbiguousDuplicateTypeArgument_EmitsPublicTypeRef_AndIlVerifies()
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue-4233-emit",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            // First-declared, inaccessible duplicate — mirrors
            // Microsoft.TestPlatform.Utilities' private NotNullWhenAttribute
            // polyfill landing ahead of the real BCL type in the raw,
            // first-writer-wins reference index.
            string internalPath = EmitCollisionAssembly(directory, "InternalAttributeShim", "internal");

            // Second-declared, accessible duplicate — mirrors the real, public
            // System.Diagnostics.CodeAnalysis.NotNullWhenAttribute.
            string publicPath = EmitCollisionAssembly(directory, "PublicFrameworkType", "public");

            using var resolver = ReferenceResolver.WithReferences(new[] { internalPath, publicPath });

            // A generic method type argument is exactly the shape the original
            // bug hit: `receiver.GetCustomAttributes<NotNullWhenAttribute>()`
            // in the translated Core.Tests self-migration emitted a MethodSpec
            // whose type argument TypeRef pointed at the inaccessible shim.
            // `Array.Empty[MarkerAttribute]()` reproduces the same shape (a
            // BCL generic method instantiated with the ambiguous type) without
            // needing the whole self-migration pipeline.
            const string source = """
                package Repro4233
                import ResolverCollision3445
                import System

                func Make() []MarkerAttribute {
                    return Array.Empty[MarkerAttribute]()
                }
                """;

            string outPath = Path.Combine(directory, "Repro4233.dll");
            var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                IsLibrary = true,
            };

            using (var peStream = File.Create(outPath))
            {
                var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Repro4233");
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            }

            // The actual regression gate: previously, gsc emitted a TypeRef
            // into the private InternalAttributeShim polyfill, and ilverify
            // failed with [MethodAccess] "Method is not visible" — the exact
            // failure reported in issue #4233. Assert it is gone.
            IlVerifier.Verify(outPath, additionalReferences: new[] { internalPath, publicPath });

            // Directly confirm the emitted TypeRef targets the PUBLIC
            // duplicate, not merely that ilverify tolerates the output — the
            // metadata identity is the thing issue #4233 actually regressed.
            string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var mlcPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
                .Concat(new[] { outPath, internalPath, publicPath });
            using var mlc = new System.Reflection.MetadataLoadContext(
                new PathAssemblyResolver(mlcPaths),
                coreAssemblyName: "System.Private.CoreLib");
            var emitted = mlc.LoadFromAssemblyPath(outPath);
            var make = emitted.GetTypes()
                .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .Single(m => m.Name == "Make");
            var elementType = make.ReturnType.GetElementType();
            Assert.NotNull(elementType);
            Assert.Equal("PublicFrameworkType", elementType!.Assembly.GetName().Name);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string EmitCollisionAssembly(
        string directory,
        string assemblyName,
        string accessibility)
    {
        string path = Path.Combine(directory, assemblyName + ".dll");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    $"namespace ResolverCollision3445; {accessibility} sealed class MarkerAttribute {{ }}"),
            },
            new[]
            {
                MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using FileStream stream = File.Create(path);
        Microsoft.CodeAnalysis.Emit.EmitResult result = compilation.Emit(stream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
