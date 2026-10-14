// <copyright file="Issue698DeinitBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #698 / ADR-0068: binder-level tests for the Swift-style
/// `deinit { … }` destructor on classes. The interpreter-boundary
/// GS0510 warning ("deinitializer will not run under the interpreter")
/// retired with the tree-walking evaluator in ADR-0156 Phase 3c (#3176) —
/// deinit simply works under emitted execution, so valid deinit sources now
/// bind clean.
open class Issue698DeinitBinderTests {
    @Fact
    func Deinit_PopulatesDeinitializerSymbol() {
        let source = `
class Resource {
    var Handle int32 = 0
    deinit {
    }
}
`
        let (diagnostics, structs) = BindAndGetStructs(source)
        Assert.Empty(diagnostics)
        let resource = structs.Single((s StructSymbol) -> s.Name == "Resource")
        Assert.NotNull(resource.Deinitializer)
        Assert.Equal("Finalize", resource.Deinitializer!!.Function.Name)
        Assert.Empty(resource.Deinitializer!!.Function.Parameters)
        Assert.True(resource.Deinitializer!!.Function.ReceiverType == resource)
    }

    @Fact
    func Deinit_BodyHasAccessToFieldsAndThis() {
        let source = `
import System
class Resource {
    var Tag string = ""
    deinit {
        Console.WriteLine(Tag)
    }
}
`
        let (diagnostics, _) = BindAndGetStructs(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Deinit_OnStruct_IsRejected() {
        let source = `
struct Point {
    var X int32 = 0
    deinit {
    }
}
`
        let (diagnostics, _) = BindAndGetStructs(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0289")
    }

    @Fact
    func Deinit_DuplicateOnSameClass_IsRejected() {
        let source = `
class Resource {
    var Handle int32 = 0
    deinit {
    }
    deinit {
    }
}
`
        let (diagnostics, _) = BindAndGetStructs(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0290")
    }

    @Fact
    func Deinit_CannotBeCalledExplicitly() {
        // ADR-0068: the synthesized Finalize override is not in the user's
        // member-lookup surface — `obj.deinit()` cannot resolve.
        let source = `
import System
class Resource {
    var Handle int32 = 0
    deinit {
    }
}

var r = Resource()
r.deinit()
`
        let (diagnostics, _) = BindAndGetStructs(source)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func Deinit_OnSubclass_BindsSeparately() {
        let source = `
open class Resource(Tag string) {
    deinit {
    }
}
class CachedResource : Resource {
    var Key string = ""
    init(t string) : base(t) {
    }
    deinit {
    }
}
`
        let (diagnostics, structs) = BindAndGetStructs(source)
        Assert.Empty(diagnostics)
        let resource = structs.Single((s StructSymbol) -> s.Name == "Resource")
        let cached = structs.Single((s StructSymbol) -> s.Name == "CachedResource")
        Assert.NotNull(resource.Deinitializer)
        Assert.NotNull(cached.Deinitializer)
        Assert.NotSame(resource.Deinitializer, cached.Deinitializer)
    }

    shared {
        // Binder-inspection shape (ADR-0156 Phase 3c, #3176): fully bind and
        // collect diagnostics without executing — these tests assert bound
        // symbols and binder diagnostics, never runtime behavior.
        private func BindAndGetStructs(source string)(
            Diagnostics ImmutableArray[Diagnostic],
            Structs IEnumerable[StructSymbol]
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
            let structs = compilation.GlobalScope.Structs
            return (diagnostics, structs)
        }
    }
}
