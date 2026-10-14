// <copyright file="Issue3666GenericMemberArrayErasureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3666: a deferred arrow lambda whose target return type is closed by
/// the receiver's symbolic type arguments but still mentions an enclosing type
/// parameter — the shape of migrated
/// `ClrTypeUtilities.SafeEnumerate[TMember]`, whose body is
/// `MemberCache[TMember].Cache.GetOrAdd(key, k -> … usable.ToArray())` —
/// bound against the receiver's ERASED CLR target
/// (`Func[…, object[]]`), so the body's genuine `[]TMember` result
/// failed to convert with `GS0155`.
///
/// The symbolic recovery in
/// `TryMapDeferredLambdaTargetsSymbolic` had produced the correct
/// `[]TMember` return, but declined the candidate for want of symbolic
/// information: a return type that still mentions a type parameter cannot be
/// recorded as an exact target return, and no other slot on this call is
/// symbolic. The success gate now counts such a return, so the symbolic path
/// wins over the CLR probe and the lambda infers its own `[]TMember`
/// return.
open class Issue3666GenericMemberArrayErasureTests {
    @Fact
    func DeferredLambdaReturningSliceOfMethodTypeParameter_ThroughNestedGenericStaticField_Binds() {
        // The migrated src/Core shape, reduced: a constrained generic function
        // whose cache factory lambda returns []TMember, reached through a
        // nested generic type's static ConcurrentDictionary field.
        let source = `
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Reflection

class MemberCache[TMember MemberInfo] {
    shared {
        var Cache ConcurrentDictionary[(Type, BindingFlags), []TMember] = ConcurrentDictionary[(Type, BindingFlags), []TMember]()
    }
}

func SafeEnumerate[TMember MemberInfo](t Type, flags BindingFlags, getAll (Type) -> []TMember) []TMember {
    return MemberCache[TMember].Cache.GetOrAdd((t, flags), (key (Type, BindingFlags)) -> {
        let all = getAll(key.Item1)
        let usable = List[TMember](all.Length)
        for m in all {
            usable.Add(m)
        }
        return usable.ToArray()
    })
}

func run() int32 {
    let flags = BindingFlags.Public | BindingFlags.Instance
    let first = SafeEnumerate[MethodInfo](typeof(String), flags, (tt Type) -> tt.GetMethods())
    let cached = SafeEnumerate[MethodInfo](typeof(String), flags, (tt Type) -> tt.GetMethods())
    if first.Length == 0 {
        return -1
    }

    // The second call must come back from the cache with the same array.
    if !Object.ReferenceEquals(first, cached) {
        return -2
    }

    return 1
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func DeferredLambdaReturningSliceOfTypeParameter_ThroughGenericClassField_Binds() {
        // The same erasure domain reached through a generic *class* type
        // parameter rather than a generic function's, with a same-compilation
        // element type so the element identity really has to survive.
        let source = `
import System.Collections.Concurrent
import System.Collections.Generic

class Item {
    var Id int32
}

class Store[T] {
    var Cache ConcurrentDictionary[int32, []T] = ConcurrentDictionary[int32, []T]()

    func GetOrBuild(key int32, seed T) []T {
        return Cache.GetOrAdd(key, (k int32) -> {
            let acc = List[T]()
            acc.Add(seed)
            return acc.ToArray()
        })
    }
}

func run() int32 {
    let store = Store[Item]()
    let it = Item()
    it.Id = 7
    let built = store.GetOrBuild(1, it)
    return built[0].Id
}

run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }
}
