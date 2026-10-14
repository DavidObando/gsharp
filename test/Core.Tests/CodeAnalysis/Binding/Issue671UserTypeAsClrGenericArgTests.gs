// <copyright file="Issue671UserTypeAsClrGenericArgTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Regression tests for issue #671: user-defined G# class or interface used as a
/// type argument to a CLR generic (`List[MyType]`, `Task[MyType]`,
/// `Dictionary[string, MyType]`) in field-type, method return-type, or
/// method parameter-type position must bind without error.
///
/// Previously the declaration-position generic-construction path rejected types
/// whose (cref:TypeSymbol.ClrType) was `null` (always the case for
/// user-defined types before emit) by surfacing GS0149 "Type 'X' is not generic".
/// The fix projects such types onto `System.Object` for the closed CLR shape
/// (same as type parameters under the type-erased model) while preserving the
/// real symbolic argument via (cref:ImportedTypeSymbol.GetConstructed).
open class Issue671UserTypeAsClrGenericArgTests {
    // ─── Field type position ─────────────────────────────────────────────
    @Fact
    func Field_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Field_ListOfUserInterface_Binds() {
        let source = `package App
import System.Collections.Generic

interface IMyType {
    func GetName() string;
}

class Container {
    var items List[IMyType]
}`
        Assert.Empty(Bind(source))
    }

    // ─── Method return-type position ─────────────────────────────────────
    @Fact
    func MethodReturn_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]

    func getItems() List[MyType] {
        return items
    }
}`
        Assert.Empty(Bind(source))
    }

    // ─── Method parameter-type position ──────────────────────────────────
    @Fact
    func MethodParam_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    func addAll(xs List[MyType]) {
    }
}`
        Assert.Empty(Bind(source))
    }

    // ─── IReadOnlyList / IEnumerable / Task ──────────────────────────────
    @Fact
    func Field_IReadOnlyListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Value int32
}

class Container {
    var items IReadOnlyList[MyType]
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Field_IEnumerableOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Value int32
}

class Container {
    var items IEnumerable[MyType]
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Field_TaskOfUserClass_Binds() {
        let source = `package App
import System.Threading.Tasks

class MyType {
    var Value int32
}

class Container {
    var pending Task[MyType]
}`
        Assert.Empty(Bind(source))
    }

    // ─── Multi-arg generics ──────────────────────────────────────────────
    @Fact
    func Field_DictionaryStringAndUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items Dictionary[string, MyType]
}`
        Assert.Empty(Bind(source))
    }

    // ─── Cross-file (same package) ───────────────────────────────────────
    @Fact
    func CrossFile_ListOfUserClass_Binds() {
        let fileA = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}`
        let fileB = `package App
import System.Collections.Generic

class Container {
    var items List[MyType]
}`
        Assert.Empty(BindMultiFile(fileA, fileB))
    }

    // ─── Regression guards ───────────────────────────────────────────────
    @Fact
    func Regression_Field_ListOfString_StillBinds() {
        let source = `package App
import System.Collections.Generic

class Container {
    var items List[string]
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Regression_Field_DictionaryOfClrTypes_StillBinds() {
        let source = `package App
import System.Collections.Generic

class Container {
    var items Dictionary[string, int32]
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Regression_BodyPosition_ListOfUserClass_StillBinds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]
}

func main() {
    var c = Container()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func MLC_Field_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items List[MyType]
}`
        Assert.Empty(BindWithReferences(source))
    }

    @Fact
    func MLC_Field_DictionaryStringAndUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

class Container {
    var items Dictionary[string, MyType]
}`
        Assert.Empty(BindWithReferences(source))
    }

    // ─── Construction-call position (issue #671 reopen) ──────────────────
    //
    // The original fix made user types legal in *type-clause* position. The
    // call-site path `Type[args](...)` was a separate code path that still
    // rejected the same shape; these tests guard that the construction call
    // also binds and preserves the symbolic type arguments end-to-end.
    @Fact
    func Construct_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

func main() {
    let xs = List[MyType]()
    xs.Add(MyType())
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_ListOfUserInterface_Binds() {
        let source = `package App
import System.Collections.Generic

interface IMyType {
    func GetName() string;
}

func main() {
    let xs = List[IMyType]()
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_ListOfUserEnum_Binds() {
        let source = `package App
import System.Collections.Generic

enum Color {
    Red, Green, Blue
}

func main() {
    let xs = List[Color]()
    xs.Add(Color.Red)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_QualifiedListOfUserClass_Binds() {
        let source = `package App

class MyType {
    var Name string = ""
}

func main() {
    let xs = System.Collections.Generic.List[MyType]()
    xs.Add(MyType())
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_NestedListOfListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

func main() {
    let outer = List[List[MyType]]()
    let inner = List[MyType]()
    outer.Add(inner)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_KeyValuePairWithUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

func main() {
    let kvp = KeyValuePair[string, MyType]("k", MyType())
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Construct_ListOfClrType_StillBinds_Regression() {
        // Pure-CLR regression: a non-user type argument must still bind cleanly.
        let source = `package App
import System.Collections.Generic

func main() {
    let xs = List[int32]()
    xs.Add(1)
    let ys = List[string]()
    ys.Add("a")
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func MLC_Construct_ListOfUserClass_Binds() {
        let source = `package App
import System.Collections.Generic

class MyType {
    var Name string = ""
}

func main() {
    let xs = List[MyType]()
    xs.Add(MyType())
}`
        Assert.Empty(BindWithReferences(source))
    }

    @Fact
    func MLC_Construct_QualifiedListOfUserClass_Binds() {
        let source = `package App

class MyType {
    var Name string = ""
}

func main() {
    let xs = System.Collections.Generic.List[MyType]()
}`
        Assert.Empty(BindWithReferences(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }

        private func BindMultiFile(sources ...string) ImmutableArray[Diagnostic] {
            let result = EmittedOracle.Evaluate(sources)
            return result.Diagnostics
        }

        // ─── MLC (MetadataLoadContext) path ──────────────────────────────────
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(System.Collections.Generic.Dictionary[_, _]).Assembly.Location,
                typeof(System.Threading.Tasks.Task[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func BindWithReferences(source string) ImmutableArray[Diagnostic] {
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
