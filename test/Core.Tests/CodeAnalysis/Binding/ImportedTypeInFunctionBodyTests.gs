// <copyright file="ImportedTypeInFunctionBodyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Regression tests: imports of non-`System.*` namespaces must resolve
/// inside function and method bodies, not only in top-level statements.
///
/// Previously (cref:Binder.BindProgram(BoundGlobalScope, ReferenceResolver))
/// rebuilt the function-body parent scope with `references: null`, so those
/// scopes fell back to (cref:ReferenceResolver.Default) (core/System
/// assemblies only). Types from referenced libraries or third-party packages
/// (e.g. `Xunit.Assert`) therefore failed to resolve inside bodies even
/// though they resolved at top level. The resolver is now threaded through.
open class ImportedTypeInFunctionBodyTests {
    @Fact
    func ImportedType_Constructed_In_FreeFunction_Body_Resolves() {
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

func Run() string? {
    var g = ImportedGreeter()
    return g.Greet("world")
}`
        Assert.Empty(BindBodies(source))
    }

    @Fact
    func ImportedType_Constructed_In_Class_Method_Body_Resolves() {
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

class Host {
    func Run() string? {
        var g = ImportedGreeter()
        return g.Greet("world")
    }
}`
        Assert.Empty(BindBodies(source))
    }

    @Fact
    func BindProgramWithoutExplicitReferences_ReusesGlobalScopeResolverForImportedGenericTupleConstructors() {
        let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue4729_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(outputDirectory)
        try {
            let libraryPath = Path.Combine(outputDirectory, "Issue4729.Contract.dll")
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Issue4729.Contract

open class Carrier[X, Y] { }
class Reordered[X, Y] : Carrier[Y, X] { }`))){IsLibrary = true}
            {
                using let libraryStream = File.Create(libraryPath)
                let emitResult = library.Emit(
                    libraryStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue4729.Contract"
                )
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            using let resolver = ReferenceResolver.WithRuntimeReferences([]string{libraryPath})
            let consumerTree = SyntaxTree.Parse(SourceText.From(`package Issue4729.Consumer
import Issue4729.Contract

class Producer {
    func MakeCarrier() Carrier[(Text string?, Code int32), (Keep string, Code int32)] {
        return Carrier[(Text string?, Code int32), (Keep string, Code int32)]()
    }
    func MakeReordered() Reordered[(Keep string, Code int32), (Text string, Code int32)] {
        return Reordered[(Keep string, Code int32), (Text string, Code int32)]()
    }
}`))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(consumerTree), resolver)
            let program = Binder.BindProgram(globalScope)
            Assert.Empty(globalScope.Diagnostics.AddRange(program.Diagnostics))
        } finally {
            Directory.Delete(outputDirectory, recursive: true)
        }
    }

    shared {
        private func FixtureResolver() ReferenceResolver {
            let fixturePath = typeof(ImportedGreeter).Assembly.Location
            return ReferenceResolver.WithReferences([]string{fixturePath})
        }

        private func BindBodies(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), FixtureResolver())
            let program = Binder.BindProgram(globalScope, FixtureResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
