// <copyright file="Issue3660NestedTypeEnclosingStaticBareCallTests.cs" company="GSharp">
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

/// Issue #3660: an unqualified (bare-name) call from inside a NESTED type's body
/// to a `shared` (static) method of a LEXICALLY ENCLOSING type must resolve
/// — C# §7.4 scoping, where a nested class sees the outer class's static members
/// (including its `private` ones) without qualification. Before the fix the
/// bare-call binder consulted only the nested type's own member set, its base
/// chain, package functions and imports, never the enclosing type chain
/// ((cref:Symbol.ContainingType), ADR-0110 / issue #910), so such calls
/// reported `GS0130` ("Function '…' doesn't exist.") plus a
/// `GS0159` cascade off the errored receiver of any chained call.
/// Every scenario is asserted under BOTH the live-reflection
/// ((cref:ReferenceResolver.Default)) resolver and the
/// (cref:System.Reflection.MetadataLoadContext)-backed
/// ((cref:ReferenceResolver.WithReferences)) resolver, since the SDK
/// build path uses the latter.
open class Issue3660NestedTypeEnclosingStaticBareCallTests {
    // Instance body of a nested class -> non-generic static of the outer class.
    @Theory
    @MemberData("Resolvers")
    func NestedInstance_BareCall_OuterStatic_NonGeneric_Resolves(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper(3) }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // The self-migration shape: explicit type arguments plus a chained call on
    // the result (`FindNodes[T](root).ToArray()` in SemanticLookup.gs).
    @Theory
    @MemberData("Resolvers")
    func NestedInstance_BareCall_OuterStatic_GenericExplicitTypeArgs_Resolves(withReferences bool) {
        let source = `
package p
import System.Collections.Generic
import System.Linq
class Outer {
    class Inner {
        func Caller() []string { return Wrap[string]("a").ToArray() }
    }
    shared {
        private func Wrap[T](value T) sequence[T] { yield value }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Inferred type arguments resolve through the same path.
    @Theory
    @MemberData("Resolvers")
    func NestedInstance_BareCall_OuterStatic_GenericInferredTypeArgs_Resolves(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller(x int32) int32 { return Ident(x) }
    }
    shared {
        private func Ident[T](v T) T { return v }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // An overload set on the enclosing type — the arity-correct member is picked.
    @Theory
    @MemberData("Resolvers")
    func NestedInstance_BareCall_OuterStaticOverloads_Resolve(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Add(1) + Add(1, 2) }
    }
    shared {
        private func Add(a int32) int32 { return a }
        private func Add(a int32, b int32) int32 { return a + b }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // A `shared` body of the nested type reaches the enclosing type's statics too
    // (no `this` in scope; the walk starts from StaticOwnerType).
    @Theory
    @MemberData("Resolvers")
    func NestedStatic_BareCall_OuterStatic_Resolves(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        shared {
            func Caller() int32 { return Helper(3) }
        }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Two levels of nesting — the walk continues outward past the first
    // enclosing type that does not declare the name.
    @Theory
    @MemberData("Resolvers")
    func DoublyNested_BareCall_OutermostStatic_Resolves(withReferences bool) {
        let source = `
package p
class Outer {
    class Middle {
        class Inner {
            func Caller() int32 { return Helper(3) }
        }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // A nearer enclosing type shadows a farther one (innermost-first walk).
    @Theory
    @MemberData("Resolvers")
    func DoublyNested_NearerEnclosingType_Shadows_Farther(withReferences bool) {
        let source = `
package p
class Outer {
    class Middle {
        class Inner {
            func Caller() int32 { return Helper() }
        }
        shared {
            private func Helper() int32 { return 2 }
        }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // A struct nested in a class sees the class's statics.
    @Theory
    @MemberData("Resolvers")
    func NestedStruct_BareCall_OuterStatic_Resolves(withReferences bool) {
        let source = `
package p
class Outer {
    struct Inner {
        func Caller() int32 { return Helper() }
    }
    shared {
        private func Helper() int32 { return 7 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — the nested type's own member still wins over the enclosing
    // type's same-named static.
    @Theory
    @MemberData("Resolvers")
    func NestedOwnMember_StillWins_OverEnclosingStatic(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 2 }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — the qualified `Outer.Helper(...)` form still resolves.
    @Theory
    @MemberData("Resolvers")
    func QualifiedEnclosingStaticCall_FromNestedType_StillResolves(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Outer.Helper(3) }
    }
    shared {
        func Helper(value int32) int32 { return value + 1 }
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — a genuinely undefined bare call from a nested type still reports
    // GS0130 (the walk must not swallow real "not found" diagnostics).
    @Theory
    @MemberData("Resolvers")
    func NestedBareCall_UndefinedName_StillReportsGs0130(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Nope() }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
`
        let diagnostics = Bind(source, withReferences)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("'Nope' doesn't exist"))
    }

    // Control — an INSTANCE member of the enclosing type is NOT in scope from a
    // nested type (there is no outer `this`); the call must still fail.
    @Theory
    @MemberData("Resolvers")
    func NestedBareCall_EnclosingInstanceMember_IsNotInScope(withReferences bool) {
        let source = `
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper() }
    }
    private func Helper() int32 { return 1 }
}
`
        let diagnostics = Bind(source, withReferences)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("'Helper' doesn't exist"))
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
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
