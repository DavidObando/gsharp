package GSharp.Compiler.Tests

import System.Text
import Xunit

class Issue5909InheritedCollectionInitializerDriverTests {
    @Theory
    @InlineData("")
    @InlineData("()")
    func InheritedAddAndIndexersVerifyAndExecute(suffix string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Collections5909
import System
import System.Collections.Generic
open class Reordered[TValue, TKey] : Dictionary[TKey, TValue] {}
class Rows[TKey, TValue] : Reordered[TValue, TKey] {}
open class Items[TUnused, T] : List[T] {}
class MoreItems[T, TUnused] : Items[TUnused, T] {}
class Tags[T] : HashSet[T] {}
let rows = Rows[string, (string, int32)]` + suffix + `{"key": ("value", 7)}
let indexed = Rows[string, int32]` + suffix + `{["key"] = 1, ["key"] = 9}
let items = MoreItems[int32, string]` + suffix + `{3, 5}
let spread = MoreItems[int32, string](){...[]int32{8}}
let tags = Tags[string]` + suffix + `{"a", "a", "b"}
Console.Write("${rows.Count}:${rows["key"].Item1}:${rows["key"].Item2}:${indexed["key"]}:${items[1]}:${spread[0]}:${tags.Count}")
`, "inherited-collections", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("1:value:7:9:5:8:2"), fixture.RunBytes(dll))
    }
}
