// <copyright file="Issue1391DefaultArgImportedGenericTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1391: passing the untyped `default` literal
/// as an argument to an IMPORTED (CLR) generic method invoked with an explicit
/// type argument — e.g. `Task.FromResult[int32](default)` — must bind. The
/// bare `default` is bound with the (cref:TypeSymbol.Error) sentinel
/// type until a target is known, and the imported overload-resolution path
/// previously discarded the candidate (no effective CLR type for the argument),
/// reporting GS0159 "Cannot find function". The user-defined generic method path
/// already accepted `default`, so the defect was specific to applicability
/// of imported generic methods against an untyped `default` argument.
open class Issue1391DefaultArgImportedGenericTests {
    @Fact
    func TaskFromResult_With_PrimitiveTypeArg_And_DefaultArg_Binds() {
        let source = `package p
import System.Threading.Tasks

class C { func A() Task[int32] -> Task.FromResult[int32](default) }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func TaskFromResult_With_TypeParameterTypeArg_And_DefaultArg_Binds() {
        // The real-world shape: an in-scope generic type parameter as the
        // explicit type argument, with a bare `default` argument.
        let source = `package p
import System.Threading.Tasks

class Box[T] { func Make() Task[T?] -> Task.FromResult[T](default) }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func TaskFromResult_With_ReferenceTypeArg_And_DefaultArg_Binds() {
        let source = `package p
import System.Threading.Tasks

class C { func A() Task[string] -> Task.FromResult[string](default) }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func TaskFromResult_With_PrimitiveTypeArg_And_ConcreteArg_StillBinds() {
        // Regression guard: a concrete value argument must continue to bind.
        let source = `package p
import System.Threading.Tasks

class C { func A() Task[int32] -> Task.FromResult[int32](0) }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func UserGenericMethod_With_DefaultArg_StillBinds() {
        // Control: the user-defined generic method path that already accepted
        // `default` must remain unaffected.
        let source = `package p

class Box { shared { func Wrap[T](v T) T -> v } }
class C { func A() int32 -> Box.Wrap[int32](default) }`
        Assert.Empty(Bind(source))
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Array).Assembly.Location,
                typeof(Task).Assembly.Location,
                typeof(Console).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
