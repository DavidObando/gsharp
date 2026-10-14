// <copyright file="GenericConstructionUnderReferencesTests.cs" company="GSharp">
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

/// Regression tests for issue #310: generic type construction
/// (`List[int32]()`, `Dictionary[string, int32]()`, ...) must resolve
/// when references are supplied explicitly (the SDK `/r:` build path), which
/// loads them into an isolated (cref:System.Reflection.MetadataLoadContext).
///
/// Previously the generic-construction binding path called
/// `openType.MakeGenericType(clrArgs)` with gsc-host CLR type arguments
/// (primitives map to host `typeof(...)`) while `openType` came from
/// the MetadataLoadContext. `MakeGenericType` rejects cross-context
/// arguments, the (cref:ArgumentException) was silently swallowed, and
/// binding fell through to `GS0130: Function 'List' doesn't exist`. The fix
/// projects each argument through
/// (cref:ReferenceResolver.MapClrTypeToReferences(System.Type)) first.
open class GenericConstructionUnderReferencesTests {
    @Fact
    func List_Construction_Resolves_Under_Explicit_References() {
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var list = List[int32]()
    list.Add(1)
    Console.WriteLine(list.Count)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Dictionary_Construction_Resolves_Under_Explicit_References() {
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var counts = Dictionary[string, int32]()
    counts["one"] = 1
    Console.WriteLine(counts.Count)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Nested_Generic_Construction_Resolves_Under_Explicit_References() {
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var nested = List[List[int32]]()
    var inner = List[int32]()
    inner.Add(1)
    nested.Add(inner)
    Console.WriteLine(nested.Count)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Dictionary_With_Generic_Value_Resolves_Under_Explicit_References() {
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var counts = Dictionary[string, List[int32]]()
    Console.WriteLine(counts.Count)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Reference_Type_Argument_Resolves_Under_Explicit_References() {
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var list = List[string]()
    list.Add("hello")
    Console.WriteLine(list.Count)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Generic_Type_Clause_Variable_Resolves_Under_Explicit_References() {
        // Exercises the BindTypeClause generic-construction path (a typed local
        // declaration) in addition to the constructor-call path.
        let source = `package App
import System
import System.Collections.Generic

func main() {
    var list List[int32] = List[int32]()
    list.Add(1)
    Console.WriteLine(list.Count)
}`
        Assert.Empty(Bind(source))
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            // Supplying explicit assembly paths forces ReferenceResolver to load
            // them into an isolated MetadataLoadContext, mirroring the SDK build's
            // explicit /r: reference path.
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(System.Collections.Generic.Dictionary[_, _]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
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
