// <copyright file="Issue4233ReferenceResolverIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4233 — emit-level regression: `ReferenceResolverTests` only
/// asserted which (cref:Type) `ReferenceResolver.TryResolveType`
/// selects; it would stay green even if a later emit-site (e.g.
/// `ImportedMemberRefFactory`'s host-type-to-reference-closure
/// projection, or any other TypeRef-scoping helper) still wrote a TypeRef into
/// the inaccessible duplicate assembly. This test compiles a real G# program
/// against a reference closure carrying BOTH an internal (first-declared) and
/// a public duplicate of the same full type name — mirroring
/// `Microsoft.TestPlatform.Utilities`'s private
/// `System.Diagnostics.CodeAnalysis.NotNullWhenAttribute` polyfill
/// shadowing the real, public BCL type — emits the assembly, runs the actual
/// `ilverify` gate over it (the exact tool that caught the original
/// `MethodAccess` failure), and inspects the emitted metadata directly to
/// confirm the TypeRef targets the public assembly.
open class Issue4233ReferenceResolverIlVerifyTests {
    @Fact
    func AmbiguousDuplicateTypeArgument_EmitsPublicTypeRef_AndIlVerifies() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-4233-emit", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            // First-declared, inaccessible duplicate — mirrors
            // Microsoft.TestPlatform.Utilities' private NotNullWhenAttribute
            // polyfill landing ahead of the real BCL type in the raw,
            // first-writer-wins reference index.
            let internalPath = EmitCollisionAssembly(directory, "InternalAttributeShim", "internal")
            // Second-declared, accessible duplicate — mirrors the real, public
            // System.Diagnostics.CodeAnalysis.NotNullWhenAttribute.
            let publicPath = EmitCollisionAssembly(directory, "PublicFrameworkType", "public")
            using let resolver = ReferenceResolver.WithReferences([]string{internalPath, publicPath})
            // A generic method type argument is exactly the shape the original
            // bug hit: `receiver.GetCustomAttributes<NotNullWhenAttribute>()`
            // in the translated Core.Tests self-migration emitted a MethodSpec
            // whose type argument TypeRef pointed at the inaccessible shim.
            // `Array.Empty[MarkerAttribute]()` reproduces the same shape (a
            // BCL generic method instantiated with the ambiguous type) without
            // needing the whole self-migration pipeline.
            const source = `package Repro4233
import ResolverCollision3445
import System

func Make() []MarkerAttribute {
    return Array.Empty[MarkerAttribute]()
}`
            let outPath = Path.Combine(directory, "Repro4233.dll")
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            {
                using let peStream = File.Create(outPath)
                let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Repro4233")
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            // The actual regression gate: previously, gsc emitted a TypeRef
            // into the private InternalAttributeShim polyfill, and ilverify
            // failed with [MethodAccess] "Method is not visible" — the exact
            // failure reported in issue #4233. Assert it is gone.
            IlVerifier.Verify(outPath, additionalReferences: []string{internalPath, publicPath})
            // Directly confirm the emitted TypeRef targets the PUBLIC
            // duplicate, not merely that ilverify tolerates the output — the
            // metadata identity is the thing issue #4233 actually regressed.
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let mlcPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly).Concat(
                []string{outPath, internalPath, publicPath}
            )
            using let mlc = MetadataLoadContext(
                PathAssemblyResolver(mlcPaths),
                coreAssemblyName: "System.Private.CoreLib"
            )
            let emitted = mlc.LoadFromAssemblyPath(outPath)
            let make = emitted
                .GetTypes()
                .SelectMany(
                func (t Type) IEnumerable[MethodInfo] {
                    return t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                }
            )
                .Single((m MethodInfo) -> m.Name == "Make")
            let elementType Type? = make.ReturnType.GetElementType()
            Assert.NotNull(elementType)
            Assert.Equal("PublicFrameworkType", elementType!!.Assembly.GetName().Name)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func EmitCollisionAssembly(directory string, assemblyName string, accessibility string) string {
            let path = Path.Combine(directory, assemblyName + ".dll")
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        "namespace ResolverCollision3445; $accessibility sealed class MarkerAttribute { }"
                    )
                },
                []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }
    }
}
