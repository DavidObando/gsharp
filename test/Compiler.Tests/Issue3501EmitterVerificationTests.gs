// <copyright file="Issue3501EmitterVerificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3501: emitter IL-verification defects surfaced by compiling the
/// migrated src/Core. Each case is the minimal reduction of a real
/// self-migration failure; every emitted assembly must pass ilverify.
open class Issue3501EmitterVerificationTests {
    @Theory
    @MemberData("Cases")
    func EmittedAssembly_PassesIlVerification(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3501_ilv_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        func Cases() sequence[[]object] {
            // Defect 1: `object as IEnumerable[UserType]` iterated inside an
            // iterator — the hoisted nullable local's symbolic container was not
            // unwrapped, so GetEnumerator bound erased (IEnumerator<object>)
            // while the state-machine field reified (IEnumerator<Item>).
            yield[]object{"iterator-as-ienumerable", `
package P
import System.Collections.Generic

class Item {
    var Name string = "x"
}

class Holder {
    func All(source object) sequence[Item] {
        let children IEnumerable[Item]? = source as IEnumerable[Item]
        if children != nil {
            for child in children {
                if child != nil {
                    yield child
                }
            }
        }
    }
}
`}
            // Defect 2: `yield cast[Derived](node)` after a property-pattern
            // narrowing — the hoisted-field rewrite dropped the read's
            // NarrowedType, so the narrowing castclass never fired and the
            // `current` store mismatched.
            yield[]object{"iterator-yield-cast-after-pattern", `
package P
import System.Collections.Generic

open class Node {
}

class Ret : Node {
    var Expression string? = nil
}

class Walker {
    func Returns(nodes List[Node]) sequence[Ret] {
        for node in nodes {
            if node is Ret { Expression: { } expression } {
                yield cast[Ret](node)
                continue
            }
        }
    }
}
`}
            // Defect 3: a reference-to-reference narrowed out-var re-bind
            // (`Type?` read as `Type`) went through the boxed-struct unbox path
            // (`unbox System.Type` — ValueTypeExpected, readonly pointer).
            yield[]object{"narrowed-reference-out-rebind", `
package P
import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis

class Resolver {
    private let index Dictionary[string, Type] = Dictionary[string, Type]()

    private func TryAlias(name string, @NotNullWhen(true) out aliased string?) bool {
        aliased = name + "!"
        return true
    }

    func TryResolve(name string, out type_ Type?) bool {
        type_ = nil
        if index.TryGetValue(name, out var indexed) {
            type_ = indexed
            return true
        }
        if TryAlias(name, out var raw) && index.TryGetValue(raw!!, out indexed) {
            type_ = indexed
            return true
        }
        return false
    }
}
`}
            // Defect 4: an array-typed pattern binding (`GetIndexParameters() is
            // { Length: 1 } indexParams`) tokenised `ParameterInfo[]` as a
            // name-based TypeRef, which fails to load — arrays need a TypeSpec.
            yield[]object{"array-pattern-binding-typespec", `
package P
import System
import System.Linq
import System.Reflection

class Finder {
    func FirstIndexer(type_ Type) PropertyInfo? {
        return type_
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault((p PropertyInfo) -> p.GetIndexParameters() is { Length: 1 } indexParams && indexParams[0].ParameterType == typeof(int32) && p.GetGetMethod(nonPublic: false) != nil)
    }
}
`}
            // Defect 5: `List[(BoundNode) -> object?]()` — a function-typed
            // generic argument carrying a user type was not classified symbolic,
            // so the ctor targeted the erased `List<object>` while the local slot
            // reified `List<Func<BoundNode, object>>`.
            yield[]object{"function-typed-generic-argument", `
package P
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Reflection

class BoundNode {
}

class Accessors {
    var Count int32 = 0

    init(count int32) {
        Count = count
    }
}

class Model {
    private let cache ConcurrentDictionary[Type, Accessors] = ConcurrentDictionary[Type, Accessors]()

    func GetAccessors(boundNodeType Type) Accessors {
        return cache.GetOrAdd(boundNodeType, (type_ Type) -> {
            let getters = List[(BoundNode) -> object?]()
            for property in type_.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                let getterProperty = property
                getters.Add((node BoundNode) -> getterProperty.GetValue(node))
            }
            return Accessors(getters.Count)
        })
    }
}
`}
            // Defect 6: a nullable user constructed generic narrowed then called
            // inside an iterator — the same symbolic-container/narrowing pair as
            // defects 1–2, over a same-compilation generic class.
            yield[]object{"iterator-user-generic-nullable-call", `
package P
import System.Collections.Generic

class Wrap[T] {
    var Items List[T] = List[T]()

    func All() List[T] {
        return Items
    }
}

class Node {
}

class Holder {
    var wraps List[Wrap[Node]?] = List[Wrap[Node]?]()

    func Children() sequence[Node] {
        for wrap in wraps {
            let list Wrap[Node]? = wrap
            if list != nil {
                for node in list.All() {
                    if node != nil {
                        yield node
                    }
                }
            }
        }
    }
}
`}
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
