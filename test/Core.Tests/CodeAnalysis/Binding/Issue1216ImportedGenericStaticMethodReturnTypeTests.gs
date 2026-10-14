// <copyright file="Issue1216ImportedGenericStaticMethodReturnTypeTests.cs" company="GSharp">
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

/// Regression tests for issue #1216: an explicit type argument on a call to an
/// imported (CLR) generic static method whose open return type <em>embeds</em>
/// the method type parameter — `GC.AllocateArray[T](n) → T[]` and
/// `Array.Empty[T]() → T[]` — must surface the SUBSTITUTED return type, not
/// the type-erased `object[]`. Before the fix the array-of-method-parameter
/// projection only recovered an in-scope <em>type parameter</em>, so a
/// same-compilation user type argument (closed with an `object` placeholder
/// in the reference load context) collapsed to `object[]` and failed to
/// convert to `[]Foo` (GS0155).
open class Issue1216ImportedGenericStaticMethodReturnTypeTests {
    @Fact
    func AllocateArray_With_UserStruct_TypeArg_Returns_SliceOfStruct() {
        let source = `package App
import System

struct Foo { var X int32 }

func Make(n int32) []Foo {
    return GC.AllocateArray[Foo](n)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ArrayEmpty_With_UserStruct_TypeArg_Returns_SliceOfStruct() {
        let source = `package App
import System

struct Foo { var X int32 }

func Empty() []Foo {
    return Array.Empty[Foo]()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func TaskFromResult_With_UserStruct_TypeArg_Returns_TaskOfStruct() {
        let source = `package App
import System.Threading.Tasks

struct Foo { var X int32 }

func R(f Foo) Task[Foo] {
    return Task.FromResult[Foo](f)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func AllocateArray_With_PrimitiveTypeArg_Still_Returns_SliceOfPrimitive() {
        // Regression guard: an all-BCL explicit type argument must continue to
        // bind to the substituted slice exactly as before.
        let source = `package App
import System

func Make(n int32) []int32 {
    return GC.AllocateArray[int32](n)
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Array).Assembly.Location,
                typeof(GC).Assembly.Location,
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
