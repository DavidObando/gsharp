// file: MapForIn.gs
// Issue #3318: range-`for` iteration over map[K,V]. The two-variable form
// `for k, v in m` destructures each entry into its key and value — the map
// analog of the slice/array index+value form. The single-variable form
// `for kv in m` yields the whole KeyValuePair[K,V] element (C#/Kotlin entry
// semantics), with `.Key` / `.Value` access. Iteration order is unspecified,
// so this sample prints only order-independent aggregates.

package GSharp.Example.MapForIn

import System

var inventory = map [string, int32]{"apples": 3, "bananas": 5, "cherries": 12}

// Two-variable form: name binds as string, count as int32.
var totalItems = 0
var totalNameLength = 0
for name, count in inventory {
    totalItems = totalItems + count
    totalNameLength = totalNameLength + name.Length
}
Console.WriteLine(totalItems)
Console.WriteLine(totalNameLength)

// Single-variable form: each element is a KeyValuePair[string, int32].
var weighted = 0
for entry in inventory {
    weighted = weighted + entry.Key.Length * entry.Value
}
Console.WriteLine(weighted)

// break and continue work as in every loop; maps also iterate inside
// generic functions when K or V is an in-scope type parameter.
func CountLargeStocks[K any](m map [K, int32], threshold int32) int32 {
    var n = 0
    for k, v in m {
        if v < threshold {
            continue
        }
        n = n + 1
    }
    return n
}

Console.WriteLine(CountLargeStocks[string](inventory, 5))
