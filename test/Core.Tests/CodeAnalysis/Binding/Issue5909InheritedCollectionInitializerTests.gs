package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

class Issue5909InheritedCollectionInitializerTests {
    @Theory
    @InlineData("")
    @InlineData("()")
    func ReorderedInheritedCollectionSurfacesInitialize(suffix string) {
        let result = EmittedOracle.Evaluate(`import System.Collections.Generic
open class Reordered[TValue, TKey] : Dictionary[TKey, TValue] {}
class Rows[TKey, TValue] : Reordered[TValue, TKey] {}
open class Items[TUnused, T] : List[T] {}
class MoreItems[T, TUnused] : Items[TUnused, T] {}
class Tags[T] : HashSet[T] {}
let rows = Rows[string, (string, int32)]` + suffix + `{"key": ("value", 7)}
let items = MoreItems[int32, string]` + suffix + `{3, 5}
let spread = MoreItems[int32, string](){...[]int32{8}}
let tags = Tags[string]` + suffix + `{"a", "a", "b"}
rows["key"].Item2 * 1000 + items[1] * 100 + spread[0] * 10 + tags.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7582, result.Value)
    }
}
