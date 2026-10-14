// <copyright file="Issue1585StaticBareCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1585: an unqualified (bare-name) call from inside a static
/// (`shared`) method body to a sibling static method of the same type must
/// resolve — just like the same call qualified with the type name, and just
/// like a bare call to a static sibling from an instance method body. Before
/// the fix static-method bodies were not searched against the enclosing type's
/// own static method group, so such calls reported `GS0130`
/// ("Function '…' doesn't exist.").
/// Every scenario is asserted under BOTH the live-reflection
/// ((cref:ReferenceResolver.Default)) resolver and the
/// (cref:System.Reflection.MetadataLoadContext)-backed
/// ((cref:ReferenceResolver.WithReferences)) resolver, since the SDK
/// build path uses the latter.
open class Issue1585StaticBareCallTests {
    // Non-generic static -> static bare call.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_NonGeneric_Resolves(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Generic static -> static bare call with explicit type arguments.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_GenericExplicitTypeArgs_Resolves(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller[T class init()]() T { return Helper[T]() }
        private func Helper[T class init()]() T { return T() }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Generic static -> static bare call with INFERRED type arguments.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_GenericInferredTypeArgs_Resolves(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller(x int32) int32 { return Ident(x) }
        private func Ident[T](v T) T { return v }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Overloaded static siblings — the correct overload is picked by arity.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_OverloadedSiblings_Resolve(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller() int32 { return Add(1) + Add(1, 2) }
        private func Add(a int32) int32 { return a }
        private func Add(a int32, b int32) int32 { return a + b }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Default-parameter static sibling — the omitted trailing slot is filled.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_DefaultParameter_Resolves(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller() int32 { return Add(1) }
        private func Add(a int32, b int32 = 5) int32 { return a + b }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // A user struct behaves the same as a class for static-self dispatch.
    @Theory
    @MemberData("Resolvers")
    func StaticToStatic_BareCall_OnStruct_Resolves(withReferences bool) {
        let source = `
package p
struct S {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 7 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — the qualified `Type.Helper[T]()` static call still resolves.
    @Theory
    @MemberData("Resolvers")
    func QualifiedStaticCall_FromStaticCaller_StillResolves(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller[T class init()]() T { return M.Helper[T]() }
        private func Helper[T class init()]() T { return T() }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — a bare call to a static sibling from an INSTANCE body still
    // resolves (the path that always worked; guards against a regression).
    @Theory
    @MemberData("Resolvers")
    func InstanceToStatic_BareCall_StillResolves(withReferences bool) {
        let source = `
package p
class M {
    func Caller[T class init()]() T { return Helper[T]() }
    shared {
        private func Helper[T class init()]() T { return T() }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — a genuinely undefined bare call from a static body still reports
    // GS0130 (the fix must not swallow real "not found" diagnostics).
    @Theory
    @MemberData("Resolvers")
    func StaticBareCall_UndefinedName_StillReportsGs0130(withReferences bool) {
        let source = `
package p
class M {
    shared {
        func Caller() int32 { return Nope() }
    }
}
`
        let diagnostics = Bind(source, withReferences)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("'Nope' doesn't exist"))
    }

    shared {
        func Resolvers() TheoryData[bool] -> TheoryData[bool]{false, true}

        private func AssertNoErrors(source string, withReferences bool) {
            let diagnostics = Bind(source, withReferences)
            Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
        }

        private func Bind(source string, withReferences bool) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                CreateResolver(withReferences)
            )
            let program = Binder.BindProgram(globalScope, CreateResolver(withReferences))
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func CreateResolver(withReferences bool) ReferenceResolver {
            if !withReferences {
                return ReferenceResolver.Default()
            }
            let paths = []string{typeof(object).Assembly.Location, typeof(Console).Assembly.Location}
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
