// <copyright file="Issue2135TypeBuilderInstantiationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Issue #2135: (cref:ClrTypeUtilities.IsAssignableByName(Type, Type))
/// has a "same-context fast path" that calls `target.IsAssignableFrom(source)`
/// whenever the two types share a reflection assembly / kind. During emit the
/// target can be a (cref:System.Reflection.Emit.TypeBuilderInstantiation)
/// — a generic instantiation of a type still being defined by the emit's
/// (cref:TypeBuilder)s (e.g. a same-compilation generic user delegate
/// closed over a concrete type argument). Its `IsAssignableFrom` throws
/// (cref:NotSupportedException), which previously escaped all the way out
/// of `Compilation.Emit` and surfaced as `GS9998` while binding an
/// event subscription (`+=`).
///
/// The method is explicitly designed to fall through to a reference-context-
/// independent by-name walk whenever the fast path cannot answer (that is why
/// (cref:InvalidOperationException) was already swallowed). This test
/// builds a genuine `TypeBuilderInstantiation` in a dynamic assembly and a
/// sibling type in the SAME assembly (so the same-context fast path fires) and
/// asserts the call no longer throws and instead returns the by-name answer.
///
/// RED before the fix: (cref:NotSupportedException) propagates.
/// GREEN after: the exception is caught and the by-name walk decides.
open class Issue2135TypeBuilderInstantiationTests {
    @Fact
    func IsAssignableByName_TypeBuilderInstantiationTarget_DoesNotThrow() {
        let (instantiation, sibling) = BuildTypeBuilderInstantiationAndSibling()
        // The two types live in the same (dynamic) assembly, so the same-
        // context fast path is entered and IsAssignableFrom is invoked on the
        // TypeBuilderInstantiation target — the exact call that threw
        // NotSupportedException before the fix.
        Assert.True(object.ReferenceEquals(instantiation.Assembly, sibling.Assembly))
        Assert.IsAssignableFrom[TypeBuilder](sibling)
        Assert.Equal("TypeBuilderInstantiation", instantiation.GetType().Name)
        let exception = Record.Exception(
            func () object {
                return ClrTypeUtilities.IsAssignableByName(instantiation, sibling)
            }
        )
        Assert.Null(exception)
    }

    @Fact
    func IsAssignableByName_TypeBuilderInstantiationTarget_FallsThroughToByNameWalk() {
        let (instantiation, sibling) = BuildTypeBuilderInstantiationAndSibling()
        // `sibling` does not derive from / implement the constructed generic
        // definition, so the reference-context-independent by-name walk the
        // fast path falls through to correctly answers `false` (rather than
        // crashing).
        Assert.False(ClrTypeUtilities.IsAssignableByName(instantiation, sibling))
    }

    shared {
        private func BuildTypeBuilderInstantiationAndSibling()(Instantiation Type, Sibling Type) {
            let assemblyName = AssemblyName("Issue2135DynamicAssembly")
            let assemblyBuilder = AssemblyBuilder.DefineDynamicAssembly(assemblyName, AssemblyBuilderAccess.Run)
            let moduleBuilder = assemblyBuilder.DefineDynamicModule("Issue2135Module")
            // A generic type still under construction — its `.MakeGenericType(...)`
            // produces a TypeBuilderInstantiation whose IsAssignableFrom throws.
            let genericDefinition = moduleBuilder.DefineType("Bus`1", TypeAttributes.Public | TypeAttributes.Class)
            genericDefinition.DefineGenericParameters("T")
            // A sibling type in the SAME dynamic assembly so the same-context fast
            // path (`ReferenceEquals(target.Assembly, source.Assembly)`) is taken.
            let sibling = moduleBuilder.DefineType("Consumer", TypeAttributes.Public | TypeAttributes.Class)
            let instantiation = genericDefinition.MakeGenericType(typeof(int32))
            return (instantiation, sibling)
        }
    }
}
